const state = {
  accessToken: sessionStorage.getItem('fb_access_token') || '',
  user: readJson(sessionStorage.getItem('fb_user')),
  apiKey: '',
  workingKey: '',
  whoopFirstParty: false,
  whoopAvailability: 'loading',
  ouraFirstParty: false,
  ouraAvailability: 'loading',
  whoopConnected: false,
  ouraConnected: false,
  healthConnectConnected: false,
  oauthProvider: null,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthRedirectUri: `${window.location.origin}/dashboard`,
  billing: null,
  pricing: null,
  selectedBillingTier: sessionStorage.getItem('fb_selected_billing_tier') || 'standard',
  agentLoginCode: new URLSearchParams(window.location.search).get('agent-login') || '',
  agentLoginRequest: null,
  agentLoginRequestPromise: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const authShell = $('#auth-shell');
const appShell = $('#app-shell');
const overviewPage = $('#page-overview');
const keysPage = $('#page-keys');
const wearablesPage = $('#page-wearables');
const geneticsPage = $('#page-genetics');
const labsPage = $('#page-labs');
const planPage = $('#page-plan');
const resultOverlay = $('#result');
const messageEl = $('#message');

let transitioning = false;
let wearableStatusTimer;

async function enterDashboardMode() {
  if (transitioning) return;
  transitioning = true;
  syncDashboardSessionUi();
  appShell.classList.remove('hidden');
  await raf();
  authShell.style.opacity = '0';
  authShell.style.transform = 'scale(0.97)';
  appShell.style.opacity = '0';
  await sleep(50);
  authShell.classList.add('hidden');
  document.body.classList.add('dashboard-mode');
  await raf();
  appShell.style.opacity = '1';
  await sleep(300);
  authShell.style.opacity = '';
  authShell.style.transform = '';
  appShell.style.opacity = '';
  transitioning = false;
  route();
  void loadWearableConnectionStatus();
  if (wearableStatusTimer) window.clearInterval(wearableStatusTimer);
  wearableStatusTimer = window.setInterval(() => void loadWearableConnectionStatus(), 60_000);
}

function raf() { return new Promise(r => requestAnimationFrame(r)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function route() {
  if (appShell.classList.contains('hidden')) return;
  const hash = window.location.hash || '#overview';
  const page = hash.replace('#', '');
  [overviewPage, keysPage, wearablesPage, geneticsPage, labsPage, planPage].forEach(p => p?.classList.add('hidden'));

  $$('.nav-item[data-route]').forEach(n => {
    const active = n.dataset.route === page;
    n.classList.toggle('active', active);
    n.toggleAttribute('aria-current', active);
  });

  const target = page === 'overview'
    ? overviewPage
    : page === 'wearables'
      ? wearablesPage
      : page === 'genetics'
        ? geneticsPage
        : page === 'labs'
          ? labsPage
          : page === 'plan'
            ? planPage
            : keysPage;
  target?.classList.remove('hidden');
  target?.scrollTo?.({ top: 0, behavior: 'instant' });
  void loadModalityPage(page);
}

window.addEventListener('hashchange', route);

function setAuthenticated() {
  authShell?.classList.add('hidden');
  appShell?.classList.remove('hidden');
  document.body.classList.add('dashboard-mode');
  syncDashboardSessionUi();
}

function setUnauthenticated() {
  authShell?.classList.remove('hidden');
  authShell.style.opacity = '1';
  authShell.style.transform = '';
  appShell?.classList.add('hidden');
  document.body.classList.remove('dashboard-mode');
  syncAuthSessionUi();
}

// ---- Button Loading ----

function setLoading(btn) {
  if (!btn) return;
  btn.dataset.originalText = btn.textContent;
  btn.textContent = 'Working...';
  btn.disabled = true;
  btn.classList.add('btn-loading');
}

function clearLoading(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('btn-loading');
  if (btn.dataset.originalText) {
    btn.textContent = btn.dataset.originalText;
    delete btn.dataset.originalText;
  }
}

// ---- Auth Shell ----

const authEmailForm = $('#auth-email-form');
const authCodeForm = $('#auth-code-form');
const authKeyForm = $('#auth-key-form');
const authMessageEl = $('#auth-message');
const agentPanel = $('#agent-panel');
const devPanel = $('#dev-panel');
const oauthCodePanel = $('#oauth-code-panel');
const authModeToggle = $('#auth-mode-toggle');
const modeAgentBtn = $('#mode-agent-btn');
const modeDevBtn = $('#mode-dev-btn');
const authCard = document.querySelector('.auth-card');
const copyAgentSetupBtn = $('#copy-agent-setup');
const agentLoginApproval = $('#agent-login-approval');
const approveAgentLoginBtn = $('#approve-agent-login');
const denyAgentLoginBtn = $('#deny-agent-login');
let copyAgentSetupReset;
let agentLoginRedirectTimer;

function setAuthMode(mode) {
  const agent = mode === 'agent';
  agentPanel?.classList.toggle('hidden', !agent);
  devPanel?.classList.toggle('hidden', agent);
  oauthCodePanel?.classList.add('hidden');
  authModeToggle?.classList.remove('hidden');
  modeAgentBtn?.classList.toggle('active', agent);
  modeDevBtn?.classList.toggle('active', !agent);
  modeAgentBtn?.setAttribute('aria-selected', String(agent));
  modeDevBtn?.setAttribute('aria-selected', String(!agent));
  modeAgentBtn?.setAttribute('tabindex', agent ? '0' : '-1');
  modeDevBtn?.setAttribute('tabindex', agent ? '-1' : '0');
  authCard?.setAttribute('data-auth-mode', agent ? 'agent' : 'dashboard');
}

modeAgentBtn?.addEventListener('click', () => setAuthMode('agent'));
modeDevBtn?.addEventListener('click', () => setAuthMode('dev'));
authModeToggle?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const agent = event.key === 'ArrowLeft' || event.key === 'Home';
  setAuthMode(agent ? 'agent' : 'dev');
  (agent ? modeAgentBtn : modeDevBtn)?.focus();
});

function agentSetupPrompt() {
  const base = window.location.origin;
  return [
    'Help me connect, analyze, and interpret my wellness data.',
    `Read ${base}/SKILL.md and follow its onboarding instructions.`,
    'Use cloud mode. Follow the skill\'s authentication and onboarding flow, then create a custom dashboard using one of the designs the user selects.',
  ].join('\n');
}

function agentSetupPromptDisplay() {
  return 'Help me connect, analyze, and interpret my wellness data.';
}

copyAgentSetupBtn?.addEventListener('click', async () => {
  try {
    await copyText(agentSetupPrompt());
    clearTimeout(copyAgentSetupReset);
    copyAgentSetupBtn.textContent = 'Prompt copied';
    copyAgentSetupBtn.classList.add('copy-confirmed');
    copyAgentSetupBtn.setAttribute('aria-label', 'Prompt copied. Paste it into your agent.');
    copyAgentSetupReset = setTimeout(() => {
      copyAgentSetupBtn.textContent = 'Copy prompt for your agent';
      copyAgentSetupBtn.classList.remove('copy-confirmed');
      copyAgentSetupBtn.removeAttribute('aria-label');
    }, 2600);
  } catch (error) {
    showAuthMessage(error.message || 'Could not copy the prompt. Select it and copy it manually.', true);
  }
});

const agentSetupPromptEl = $('#agent-setup-prompt');
agentSetupPromptEl?.addEventListener('click', () => copyAgentSetupBtn?.click());
agentSetupPromptEl?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  copyAgentSetupBtn?.click();
});

