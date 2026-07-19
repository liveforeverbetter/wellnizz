-- Reassert the job-progress columns in a new migration so deployments that
-- recorded 0004 without applying every ALTER can self-heal on the next boot.
alter table if exists health_api.genetic_analysis_jobs
  add column if not exists stage text not null default 'queued',
  add column if not exists progress_pct integer not null default 0,
  add column if not exists progress_message text,
  add column if not exists last_progress_at timestamptz,
  add column if not exists reanalysis_recommended boolean not null default false,
  add column if not exists reanalysis_reason text;

alter table if exists health_api.genetic_analysis_jobs
  drop constraint if exists genetic_analysis_jobs_progress_pct_check;

alter table if exists health_api.genetic_analysis_jobs
  add constraint genetic_analysis_jobs_progress_pct_check
  check (progress_pct between 0 and 100);

-- A previous worker could leave an exhausted job as running while preserving
-- its error. That state cannot make progress and must be explicitly retryable
-- through a new analysis rather than appearing active forever.
update health_api.genetic_analysis_jobs
set status = 'failed',
    stage = 'failed',
    progress_pct = least(progress_pct, 99),
    progress_message = 'Analysis attempts are exhausted. The source can be reanalyzed after the reported issue is corrected.',
    last_progress_at = now(),
    reanalysis_recommended = true,
    reanalysis_reason = coalesce(error, 'The previous analysis exhausted its retry attempts.'),
    worker_id = null,
    locked_at = null,
    completed_at = coalesce(completed_at, now()),
    updated_at = now()
where status = 'running'
  and attempts >= max_attempts
  and error is not null;

update health_api.genetic_analysis_jobs
set stage = 'complete',
    progress_pct = 100,
    progress_message = coalesce(progress_message, 'Analysis complete. Interpreted results are ready.'),
    last_progress_at = coalesce(last_progress_at, completed_at, updated_at)
where status = 'complete'
  and (stage <> 'complete' or progress_pct <> 100);
