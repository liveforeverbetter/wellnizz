-- External accounts used to share the generic `wearables` provider key. That
-- made Health Connect and an OAuth wearable with the same external user id
-- overwrite each other. Give existing records their real provider identity,
-- then recover Health Connect connections from their already persisted data.
update health_api.external_accounts
set provider = metadata->>'source_provider'
where provider = 'wearables'
  and metadata->>'source_provider' in ('whoop', 'oura', 'health_connect');

insert into health_api.external_accounts (
  id, user_id, organization_id, provider, external_user_id, status, last_synced_at, metadata
)
select
  'acct_health_connect_' || md5(user_id || ':' || organization_id),
  user_id,
  organization_id,
  'health_connect',
  user_id,
  'active',
  max(coalesce(nullif(provenance->>'received_at', '')::timestamptz, created_at)),
  jsonb_build_object(
    'source_provider', 'health_connect',
    'connection_type', 'mobile_bridge',
    'mobile_sync_enabled', true,
    'historical_backfill', true
  )
from health_api.sources
where category = 'wearables'
  and provider = 'health_connect'
  and deleted_at is null
group by user_id, organization_id
on conflict (user_id, organization_id, provider, external_user_id) do update set
  status = 'active',
  last_synced_at = greatest(
    health_api.external_accounts.last_synced_at,
    excluded.last_synced_at
  ),
  metadata = health_api.external_accounts.metadata || excluded.metadata,
  updated_at = now();
