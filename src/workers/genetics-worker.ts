import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { configuredStore } from '../configured-store.js';
import { resolveGeneticsPipeline, runGeneticsPipelineWithWriter } from '../core/genetics-runner.js';
import { upsertGeneticPipelineInterpretation } from '../core/genetic-analysis.js';
import { retryTransientStoreOperation } from '../core/store-retry.js';
import type { PgsPopulationSimilarity } from '../core/pgs-calibration.js';

const workerId = process.env.HEALTH_ANALYSIS_WORKER_ID
  ?? process.env.GENOMIC_ANALYSIS_WORKER_ID
  ?? `health-analysis-worker-${randomUUID()}`;
const pollMs = Number(process.env.HEALTH_ANALYSIS_WORKER_POLL_MS ?? process.env.GENOMIC_ANALYSIS_WORKER_POLL_MS ?? '10000');
const staleLockMinutes = Number(process.env.HEALTH_ANALYSIS_STALE_LOCK_MINUTES ?? '30');
const once = process.argv.includes('--once');
const store = configuredStore();

let shuttingDown = false;
let activeJobId: string | undefined;
let activeAbortController: AbortController | undefined;

// Fly sends SIGTERM before SIGKILL (kill_timeout in fly.toml gives us the window).
// Kill the current subprocess, requeue the job (decrementing attempts so the forced
// shutdown doesn't count as a failed attempt), then exit so the new machine takes over.
process.on('SIGTERM', () => {
  shuttingDown = true;
  console.log(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, event: 'genetics_worker_sigterm', active_job_id: activeJobId ?? null }));
  const requeue = activeJobId ? store.requeueGeneticAnalysisJob(activeJobId) : Promise.resolve();
  activeAbortController?.abort(new Error('Worker is shutting down.'));
  requeue.finally(() => process.exit(0));
});

async function main(): Promise<void> {
  // On startup, reset any jobs that were left running by a previous worker that died
  // without a clean shutdown (e.g. SIGKILL, OOM). This is a fallback for cases where
  // the SIGTERM handler above did not get a chance to run.
  const staleCount = await store.resetStaleGeneticAnalysisJobs(staleLockMinutes);
  if (staleCount > 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, event: 'genetics_stale_locks_reset', count: staleCount }));
  }

  do {
    if (shuttingDown) break;
    let processed = false;
    try {
      processed = await processNextJob();
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        worker_id: workerId,
        event: 'genetics_worker_poll_error',
        error: errorMessage(error),
      }));
      if (once) throw error;
      await sleep(pollMs);
      continue;
    }
    if (once) break;
    await sleep(processed ? 100 : pollMs);
  } while (true);
}

