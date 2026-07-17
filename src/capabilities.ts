export interface Capability {
  id: string;
  modality: 'wearables' | 'genetics' | 'biomarkers' | 'behavioral' | 'health-context';
  status: 'available' | 'queued' | 'requires_setup' | 'partner_gated' | 'planned';
  public_name: string;
  integration_type: 'oauth' | 'upload' | 'queue' | 'computed' | 'mobile_bridge' | 'partner_api' | 'api_summary';
  endpoint_ids: string[];
  supported_inputs: string[];
  normalized_outputs: string[];
  required_scopes: string[];
  notes: string[];
  // For OAuth wearables: true when the server has a first-party app configured,
  // so an end user can connect without supplying developer credentials.
  first_party_oauth?: boolean;
}

export function capabilitiesCatalog(options: { whoopFirstParty?: boolean; ouraFirstParty?: boolean; fullDbsnpConfigured?: boolean } = {}): { service: string; generated_at: string; capabilities: Capability[] } {
  return {
    service: 'foreverbetter-api',
    generated_at: new Date().toISOString(),
    capabilities: [
      {
        id: 'wearables.whoop',
        modality: 'wearables',
        status: 'available',
        public_name: 'WHOOP',
        integration_type: 'oauth',
        endpoint_ids: ['connections.start', 'connections.callback', 'connections.sync', 'connections.jobs.read', 'wearables.analyze'],
        supported_inputs: ['OAuth authorization code', 'provider user id', 'date range'],
        normalized_outputs: ['sleep duration', 'sleep efficiency', 'HRV', 'resting heart rate', 'steps', 'recovery/readiness'],
        required_scopes: ['health:connections:write', 'health:data:read'],
        first_party_oauth: Boolean(options.whoopFirstParty),
        notes: [
          options.whoopFirstParty
            ? 'First-party WHOOP OAuth is configured: start a connection without client_id/secret and the server uses its own WHOOP app.'
            : 'WHOOP server-side OAuth requires the caller to supply client_id/secret (bring your own WHOOP app), unless a first-party app is configured.',
          'Use the scoped wearable analysis endpoint after sync or file import.',
        ],
      },
      {
        id: 'wearables.oura',
        modality: 'wearables',
        status: 'available',
        public_name: 'Oura',
        integration_type: 'oauth',
        endpoint_ids: ['connections.start', 'connections.callback', 'connections.sync', 'connections.jobs.read', 'wearables.analyze'],
        supported_inputs: ['OAuth authorization code', 'date range'],
        normalized_outputs: ['sleep duration', 'sleep efficiency', 'HRV', 'resting heart rate', 'steps', 'readiness'],
        required_scopes: ['health:connections:write', 'health:data:read'],
        first_party_oauth: Boolean(options.ouraFirstParty),
        notes: [
          options.ouraFirstParty
            ? 'First-party Oura OAuth is configured: start a connection without client_id/secret and the server uses its own Oura app.'
            : 'Oura server-side OAuth requires the caller to supply client_id/secret (bring your own Oura app), unless a first-party app is configured.',
          'Uses Oura API V2 daily summaries for sleep, activity, readiness, and heart-rate-derived signals.',
        ],
      },
      {
        id: 'wearables.health_connect',
        modality: 'wearables',
        status: 'available',
        public_name: 'Google Health Connect',
        integration_type: 'mobile_bridge',
        endpoint_ids: ['connections.start', 'connections.callback', 'connections.sync', 'connections.jobs.read', 'wearables.analyze'],
        supported_inputs: ['Android mobile-bridge push', 'Health Connect record types', 'normalized wearable readings', 'date range'],
        normalized_outputs: ['steps', 'sleep', 'HRV', 'resting heart rate', 'SpO2', 'active energy', 'respiratory rate', 'VO2max', 'weight', 'body fat', 'blood pressure', 'blood glucose'],
        required_scopes: ['health:connections:write', 'health:data:read'],
        notes: [
          'Google Health Connect is an on-device Android aggregator that can surface Fitbit, Samsung Health, Google Fit, and other Android sources in one place.',
          'Connect via a mobile bridge: POST /connections/wearables/start returns the bridge setup contract (there is no server OAuth redirect). The ForeverBetter mobile SDK syncs directly to the API; custom bridges can use /imports/file with provider health_connect.',
        ],
      },
      {
        id: 'biomarkers.upload',
        modality: 'biomarkers',
        status: 'available',
        public_name: 'Biomarker and lab upload',
        integration_type: 'upload',
        endpoint_ids: ['imports.file', 'biomarkers.derive', 'biomarkers.analyze', 'analyses.create', 'health_context.read'],
        supported_inputs: ['CSV', 'JSON', 'plain text lab labels'],
        normalized_outputs: ['direct lab interpretations', 'derived biomarker calculations', 'domain context', 'dashboard cards'],
        required_scopes: ['health:data:write', 'health:data:read'],
        notes: ['Current engine supports cardiometabolic, glucose/insulin, inflammation, nutrient, thyroid, organ-function, and hematology context; partner lab APIs can replace locator handoffs later.'],
      },
      {
        id: 'genetics.wgs',
        modality: 'genetics',
        status: 'available',
        public_name: 'WGS/VCF and SNP-array analysis',
        integration_type: 'queue',
        endpoint_ids: ['genetics.uploads.create', 'genetics.uploads.complete', 'imports.file', 'genetics.analyze', 'analyses.create', 'genetics.jobs.read', 'health_context.read'],
        supported_inputs: ['VCF and VCF.GZ up to the configured direct-upload limit', '23andMe-style raw text'],
        normalized_outputs: ['genetic pipeline summary', 'trait count', 'wellness interpretations', 'worker job status', 'reference-mode metadata'],
        required_scopes: ['health:data:write', 'health:data:read'],
        notes: ['Use POST /genetics/uploads to receive a private resumable upload session, upload directly to storage, then POST /genetics/uploads/:id/complete before analysis. The dedicated WGS worker queues the bundled analysis pipeline. Compact annotation can run with smaller references; full dbSNP is the advanced setup path below.'],
      },
      {
        id: 'genetics.full_dbsnp',
        modality: 'genetics',
        status: options.fullDbsnpConfigured ? 'available' : 'requires_setup',
        public_name: 'Full dbSNP WGS annotation',
        integration_type: 'queue',
        endpoint_ids: ['imports.file', 'genetics.analyze', 'analyses.create', 'genetics.jobs.read', 'health_context.read'],
        supported_inputs: ['WGS VCF.GZ with inferred GRCh37 or GRCh38 build', 'persistent reference volume or object-store cache'],
        normalized_outputs: ['rsID-dense annotated VCF', 'dbSNP reference metadata', 'expanded GWAS/trait/variant coverage', 'worker job status'],
        required_scopes: ['health:data:write', 'health:data:read'],
        notes: [
          options.fullDbsnpConfigured
            ? 'Provisioned on this deployment with a persistent GRCh37 dbSNP reference cache. Use annotation_depth=full_dbsnp only after the hosted paid-access check succeeds.'
            : 'Not provisioned on the current hosted Fly deployment: the WGS worker has no persistent reference volume and the hosted object bucket contains no dbSNP reference objects. The current hosted path therefore remains compact annotation only.',
          'When enabled, this uses a shared persistent GRCh37/GRCh38 reference cache (30-40GB per genome build), bcftools/bgzip/tabix, and explicit retention policy for raw and annotated VCFs. The HTTP API must never download or annotate full dbSNP inline.',
          'Hosted access is paid-only: require an active Stripe subscription with a valid payment method and a non-zero full_dbsnp_jobs quota (currently intended for Builder, Growth, or Enterprise). Self-hosted deployments control their own billing and access policy.',
        ],
      },
      {
        id: 'genetics.ancestry',
        modality: 'genetics',
        status: 'available',
        public_name: 'Genetic ancestry analysis',
        integration_type: 'computed',
        endpoint_ids: ['imports.file', 'genetics.ancestry.create'],
        supported_inputs: ['WGS VCF/VCF.GZ', 'SNP-array raw data with autosomal rsIDs'],
        normalized_outputs: ['continental and sub-regional ancestry proportions with confidence', 'maternal/paternal haplogroups', 'per-chromosome breakdown', 'coverage and methodology disclosure'],
        required_scopes: ['health:data:read', 'health:data:write'],
        notes: ['Runs inline against a curated 91-marker ancestry-informative panel (1000 Genomes Phase 3 allele frequencies) using maximum-likelihood population comparison. Returns proportions with confidence when markers match, or a setup note when the upload lacks rsID-annotated autosomal coverage. Full PCA/ADMIXTURE with public reference panels remains a future upgrade for finer-scale resolution.'],
      },
      {
        id: 'genetics.providers',
        modality: 'genetics',
        status: 'available',
        public_name: 'WGS and genetic testing provider catalog',
        integration_type: 'api_summary',
        endpoint_ids: ['wgs_providers.list', 'wgs_providers.read'],
        supported_inputs: ['provider type filter', 'region filter'],
        normalized_outputs: ['provider id', 'name', 'type (wgs/snp_array/exome)', 'regions', 'pricing', 'turnaround', 'data formats', 'raw data access', 'CLIA status'],
        required_scopes: ['health:data:read'],
        notes: ['Covers tellmeGen, Dante Labs, Nebula Genomics, Sequencing.com, 23andMe, AncestryDNA, MyHeritage, CircleDNA, BGI, and more. Filterable by type and region. Use this to help users choose a genetic data provider before uploading VCF or raw data files.'],
      },
      {
        id: 'health_context.summary',
        modality: 'health-context',
        status: 'available',
        public_name: 'Unified health context',
        integration_type: 'api_summary',
        endpoint_ids: ['health_context.read', 'query.create'],
        supported_inputs: ['user id', 'organization id', 'optional analysis ids'],
        normalized_outputs: ['modality coverage', 'modality contexts', 'latest findings', 'data gaps', 'provenance', 'counts'],
        required_scopes: ['health:data:read'],
        notes: ['This gives apps and agents a bounded context object without exposing raw full-history payloads by default.'],
      },
    ],
  };
}
