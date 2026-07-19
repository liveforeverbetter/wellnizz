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