async function processNextJob(): Promise<boolean> {
  const job = await store.claimNextGeneticAnalysisJob(workerId);
  if (!job) return false;

  activeJobId = job.id;
  activeAbortController = new AbortController();
  const { signal } = activeAbortController;
  let pipelineSucceeded = false;

  try {
    const [source, analysis] = await Promise.all([
      store.getSource(job.source_id),
      store.getAnalysis(job.analysis_id),
    ]);
    if (!source) throw new Error(`Source not found for genetic job: ${job.source_id}`);
    if (!analysis) throw new Error(`Analysis not found for genetic job: ${job.analysis_id}`);

    // Resume from a durable checkpoint if the multi-hour compute already
    // finished on a prior attempt whose persistence failed; otherwise run the
    // pipeline and checkpoint the completed result before the fragile DB writes.
    const { pipeline, resumedFromCheckpoint } = await resolveGeneticsPipeline(
      store,
      job,
      async () => {
        const pgsPopulationSimilarity = await loadPgsPopulationSimilarity(source.id);
        return runGeneticsPipelineWithWriter(
          job.user_id,
          source,
          inputPath => store.writeSourcePayloadToFile(source.id, inputPath),
          process.env,
          {
            annotation_depth: job.annotation_depth,
            onProgress: progress => store.updateGeneticAnalysisJobProgress(job.id, progress),
            saveFullArtifact: body => store.saveAnalysisArtifact(job.analysis_id, body),
            saveSliceArtifact: body => store.saveAnalysisSliceArtifact(job.analysis_id, body),
            restoreAnnotatedVcf: destinationPath => store.getGeneticAnnotationArtifactToFile(source.id, job.annotation_depth, destinationPath),
            saveAnnotatedVcf: filePath => store.saveGeneticAnnotationArtifact(source.id, job.annotation_depth, filePath),
            pgsPopulationSimilarity,
            signal,
          },
        );
      },
      {
        onResume: () => console.log(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, job_id: job.id, event: 'genetics_job_resumed_from_checkpoint' })),
        onCheckpointSaved: () => console.log(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, job_id: job.id, event: 'genetics_checkpoint_saved' })),
        onCheckpointError: error => console.warn(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, job_id: job.id, event: 'genetics_checkpoint_save_failed', error: errorMessage(error) })),
      },
    );
    if (resumedFromCheckpoint) {
      await store.updateGeneticAnalysisJobProgress(job.id, {
        stage: 'persisting_results',
        progress_pct: 96,
        progress_message: 'Reusing the completed analysis from checkpoint and retrying the save.',
      });
    }
    pipelineSucceeded = pipeline.status === 'complete';
    upsertGeneticPipelineInterpretation(analysis, source, pipeline, job.id);
    await storeWriteWithRetry(job.id, 'persisting_progress', () => store.updateGeneticAnalysisJobProgress(job.id, {
      stage: 'persisting_results',
      progress_pct: 97,
      progress_message: 'Saving interpreted results and final job state.',
    }));
    await storeWriteWithRetry(job.id, 'save_analysis', () => store.saveAnalysis(analysis));

    if (pipeline.status === 'failed') {
      await storeWriteWithRetry(job.id, 'fail_job', () => store.failGeneticAnalysisJob(job.id, pipeline.summary));
    } else {
      await storeWriteWithRetry(job.id, 'complete_job', () => store.completeGeneticAnalysisJob(job.id, pipeline));
      // Results are safely persisted; drop the checkpoint so re-analysis of this
      // source recomputes rather than resuming stale compute. Best-effort.
      await store.clearGeneticAnalysisCheckpoint(job.source_id, job.annotation_depth).catch(error => {
        console.warn(JSON.stringify({ ts: new Date().toISOString(), worker_id: workerId, job_id: job.id, event: 'genetics_checkpoint_clear_failed', error: errorMessage(error) }));
      });
    }
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      worker_id: workerId,
      job_id: job.id,
      status: pipeline.status,
      analysis_id: job.analysis_id,
      source_id: job.source_id,
    }));
  } catch (error) {
    // Abort = graceful shutdown; the SIGTERM handler already requeued the job.
    // Don't mark it failed — just log and exit.
    if (signal.aborted) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        worker_id: workerId,
        job_id: job.id,
        event: 'genetics_job_aborted_for_shutdown',
      }));
      return true;
    }
    const message = errorMessage(error);
    if (pipelineSucceeded) {
      // The multi-hour compute finished and is checkpointed. Do NOT mark the job
      // terminally failed: keep it retryable so the next attempt resumes from the
      // checkpoint and retries only the fast DB write. failGeneticAnalysisJob with
      // no override goes terminal only once attempts are exhausted.
      const lastAttempt = job.attempts >= job.max_attempts;
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        worker_id: workerId,
        job_id: job.id,
        event: 'genetics_pipeline_succeeded_but_persistence_failed',
        error: message,
        last_attempt: lastAttempt,
      }));
      try {
        await store.failGeneticAnalysisJob(job.id, `Analysis completed but saving results failed; the completed analysis is checkpointed and will resume on retry. ${message}`);
      } catch (persistenceError) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          worker_id: workerId,
          job_id: job.id,
          event: 'genetics_job_failure_persistence_exhausted',
          error: errorMessage(persistenceError),
          original_error: message,
        }));
      }
      if (lastAttempt) {
        // No further attempts will run; drop the orphaned checkpoint.
        await store.clearGeneticAnalysisCheckpoint(job.source_id, job.annotation_depth).catch(() => {});
      }
    } else {
      try {
        await storeWriteWithRetry(job.id, 'record_failure', () => store.failGeneticAnalysisJob(job.id, message));
      } catch (persistenceError) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          worker_id: workerId,
          job_id: job.id,
          event: 'genetics_job_failure_persistence_exhausted',
          error: errorMessage(persistenceError),
          original_error: message,
        }));
      }
    }
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      worker_id: workerId,
      job_id: job.id,
      status: 'failed',
      error: message,
    }));
  } finally {
    activeJobId = undefined;
    activeAbortController = undefined;
  }
  return true;
}

async function storeWriteWithRetry(jobId: string, operation: string, write: () => Promise<void>): Promise<void> {
  const maxAttempts = positiveInteger(process.env.HEALTH_ANALYSIS_STORE_WRITE_MAX_ATTEMPTS, 60);
  const delayMs = positiveInteger(process.env.HEALTH_ANALYSIS_STORE_WRITE_RETRY_MS, 5_000);
  await retryTransientStoreOperation(write, {
    maxAttempts,
    delayMs,
    onRetry: (error, attempt, retryDelayMs) => {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        worker_id: workerId,
        job_id: jobId,
        event: 'genetics_store_write_retry',
        operation,
        attempt,
        retry_delay_ms: retryDelayMs,
        error: errorMessage(error),
      }));
    },
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadPgsPopulationSimilarity(sourceId: string): Promise<PgsPopulationSimilarity | undefined> {
  const similarityDir = process.env.HEALTH_ANALYSIS_PGS_SIMILARITY_DIR;
  if (!similarityDir) return undefined;
  try {
    const filePath = `${similarityDir}/${sourceId}_population_similarity.json`;
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as PgsPopulationSimilarity;
  } catch {
    return undefined;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