$('#copy-oauth-code')?.addEventListener('click', async () => {
  const code = $('#oauth-code-display')?.textContent || '';
  await navigator.clipboard.writeText(code);
  showAuthMessage('Code copied. Paste it back to your agent.', false);
});

authEmailForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const email = new FormData(authEmailForm).get('email')?.toString().trim();
  if (!email) return;
  setLoading(button);
  try {
    await api('/auth/otp/start', { email }, null, false);
    authCodeForm?.classList.remove('hidden');
    showAuthMessage('Email sent. Enter the 8-digit sign-in code below.', false);
  } catch (error) {
    showAuthMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
});

authCodeForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const email = $('#auth-email')?.value.trim();
  const code = $('#auth-code')?.value.trim();
  if (!email) { showAuthMessage('Enter your email above first.', true); return; }
  if (!code) return;
  setLoading(button);
  try {
    const session = await api('/auth/otp/verify', { email, token: code }, null, false);
    adoptSession(session.access_token, session.user);
    if (state.agentLoginCode) {
      authCodeForm?.classList.add('hidden');
      authEmailForm?.classList.add('hidden');
      await showAgentLoginApproval();
      return;
    }
    window.location.hash = '#overview';
    await enterDashboardMode();
  } catch (error) {
    showAuthMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
});

function adoptSession(accessToken, user) {
  state.accessToken = accessToken;
  state.user = { id: user.id, email: user.email };
  sessionStorage.setItem('fb_access_token', state.accessToken);
  sessionStorage.setItem('fb_user', JSON.stringify(state.user));
  syncAuthSessionUi();
}

authKeyForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  setLoading(button);
  try {
    const organizationId = $('#auth-workspace')?.value.trim();
    const keyName = $('#auth-key-name')?.value.trim() || 'personal agent key';
    const issued = await api('/api-keys', {
      name: keyName, organization_id: organizationId,
      tier: 'free', intended_use: 'personal_agent', expires_in_days: 365,
    }, state.accessToken);
    state.apiKey = issued.api_key;
    renderKey(issued);
    showAuthMessage('Key created.', false);
    await enterDashboardMode();
  } catch (error) {
    showAuthMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
});

function syncAuthSessionUi() {
  if (!state.user || !state.accessToken) {
    if (authKeyForm) authKeyForm.classList.add('hidden');
    return;
  }
  setAuthMode('dev');
  const workspace = personalOrganizationId(state.user.id);
  if ($('#auth-workspace')) $('#auth-workspace').value = workspace;
  if (authKeyForm) authKeyForm.classList.remove('hidden');
  authEmailForm?.classList.add('hidden');
  authCodeForm?.classList.add('hidden');
}

function showAuthMessage(text, error = false) {
  if (authMessageEl) {
    authMessageEl.textContent = text;
    authMessageEl.className = 'message' + (error ? ' error' : ' success');
  }
}

// ---- Dashboard Shell ----

const appKeyForm = $('#app-key-form');
const sessionStatus = $('#session-status');
const workspaceChip = $('#workspace-chip');
const apiKeyOutput = $('#api-key');
const quickstartOutput = $('#quickstart');
const createdOrg = $('#created-org');
const createdUser = $('#created-user');

appKeyForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  setLoading(button);
  try {
    const organizationId = $('#app-workspace')?.value.trim();
    const keyName = $('#app-key-name')?.value.trim() || 'personal agent key';
    const issued = await api('/api-keys', {
      name: keyName, organization_id: organizationId,
      tier: 'free', intended_use: 'personal_agent', expires_in_days: 365,
    }, state.accessToken);
    state.apiKey = issued.api_key;
    renderKey(issued);
    showMessage('Key created.', false);
  } catch (error) {
    showMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
});

function syncDashboardSessionUi() {
  if (!state.user || !state.accessToken) return;
  const workspace = personalOrganizationId(state.user.id);
  if ($('#app-workspace')) $('#app-workspace').value = workspace;
  if (sessionStatus) { sessionStatus.textContent = state.user.email || state.user.id; sessionStatus.classList.remove('muted'); }
  if (workspaceChip) { workspaceChip.textContent = workspace; workspaceChip.classList.remove('hidden'); }
  renderOverviewGreeting();
  refreshOverview();
  void loadBilling();
}

async function loadBilling() {
  const container = $('#pricing-cards');
  const status = $('#billing-status');
  if (!container || !state.accessToken) return;
  try {
    const [pricing, billing] = await Promise.all([
      fetch('/pricing').then(response => response.json()),
      apiGet(`/billing/subscription?organization_id=${encodeURIComponent(personalOrganizationId(state.user?.id))}`),
    ]);
    state.pricing = pricing;
    state.billing = billing;
    const hosted = pricing.tiers?.filter((tier) => ['standard', 'builder', 'growth'].includes(tier.id)) || [];
    const subscription = billing.subscription;
    const introductoryUsage = billing.introductory_usage;
    const hasActiveSubscription = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription?.status);
    container.innerHTML = hosted.map((tier) => `<article class="card pricing-card ${state.selectedBillingTier === tier.id ? 'selected-plan' : ''}">
      <div><h2>${escapeHtml(tier.name)}</h2><div class="pricing-price">$${Number(tier.monthly_usd).toFixed(2)}<small>/month</small></div></div>
      <p class="pricing-trial">${hasActiveSubscription ? 'Current hosted access is active.' : introductoryUsage?.payment_required ? '<strong>Continue with this plan</strong> · Payment method required to continue.' : `<strong>${introductoryUsage?.remaining ?? 100} free hosted requests remaining</strong> · No payment method required yet.`}</p>
      <ul>${(tier.included || []).slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      <button type="button" data-billing-tier="${tier.id}" ${billing.hosted_billing_configured ? '' : 'disabled'}>${subscription?.tier === tier.id && hasActiveSubscription ? 'Current plan' : hasActiveSubscription ? 'Manage billing' : introductoryUsage?.payment_required ? `Continue with ${escapeHtml(tier.name)}` : state.selectedBillingTier === tier.id ? 'Selected · start connecting' : `Select ${escapeHtml(tier.name)}`}</button>
    </article>`).join('');
    if (status) status.textContent = subscription
      ? `${subscription.tier[0].toUpperCase()}${subscription.tier.slice(1)} · ${subscription.status}${subscription.status === 'trialing' && subscription.current_period_end ? ` · trial ends ${new Date(subscription.current_period_end).toLocaleDateString()}` : ''}${subscription.cancel_at_period_end ? ' · cancels at period end' : ''}`
      : introductoryUsage?.payment_required
        ? `Your first ${introductoryUsage.limit} hosted requests are complete. Choose a plan to continue.`
        : billing.hosted_billing_configured
          ? `${introductoryUsage?.remaining ?? 100} of ${introductoryUsage?.limit ?? 100} free hosted requests remain. No payment method is required yet.`
          : 'Hosted billing is being configured.';
    $('#manage-billing')?.classList.toggle('hidden', !hasActiveSubscription);
    container.querySelectorAll('[data-billing-tier]').forEach(button => button.addEventListener('click', () => hasActiveSubscription ? openBillingPortal() : selectHostedPlan(button.dataset.billingTier)));
  } catch (error) {
    if (status) status.textContent = error.message || 'Billing status is temporarily unavailable.';
  }
}

