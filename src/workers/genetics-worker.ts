import { randomUUID } from 'node:crypto';
import { configuredStore } from '../configured-store.js';
import { runGeneticsPipelineWithWriter } from '../core/genetics-runner.js';
import { upsertGeneticPipelineInterpretation } from '../core/genetic-analysis.js';
import { retryTransientStoreOperation } from '../core/store-retry.js';

const workerId = process.env.HEALTH_ANALYSIS_WORKER_ID
  ?? process.env.GENOMIC_ANALYSIS_WORKER_ID
  ?? `health-analysis-worker-${randomUUID()}`;
const pollMs = Number(process.env.HEALTH_ANALYSIS_WORKER_POLL_MS ?? process.env.GENOMIC_ANALYSIS_WORKER_POLL_MS ?? '10000');
const once = process.argv.includes('--once');
const store = configuredStore();

async function main(): Promise<void> {
  do {
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

  try {
    const [source, analysis] = await Promise.all([
      store.getSource(job.source_id),
      store.getAnalysis(job.analysis_id),
    ]);
    if (!source) throw new Error(`Source not found for genetic job: ${job.source_id}`);
    if (!analysis) throw new Error(`Analysis not found for genetic job: ${job.analysis_id}`);

    const pipeline = await runGeneticsPipelineWithWriter(
      job.user_id,
      source,
      inputPath => store.writeSourcePayloadToFile(source.id, inputPath),
      process.env,
      { annotation_depth: job.annotation_depth },
    );
    upsertGeneticPipelineInterpretation(analysis, source, pipeline, job.id);
    await storeWriteWithRetry(job.id, 'save_analysis', () => store.saveAnalysis(analysis));

    if (pipeline.status === 'failed') {
      await storeWriteWithRetry(job.id, 'fail_job', () => store.failGeneticAnalysisJob(job.id, pipeline.summary));
    } else {
      await storeWriteWithRetry(job.id, 'complete_job', () => store.completeGeneticAnalysisJob(job.id, pipeline));
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
    const message = errorMessage(error);
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
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      worker_id: workerId,
      job_id: job.id,
      status: 'failed',
      error: message,
    }));
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

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