async function selectHostedPlan(tier) {
  if (!['standard', 'builder', 'growth'].includes(tier)) return;
  state.selectedBillingTier = tier;
  sessionStorage.setItem('fb_selected_billing_tier', tier);
  if (introductoryPaymentRequired()) { await beginHostedCheckout(); return; }
  window.location.hash = '#overview';
  void loadBilling();
}

function introductoryPaymentRequired() {
  return !hasActiveHostedSubscription() && state.billing?.introductory_usage?.payment_required === true;
}

async function beginHostedCheckout() {
  if (!state.user?.id || hasActiveHostedSubscription()) return;
  try {
    const session = await api('/billing/checkout', {
      tier: state.selectedBillingTier,
      organization_id: personalOrganizationId(state.user.id),
      activation_source: 'request_limit',
    });
    window.location.assign(session.url);
  } catch (error) {
    const status = $('#billing-status');
    if (status) status.textContent = error.message || String(error);
  }
}

async function openBillingPortal() {
  try {
    const session = await api('/billing/portal', { organization_id: personalOrganizationId(state.user?.id) });
    window.location.assign(session.url);
  } catch (error) {
    const status = $('#billing-status');
    if (status) status.textContent = error.message || String(error);
  }
}

$('#manage-billing')?.addEventListener('click', openBillingPortal);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function renderOverviewGreeting() {
  const greeting = $('#overview-greeting');
  if (!greeting) return;
  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const emailName = state.user?.email?.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  greeting.textContent = emailName ? `${salutation}, ${emailName}.` : `${salutation}.`;
}

function setOverviewProvider(provider, connected, automaticUpdates = false) {
  const status = $(`#overview-${provider}-status`);
  const meta = $(`#overview-${provider}-meta`);
  if (!status || !meta) return;
  status.className = `status ${connected ? 'connected' : 'muted'}`;
  status.textContent = connected
    ? automaticUpdates ? 'Connected · auto sync' : 'Connected'
    : 'Not connected';
  meta.textContent = connected
    ? automaticUpdates ? 'Automatic updates are enabled.' : 'Connected - choose when to refresh.'
    : 'Connect when you are ready.';
}

function refreshOverview() {
  const connectedCount = Number(state.whoopConnected) + Number(state.ouraConnected) + Number(state.healthConnectConnected);
  const percent = Math.round((connectedCount / 3) * 100);
  const gauge = $('.readiness-gauge');
  if (gauge) gauge.style.setProperty('--readiness-angle', `${(percent / 100) * 360}deg`);
  if ($('#overview-ready-percent')) $('#overview-ready-percent').textContent = `${percent}%`;
  if ($('#overview-connected-count')) $('#overview-connected-count').innerHTML = `${connectedCount}<span>/3</span>`;
  if ($('#overview-pipeline-count')) $('#overview-pipeline-count').textContent = '0';
  const wearablePipeline = $('#overview-wearable-pipeline');
  setOverviewProvider('whoop', state.whoopConnected);
  setOverviewProvider('oura', state.ouraConnected);
}

function updateHealthConnectStatus(connection) {
  const connected = connection?.status === 'active' && connection?.mobile_sync_enabled === true;
  state.healthConnectConnected = connected;
  const statusText = connected ? 'Background sync active' : 'Not connected';
  const metaText = connected
    ? healthConnectFreshness(connection.last_synced_at)
    : 'Install Wellnizz Connect to start syncing.';
  for (const selector of ['#health-connect-status', '#overview-health-connect-status']) {
    const status = $(selector);
    if (!status) continue;
    status.className = `status ${connected ? 'connected' : 'muted'}`;
    status.textContent = statusText;
  }
  const overviewMeta = $('#overview-health-connect-meta');
  if (overviewMeta) overviewMeta.textContent = metaText;
  refreshOverview();
}

function healthConnectFreshness(lastSyncedAt) {
  const timestamp = Date.parse(lastSyncedAt || '');
  if (!Number.isFinite(timestamp)) return 'Waiting for the first batch.';
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Last received just now.';
  if (minutes < 60) return `Last received ${minutes}m ago.`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last received ${hours}h ago.`;
  return `Last received ${Math.round(hours / 24)}d ago.`;
}

$('#copy-key')?.addEventListener('click', () => copyText(state.apiKey, 'Key copied.'));
$('#copy-agent-handoff')?.addEventListener('click', () => copyText(state.agentHandoff, 'Copied. Paste it into your agent.'));
$('#copy-quickstart')?.addEventListener('click', () => copyText(quickstartOutput.textContent, 'Copied.'));
$('#close-result').addEventListener('click', () => { resultOverlay.hidden = true; });
resultOverlay?.addEventListener('click', (e) => { if (e.target === resultOverlay) resultOverlay.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !resultOverlay.hidden) resultOverlay.hidden = true; });

// ---- Working Key ----

async function workingKey() {
  if (state.apiKey) return state.apiKey;
  if (state.workingKey) return state.workingKey;
  const issued = await api('/api-keys', {
    name: 'dashboard session key', expires_in_days: 1,
  }, state.accessToken);
  state.workingKey = issued.api_key;
  return state.workingKey;
}

async function workingKeySilent() {
  if (state.apiKey || state.workingKey) return state.apiKey || state.workingKey;
  try { return await workingKey(); } catch { return null; }
}

// ---- Capabilities & Connection Status ----

async function loadCapabilities() {
  try {
    const response = await fetch('/capabilities');
    if (!response.ok) throw new Error(`Capabilities unavailable (${response.status})`);
    const payload = await response.json();
    const whoop = payload.capabilities?.find((item) => item.id === 'wearables.whoop');
    const oura = payload.capabilities?.find((item) => item.id === 'wearables.oura');
    state.whoopFirstParty = Boolean(whoop?.first_party_oauth);
    state.whoopAvailability = state.whoopFirstParty ? 'first_party' : 'byo';
    state.ouraFirstParty = Boolean(oura?.first_party_oauth);
    state.ouraAvailability = state.ouraFirstParty ? 'first_party' : 'byo';
  } catch {
    state.whoopFirstParty = false;
    state.whoopAvailability = 'unavailable';
    state.ouraFirstParty = false;
    state.ouraAvailability = 'unavailable';
  }
}

async function loadWearableConnectionStatus() {
  if (!state.user?.id) return;
  try {
    const key = await workingKeySilent();
    if (!key) return;
    const params = new URLSearchParams({
      user_id: state.user.id,
      organization_id: personalOrganizationId(state.user.id),
    });
    const result = await apiGet(`/connections/wearables/status?${params}`, key);
    for (const provider of ['whoop', 'oura']) {
      const connection = result.connections?.find((item) => item.source_provider === provider);
      const connected = connection?.status === 'active';
      const autoSync = connection?.webhook_sync_enabled === true || connection?.server_sync_enabled === true;
      if (provider === 'whoop') state.whoopConnected = connected;
      if (provider === 'oura') state.ouraConnected = connected;
    }
    const healthConnect = result.connections?.find((item) => item.source_provider === 'health_connect');
    updateHealthConnectStatus(healthConnect);
  } catch { /* Status read is best-effort */ }
}

function hasActiveHostedSubscription() {
  return ['active', 'trialing', 'past_due', 'unpaid'].includes(state.billing?.subscription?.status);
}

// ---- Wearable Connection (inline on Wearables page) ----

async function startFirstPartyConnect(provider) {
  try {
    const key = await workingKey();
    const result = await api('/connections/wearables/start', {
      user_id: state.user?.id,
      organization_id: personalOrganizationId(state.user?.id),
      source_provider: provider,
    }, key);
    if (!result.authorization_url) {
      showMessage('Failed to get an authorization URL.', true);
      return;
    }
    const oauthState = new URL(result.authorization_url).searchParams.get('state');
    if (!oauthState || oauthState.length < 8) {
      showMessage(`${providerLabel(provider)} authorization did not return a secure state. Start the connection again.`, true);
      return;
    }
    sessionStorage.setItem('fb_pending_oauth', JSON.stringify({ provider, mode: 'first_party', state: oauthState }));
    window.location.assign(result.authorization_url);
  } catch (error) {
    showMessage(error.message || String(error), true);
  }
}

// ---- File Uploads (inline on modality pages) ----

async function uploadBiomarkerFile() {
  const file = $('#biomarker-file')?.files?.[0];
  if (!file) { showMessage('Choose a biomarker file first.', true); return; }
  if (file.size > 7 * 1024 * 1024) { showMessage('This biomarker file is too large for dashboard upload. Use a smaller export or upload it through your agent.', true); return; }
  const btn = $('#biomarker-upload-btn');
  setLoading(btn);
  try {
    const key = await workingKey();
    const data = bytesToBase64(await file.arrayBuffer());
    const result = await api('/imports/file', {
      user_id: state.user.id,
      organization_id: personalOrganizationId(state.user.id),
      category: 'biomarkers',
      provider: 'dashboard_upload',
      filename: file.name,
      content_type: file.type || inferredContentType(file.name),
      data_base64: data,
    }, key);
    const readings = result.normalized_observations?.length ?? 0;
    showMessage(`Biomarker panel uploaded${readings ? ` · ${readings} readings recognized` : ''}. Your agent can analyze it now.`, false);
    void loadModalityPage('labs');
  } catch (error) {
    showMessage(error.message || String(error), true);
  } finally {
    clearLoading(btn);
  }
}

async function uploadGeneticsFile() {
  const file = $('#genetics-file')?.files?.[0];
  if (!file) { showMessage('Choose a VCF or SNP-array raw export first.', true); return; }
  if (!/\.(vcf|txt|tsv|csv|snp|raw)(?:\.gz)?$/i.test(file.name)) {
    showMessage('Use a VCF/VCF.GZ or a SNP-array raw export (.txt, .tsv, .csv, .snp, or .raw; optional .gz).', true);
    return;
  }
  const btn = $('#genetics-upload-btn');
  setLoading(btn);
  try {
    const key = await workingKey();
    const session = await api('/genetics/uploads', {
      user_id: state.user.id,
      organization_id: personalOrganizationId(state.user.id),
      filename: file.name,
      byte_length: file.size,
      content_type: file.type || inferredContentType(file.name),
      provider: 'dashboard_upload',
    }, key);
    if (btn) btn.textContent = 'Uploading securely…';
    await uploadDirectGeneticsFile(session.upload, file);
    await api(session.finalize.endpoint, session.finalize.body, key);
    showMessage('Genetic file uploaded to private storage. Your agent can now run genetics analysis.', false);
    void loadModalityPage('genetics');
  } catch (error) {
    showMessage(error.message || String(error), true);
  } finally {
    clearLoading(btn);
  }
}

async function uploadDirectGeneticsFile(contract, file) {
  if (contract?.protocol !== 's3-presigned-put' || !contract?.url || !contract?.headers) {
    throw new Error('Private direct upload is unavailable. Try again shortly.');
  }
  const upload = await fetch(contract.url, { method: contract.method || 'PUT', headers: contract.headers, body: file });
  if (!upload.ok) throw new Error(`Private upload failed (${upload.status}). Start again to receive a fresh upload link.`);
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

function inferredContentType(filename) {
  if (/\.pdf$/i.test(filename)) return 'application/pdf';
  if (/\.json$/i.test(filename)) return 'application/json';
  if (/\.csv$/i.test(filename)) return 'text/csv';
  if (/\.vcf\.gz$/i.test(filename)) return 'application/gzip';
  if (/\.vcf$/i.test(filename)) return 'text/vcf';
  return 'text/plain';
}

// ---- Modality Pages (consumer-facing) ----

const MODALITY_META = {
  wearables: { category: 'wearables', label: 'wearable', connectId: 'wearables-connect', interpId: 'wearables-interpretations', promptId: 'wearables-prompt' },
  genetics: { category: 'genetics', label: 'genetics', connectId: 'genetics-connect', interpId: 'genetics-interpretations', promptId: 'genetics-prompt' },
  labs: { category: 'biomarkers', label: 'biomarker', connectId: 'labs-connect', interpId: 'labs-interpretations', promptId: 'labs-prompt' },
};

let modalityTimers = {};

async function loadModalityPage(page) {
  const meta = MODALITY_META[page];
  if (!meta) return;
  if (modalityTimers[page]) window.clearTimeout(modalityTimers[page]);
  const key = await workingKeySilent();
  if (!key || !state.user?.id) return;
  const orgId = personalOrganizationId(state.user.id);
  const params = new URLSearchParams({ user_id: state.user.id, organization_id: orgId, limit: '15' });

  renderModalityPrompt(page);

  if (page === 'wearables') await loadWearablesConnectSection(key, params);
  if (page === 'genetics') await loadGeneticsConnectSection(key, params);
  if (page === 'labs') await loadLabsConnectSection(key, params);

  await loadModalityInterpretations(page, meta.category, key, params);
}

function renderModalityPrompt(page) {
  const container = $(`#${page}-prompt`);
  if (!container) return;
  const prompts = {
    wearables: { prompt: 'Show me my latest recovery, sleep, and activity trends from my wearables. Give me the healthspan dashboard.', btn: 'Copy prompt for your agent' },
    genetics: { prompt: 'Analyze my genetic markers and tell me about any notable findings. Give me the healthspan dashboard.', btn: 'Copy prompt for your agent' },
    labs: { prompt: 'Show me my latest biomarker results and trends. Give me the healthspan dashboard.', btn: 'Copy prompt for your agent' },
  };
  const info = prompts[page];
  container.innerHTML = `
    <div class="card prompt-card">
      <div class="card-head"><h2>Ask your agent</h2></div>
      <p>Paste this into your agent to get personalized insights from your data.</p>
      <pre class="code" tabindex="0">${escapeHtml(info.prompt)}</pre>
      <button type="button" class="wide copy-prompt-btn" data-prompt-text="${escapeHtml(info.prompt)}">${info.btn}</button>
    </div>`;
  container.querySelector('.copy-prompt-btn')?.addEventListener('click', async (e) => {
    const text = e.target.dataset.promptText;
    await copyText(text, 'Copied. Paste it into your agent.');
  });
  container.querySelector('pre.code')?.addEventListener('click', (e) => {
    copyText(e.target.textContent, 'Copied. Paste it into your agent.');
  });
}

async function loadWearablesConnectSection(key, params) {
  const container = $('#wearables-connect');
  if (!container) return;
  try {
    const result = await apiGet(`/connections/wearables/status?${params}`, key);
    const connections = result.connections || [];
    const whoop = connections.find(c => c.source_provider === 'whoop');
    const oura = connections.find(c => c.source_provider === 'oura');
    const hc = connections.find(c => c.source_provider === 'health_connect');

    const whoopConnected = whoop?.status === 'active' && (whoop.webhook_sync_enabled || whoop.server_sync_enabled);
    const ouraConnected = oura?.status === 'active' && (oura.webhook_sync_enabled || oura.server_sync_enabled);
    const hcConnected = hc?.status === 'active' && hc?.mobile_sync_enabled === true;

    const providerCards = [
      {
        id: 'whoop',
        name: 'WHOOP',
        desc: 'Recovery, strain, sleep, HRV, and respiratory rate.',
        connected: whoopConnected,
        status: whoopConnected ? 'Connected' : 'Not connected',
        detail: whoopConnected ? (whoop.webhook_sync_enabled ? 'Automatic updates enabled' : 'Server sync enabled') : 'Connect to begin',
        canConnect: state.whoopFirstParty,
      },
      {
        id: 'oura',
        name: 'Oura',
        desc: 'Sleep, readiness, activity, HRV, resting heart rate, and steps.',
        connected: ouraConnected,
        status: ouraConnected ? 'Connected' : 'Not connected',
        detail: ouraConnected ? (oura.webhook_sync_enabled ? 'Automatic updates enabled' : 'Server sync enabled') : 'Connect to begin',
        canConnect: state.ouraFirstParty,
      },
      {
        id: 'health_connect',
        name: 'Health Connect',
        desc: 'Android health data from Fitbit, Samsung Health, Google Fit, and more.',
        connected: hcConnected,
        status: hcConnected ? 'Syncing' : 'Not connected',
        detail: hcConnected ? healthConnectFreshness(hc?.last_synced_at) : 'Install Wellnizz Connect (internal test)',
        canConnect: true,
      },
    ];

    container.innerHTML = `<div class="section-heading-row"><h2>Connected devices</h2></div>
      <div class="modality-status-grid">${providerCards.map(card => `
        <article class="card source-data-card">
          <div class="source-card-top">
            <span class="source-mark source-mark-${card.id}">${providerInitials(card.id)}</span>
            <span class="status ${card.connected ? 'connected' : 'muted'}">${card.status}</span>
          </div>
          <h3>${escapeHtml(card.name)}</h3>
          <p style="margin:0;font-size:12px;color:var(--ink-muted);">${escapeHtml(card.desc)}</p>
          <div class="source-meta">
            <div><strong>Status</strong><span>${escapeHtml(card.detail)}</span></div>
          </div>
          ${card.id !== 'health_connect' && card.canConnect ? `<button type="button" class="provider-btn modality-connect-btn" data-provider="${card.id}">${card.connected ? 'Reconnect' : `Connect ${card.name}`}</button>` : card.id === 'health_connect' ? `<a href="https://play.google.com/apps/testing/com.foreverbetterhealthconnect.myapp" target="_blank" class="provider-btn">Install Wellnizz Connect</a>` : ''}
        </article>
      `).join('')}</div>`;

    container.querySelectorAll('.modality-connect-btn').forEach(btn => {
      btn.addEventListener('click', () => startFirstPartyConnect(btn.dataset.provider));
    });
  } catch {
    container.innerHTML = '<div class="card modality-placeholder"><p>Could not load wearable connections.</p></div>';
  }
}

async function loadGeneticsConnectSection(key, params) {
  const container = $('#genetics-connect');
  if (!container) return;
  try {
    const result = await apiGet(`/sources?category=genetics&${params}`, key);
    const sources = result.sources || [];
    if (sources.length) {
      container.innerHTML = `
        <div class="section-heading-row"><h2>Your genetic data</h2></div>
        <div class="modality-sources">${sources.map(source => `
          <article class="card source-data-card">
            <div class="source-card-top">
              <span class="source-mark">DNA</span>
              <span class="status ${source.upload_status === 'complete' ? 'connected' : 'muted'}">${source.upload_status === 'complete' ? 'Ready' : 'Uploading'}</span>
            </div>
            <h3>${escapeHtml(source.filename || 'Genetic file')}</h3>
            <div class="source-meta">
              <div><strong>Provider</strong><span>${escapeHtml(source.provider || '—')}</span></div>
              <div><strong>Size</strong><span>${formatFileSize(source.byte_length)}</span></div>
              <div><strong>Received</strong><span>${formatRelDate(source.received_at)}</span></div>
            </div>
          </article>`).join('')}
        </div>`;
    }
  } catch { /* default upload UI is already in HTML */ }
}

async function loadLabsConnectSection(key, params) {
  const container = $('#labs-connect');
  if (!container) return;
  try {
    const result = await apiGet(`/sources?category=biomarkers&${params}`, key);
    const sources = result.sources || [];
    if (sources.length) {
      container.innerHTML = `
        <div class="section-heading-row"><h2>Your lab panels</h2></div>
        <div class="modality-sources">${sources.map(source => `
          <article class="card source-data-card">
            <div class="source-card-top">
              <span class="source-mark">LAB</span>
              <span class="status connected">Ready</span>
            </div>
            <h3>${escapeHtml(source.filename || 'Lab panel')}</h3>
            <div class="source-meta">
              <div><strong>Provider</strong><span>${escapeHtml(source.provider || '—')}</span></div>
              <div><strong>Received</strong><span>${formatRelDate(source.received_at)}</span></div>
            </div>
          </article>`).join('')}
        </div>`;
    }
  } catch { /* default upload UI is already in HTML */ }
}

async function loadModalityInterpretations(page, modality, key, params) {
  const container = $(`#${MODALITY_META[page].interpId}`);
  if (!container) return;
  try {
    const result = await apiGet(`/analyses?modality=${modality}&${params}`, key);
    const analyses = result.analyses || [];
    if (!analyses.length) {
      const labels = { wearables: 'wearable', genetics: 'genetics', labs: 'biomarker' };
      container.innerHTML = `<div class="section-heading-row"><h2>What your data says</h2></div>
        <div class="card modality-placeholder">
          <h2>No ${labels[page]} insights yet.</h2>
          <p>Run an analysis with your agent to see findings and recommendations here.</p>
        </div>`;
      return;
    }

    // Fetch full analyses to get interpretations
    const fullAnalyses = await Promise.all(analyses.slice(0, 5).map(async (a) => {
      try {
        const full = await apiGet(`/analyses/${a.id}`, key);
        return full;
      } catch { return null; }
    }));

    const interpretations = fullAnalyses
      .filter(Boolean)
      .flatMap(a => (a.derived_interpretations || []).map(interp => ({ ...interp, analysis_id: a.id, analysis_created: a.created_at })))
      .sort((a, b) => (b.analysis_created || '').localeCompare(a.analysis_created || ''))
      .slice(0, 12);

    if (!interpretations.length) {
      container.innerHTML = `<div class="section-heading-row"><h2>What your data says</h2></div>
        <div class="card modality-placeholder">
          <h2>Waiting for insights.</h2>
          <p>Your analysis is complete. Run a deeper analysis with your agent to generate interpretations.</p>
        </div>`;
      return;
    }

    container.innerHTML = `<div class="section-heading-row"><h2>What your data says</h2></div>
      <div class="modality-interp-grid">${interpretations.map(interp => {
        const statusClass = interp.score != null ? (interp.score >= 70 ? 'positive' : interp.score >= 40 ? 'neutral' : 'attention') : 'neutral';
        const statusLabel = interp.score != null ? (interp.score >= 70 ? 'Good' : interp.score >= 40 ? 'Moderate' : 'Needs attention') : '';
        return `<article class="card interpretation-card" data-status="${statusClass}">
          <div class="interp-head">
            <span class="interp-category">${escapeHtml(titleCase(interp.category))}</span>
            ${interp.score != null ? `<span class="interp-score ${statusClass}">${interp.score}<small>/100</small></span>` : ''}
          </div>
          <h3>${escapeHtml(interp.title)}</h3>
          ${interp.summary ? `<p>${escapeHtml(interp.summary)}</p>` : ''}
          ${interp.action ? `<div class="interp-action"><strong>What to do</strong><p>${escapeHtml(interp.action)}</p></div>` : ''}
        </article>`;
      }).join('')}</div>`;
  } catch {
    container.innerHTML = `<div class="section-heading-row"><h2>What your data says</h2></div>
      <div class="card modality-placeholder"><p>Could not load insights. Run an analysis with your agent first.</p></div>`;
  }
}

// ---- Result Overlay ----

function renderKey(issued) {
  const orgId = issued.created.organization_id;
  const userId = issued.created.user_id;
  const baseUrl = window.location.origin;
  if (apiKeyOutput) apiKeyOutput.textContent = issued.api_key;
  if (createdOrg) createdOrg.textContent = orgId;
  if (createdUser) createdUser.textContent = userId;
  state.agentHandoff = agentHandoffPrompt(baseUrl, issued.api_key, userId, orgId);
  if (quickstartOutput) quickstartOutput.textContent = fullLoopScript(baseUrl, issued.api_key, userId, orgId);
  if (resultOverlay) resultOverlay.hidden = false;
}

function agentHandoffPrompt(baseUrl, key, userId, orgId) {
  return [
    'You now have access to my Wellnizz API.',
    `Base URL: ${baseUrl}`,
    `API key (keep it secret): ${key}`,
    'Send it on every call as: Authorization: Bearer <key>',
    `My user_id: ${userId}`,
    `My organization_id: ${orgId}`,
    `Endpoints: read ${baseUrl}/.well-known/health-agent.json, or connect over MCP at POST ${baseUrl}/mcp.`,
    'Start by calling GET /capabilities, then help me upload longevity data or connect my WHOOP.',
  ].join('\n');
}

function fullLoopScript(baseUrl, key, userId, orgId) {
  const uploadPayload = JSON.stringify({
    user_id: userId, organization_id: orgId, category: 'biomarkers',
    filename: 'labs.json', content_type: 'application/json',
    text: '{"readings":[{"marker":"ApoB","value":105,"unit":"mg/dL"},{"marker":"HbA1c","value":5.6,"unit":"%"},{"marker":"HDL-C","value":48,"unit":"mg/dL"}]}',
  });
  return [
    `export FB_API="${baseUrl}"`, `export FB_KEY="${key}"`, '',
    '# 1) Upload a biomarker panel and capture the source id (needs jq)',
    `SRC=$(curl -s -X POST "$FB_API/imports/file" -H "authorization: Bearer $FB_KEY" -H "content-type: application/json" -d '${uploadPayload}' | jq -r .source.id)`,
    '',
    '# 2) Analyze biomarkers and capture the analysis id',
    `AN=$(curl -s -X POST "$FB_API/biomarkers/analyze" -H "authorization: Bearer $FB_KEY" -H "content-type: application/json" -d "{\\"user_id\\":\\"${userId}\\",\\"organization_id\\":\\"${orgId}\\",\\"source_ids\\":[\\"$SRC\\"]}" | jq -r .id)`,
    '',
    '# 3) List your previous analyses',
    `curl -s "$FB_API/analyses?user_id=${userId}&organization_id=${orgId}" -H "authorization: Bearer $FB_KEY" | jq .`,
    '',
    '# 4) Get prioritized recommendations for that analysis',
    'curl -s "$FB_API/analyses/$AN/recommendations" -H "authorization: Bearer $FB_KEY" | jq .',
    '',
    '# 5) See trends across every upload',
    `curl -s -X POST "$FB_API/users/${userId}/trends" -H "authorization: Bearer $FB_KEY" -H "content-type: application/json" -d '{"organization_id":"${orgId}"}' | jq .`,
  ].join('\n');
}

// ---- OAuth Redirect Return ----

function oauthReturn() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error_description') || params.get('error');
  if (!code && !error) return null;
  for (const key of ['code', 'state', 'scope', 'error', 'error_description', 'error_hint']) params.delete(key);
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  return { code, state, error };
}

function checkoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');
  if (!checkout) return null;
  params.delete('checkout');
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  return checkout;
}

async function completePendingOauth(returned) {
  const pending = readJson(sessionStorage.getItem('fb_pending_oauth'));
  sessionStorage.removeItem('fb_pending_oauth');
  const agentStartedProvider = providerFromFirstPartyState(returned.state);
  const provider = pending?.provider || agentStartedProvider || 'whoop';
  window.location.hash = '#wearables';
  route();
  if (returned.error) { showMessage(returned.error, true); return; }
  const code = returned.code;
  if (!code) { showMessage(`${providerLabel(provider)} did not return an authorization code. Start the connection again.`, true); return; }
  if ((!pending || pending.mode !== 'first_party') && !agentStartedProvider) return;
  if (pending?.mode === 'first_party' && (!returned.state || returned.state !== pending.state)) {
    showMessage(`${providerLabel(provider)} returned an invalid state. Start the connection again so your account stays protected.`, true);
    return;
  }
  try {
    const key = await workingKey();
    const result = await api('/connections/wearables/callback', {
      user_id: state.user?.id,
      organization_id: personalOrganizationId(state.user?.id),
      source_provider: provider,
      code,
      state: returned.state,
    }, key);
    updateProviderStatus(provider, true);
    showMessage(result.webhook_sync_enabled || result.server_sync_enabled
      ? `${providerLabel(provider)} connected. Automatic updates are enabled.`
      : `${providerLabel(provider)} connected. Sync it from your agent or run an analysis when data arrives.`, false);
    void loadModalityPage('wearables');
  } catch (error) {
    showMessage(error.message || String(error), true);
  }
}

function updateProviderStatus(provider, connected, automaticUpdates = false) {
  if (provider === 'whoop') state.whoopConnected = connected;
  if (provider === 'oura') state.ouraConnected = connected;
  refreshOverview();
}

function providerFromFirstPartyState(value) {
  const match = /^fb1\.(whoop|oura)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(value || '');
  return match?.[1] || null;
}

function showOauthCodePanel(returned) {
  agentPanel?.classList.add('hidden');
  devPanel?.classList.add('hidden');
  authModeToggle?.classList.add('hidden');
  oauthCodePanel?.classList.remove('hidden');
  if (returned.error) {
    showAuthMessage(returned.error, true);
    if ($('#oauth-code-display')) $('#oauth-code-display').textContent = 'Authorization failed. Ask your agent to start a new wearable connection.';
    return;
  }
  if ($('#oauth-code-display')) $('#oauth-code-display').textContent = `code: ${returned.code}\nstate: ${returned.state || 'missing'}`;
}

// ---- Helpers ----

async function api(path, body, bearerToken, useAuth = true) {
  const headers = { 'content-type': 'application/json' };
  const token = bearerToken ?? state.accessToken;
  if (useAuth && token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401 && useAuth) expireDashboardSession();
    throw new Error(payload.detail || payload.error || payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

async function apiGet(path, bearerToken, useAuth = true) {
  const headers = { accept: 'application/json' };
  const token = bearerToken ?? state.accessToken;
  if (useAuth && token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401 && useAuth) expireDashboardSession();
    throw new Error(payload.detail || payload.error || payload.message || `Request failed (${response.status})`);
  }
  return payload;
}

function expireDashboardSession() {
  state.accessToken = '';
  state.user = null;
  state.apiKey = '';
  state.workingKey = '';
  sessionStorage.removeItem('fb_access_token');
  sessionStorage.removeItem('fb_user');
  setUnauthenticated();
  showAuthMessage('Your sign-in session expired. Sign in again to continue.', true);
}

function showMessage(text, error = false) {
  if (!messageEl) { showAuthMessage(text, error); return; }
  messageEl.textContent = text;
  messageEl.className = 'message' + (error ? ' error' : ' success');
}

async function copyText(text, successMessage) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }
  if (successMessage) showMessage(successMessage);
}

function personalOrganizationId(userId) {
  const normalized = String(userId || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
  return `org_personal_${normalized || 'user'}`;
}

function readJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function providerLabel(provider) {
  if (provider === 'whoop') return 'WHOOP';
  if (provider === 'oura') return 'Oura';
  return provider || '';
}

function providerInitials(provider) {
  if (!provider) return '·';
  if (provider === 'whoop') return 'W';
  if (provider === 'oura') return 'O';
  if (provider === 'health_connect') return 'HC';
  return provider.slice(0, 2).toUpperCase();
}

function formatFileSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRelDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 90) return `${days}d ago`;
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function titleCase(value) {
  return (value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---- Agent Login Flow ----

function enterAgentLoginMode() {
  document.querySelector('.auth-card')?.classList.add('agent-login');
  document.querySelector('.auth-card')?.setAttribute('data-auth-mode', 'agent-login');
  authModeToggle?.classList.add('hidden');
  agentPanel?.classList.add('hidden');
  oauthCodePanel?.classList.add('hidden');
  authKeyForm?.classList.add('hidden');
  devPanel?.classList.remove('hidden');
  document.querySelector('.mode-visual-agent')?.classList.add('hidden');
  document.querySelector('.mode-visual-dashboard')?.classList.add('hidden');
  document.querySelector('.mode-visual-agent-login')?.classList.remove('hidden');
  const title = devPanel?.querySelector('.auth-title');
  if (title) title.textContent = 'Sign in to issue an API key for your agent';
  const lede = devPanel?.querySelector('.auth-lede');
  if (lede) lede.textContent = 'Enter your email and we\'ll send a sign-in code. Your agent receives the API key securely once you are authenticated.';
}

async function loadAgentLoginRequest() {
  if (state.agentLoginRequest) return state.agentLoginRequest;
  if (!state.agentLoginRequestPromise) {
    state.agentLoginRequestPromise = apiGet(`/agent-login/request?session_code=${encodeURIComponent(state.agentLoginCode)}`, null, false)
      .then(request => {
        state.agentLoginRequest = request;
        return request;
      })
      .finally(() => { state.agentLoginRequestPromise = null; });
  }
  return state.agentLoginRequestPromise;
}

async function showAgentLoginApproval() {
  const request = await loadAgentLoginRequest();
  enterAgentLoginMode();
  authEmailForm?.classList.add('hidden');
  authCodeForm?.classList.add('hidden');
  agentLoginApproval?.classList.remove('hidden');
  const name = $('#agent-login-name');
  if (name) name.textContent = request.agent_name;
  const permissions = $('#agent-login-permissions');
  if (permissions) {
    permissions.replaceChildren(...request.permissions.map(permission => {
      const item = document.createElement('li');
      item.textContent = permission;
      return item;
    }));
  }
  const lifetime = $('#agent-login-key-lifetime');
  if (lifetime) lifetime.textContent = `The key lasts ${request.api_key_expires_in_days} days and can be revoked from your dashboard.`;
  approveAgentLoginBtn?.focus();
}

async function decideAgentLogin(decision, button) {
  setLoading(button);
  try {
    await api('/agent-login/confirm', {
      session_code: state.agentLoginCode,
      access_token: state.accessToken,
      decision,
    }, null, false);
    agentLoginApproval?.classList.add('hidden');
    if (decision === 'approve') showAgentLoginSuccess();
    else showAgentLoginDenied();
  } catch (error) {
    showAuthMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
}

approveAgentLoginBtn?.addEventListener('click', () => void decideAgentLogin('approve', approveAgentLoginBtn));
denyAgentLoginBtn?.addEventListener('click', () => void decideAgentLogin('deny', denyAgentLoginBtn));

function showAgentLoginSuccess() {
  if (agentLoginRedirectTimer) window.clearTimeout(agentLoginRedirectTimer);
  authCard?.classList.remove('agent-login');
  authCard?.classList.add('agent-login-success-state');
  authCard?.setAttribute('data-auth-mode', 'agent-login-success');
  authModeToggle?.classList.add('hidden');
  agentPanel?.classList.add('hidden');
  devPanel?.classList.add('hidden');
  oauthCodePanel?.classList.add('hidden');
  const success = document.createElement('div');
  success.className = 'agent-login-success';
  success.innerHTML = '<div class="agent-login-check">&#10003;</div><h2 class="auth-title">Your agent is connected</h2><p class="auth-lede">Your API key was delivered securely. Taking you to your dashboard in 5 seconds.</p>';
  document.querySelector('.auth-body')?.replaceChildren(success);
  agentLoginRedirectTimer = window.setTimeout(() => {
    window.location.hash = '#overview';
    void enterDashboardMode();
  }, 5000);
}

function showAgentLoginDenied() {
  if (agentLoginRedirectTimer) window.clearTimeout(agentLoginRedirectTimer);
  authCard?.classList.remove('agent-login');
  authCard?.classList.add('agent-login-success-state');
  authCard?.setAttribute('data-auth-mode', 'agent-login-success');
  authModeToggle?.classList.add('hidden');
  agentPanel?.classList.add('hidden');
  devPanel?.classList.add('hidden');
  oauthCodePanel?.classList.add('hidden');
  const denied = document.createElement('div');
  denied.className = 'agent-login-success';
  denied.innerHTML = '<h2 class="auth-title">Agent access denied</h2><p class="auth-lede">No API key was created. Taking you to your dashboard in 3 seconds.</p>';
  document.querySelector('.auth-body')?.replaceChildren(denied);
  agentLoginRedirectTimer = window.setTimeout(() => {
    window.location.hash = '#overview';
    void enterDashboardMode();
  }, 3000);
}

// ---- Init ----

if (state.agentLoginCode) {
  const cleaned = new URL(window.location.href);
  cleaned.searchParams.delete('agent-login');
  history.replaceState(null, '', cleaned.pathname + cleaned.search);
  enterAgentLoginMode();
  void loadAgentLoginRequest().catch(error => showAuthMessage(error.message || String(error), true));
}

const returnedCheckout = checkoutReturn();
const returnedOauth = oauthReturn() || readJson(sessionStorage.getItem('fb_pending_oauth_return'));

if ($('#agent-setup-prompt')) $('#agent-setup-prompt').textContent = agentSetupPromptDisplay();

const agentTabs = document.querySelectorAll('.agent-tab');
agentTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    agentTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
  });
});

if (state.accessToken && state.user) {
  if (state.agentLoginCode) {
    void (async () => {
      try {
        setUnauthenticated();
        await showAgentLoginApproval();
      } catch (error) {
        showAuthMessage(error.message || String(error), true);
      }
    })();
  } else {
    if (!window.location.hash) window.location.hash = '#overview';
    setAuthenticated();
    route();
    if (returnedCheckout) void resumePendingSourceActivation(returnedCheckout);
  }
} else {
  setUnauthenticated();
}

async function resumePendingSourceActivation(checkout) {
  if (checkout !== 'success') return;
  try {
    state.billing = await apiGet(`/billing/subscription?organization_id=${encodeURIComponent(personalOrganizationId(state.user?.id))}`);
  } catch { /* Stripe may deliver webhook after redirect */ }
  showMessage('Your hosted plan is active. Connect a source whenever you are ready.', false);
}

if (returnedOauth) {
  if (state.accessToken && state.user) {
    sessionStorage.removeItem('fb_pending_oauth_return');
    completePendingOauth(returnedOauth);
  } else if (providerFromFirstPartyState(returnedOauth.state)) {
    sessionStorage.setItem('fb_pending_oauth_return', JSON.stringify(returnedOauth));
    showAuthMessage('Sign in to finish connecting your wearable.', false);
  } else {
    showOauthCodePanel(returnedOauth);
  }
}

loadCapabilities();
if (!state.agentLoginCode) loadWearableConnectionStatus();

// Wire up inline upload buttons
$('#biomarker-upload-btn')?.addEventListener('click', uploadBiomarkerFile);
$('#genetics-upload-btn')?.addEventListener('click', uploadGeneticsFile);
