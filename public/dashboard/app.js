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
const connectPage = $('#page-connect');
const wearablesPage = $('#page-wearables');
const geneticsPage = $('#page-genetics');
const labsPage = $('#page-labs');
const planPage = $('#page-plan');
const resultOverlay = $('#result');
const messageEl = $('#message');
const connectMessageEl = $('#connect-message');

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
  [overviewPage, keysPage, connectPage, wearablesPage, geneticsPage, labsPage, planPage].forEach(p => p?.classList.add('hidden'));

  $$('.nav-item[data-route]').forEach(n => {
    const active = n.dataset.route === page;
    n.classList.toggle('active', active);
    n.toggleAttribute('aria-current', active);
  });

  const target = page === 'connect'
    ? connectPage
    : page === 'overview'
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

// The prompt block itself is a copy target so a tap anywhere on it works on
// phones; it delegates to the button, which owns the confirmation state.
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
    await api('/auth/otp/start', {
      email,
    }, null, false);
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

    window.location.hash = '#connect';
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
    updateActivationRail();
  } catch (error) {
    if (status) status.textContent = error.message || 'Billing status is temporarily unavailable.';
  }
}

async function selectHostedPlan(tier) {
  if (!['standard', 'builder', 'growth'].includes(tier)) return;
  state.selectedBillingTier = tier;
  sessionStorage.setItem('fb_selected_billing_tier', tier);
  if (introductoryPaymentRequired()) {
    await beginHostedCheckout();
    return;
  }
  updateActivationRail();
  window.location.hash = '#connect';
  void loadBilling();
}

function updateActivationRail() {
  const copy = $('#activation-plan-copy');
  if (!copy) return;
  const tier = state.pricing?.tiers?.find((item) => item.id === state.selectedBillingTier);
  const label = tier?.name || 'Standard';
  const price = Number(tier?.monthly_usd ?? 9.99).toFixed(2);
  const subscription = state.billing?.subscription;
  const active = ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription?.status);
  const usage = state.billing?.introductory_usage;
  copy.textContent = active
    ? `${subscription.tier[0].toUpperCase()}${subscription.tier.slice(1)} is active. Connect any source to continue.`
    : usage?.payment_required
      ? `Your first ${usage.limit} hosted requests are complete. ${label} is selected; add a payment method to continue.`
      : `${usage?.remaining ?? 100} of ${usage?.limit ?? 100} free hosted requests remain. ${label} is ready whenever you want to continue after the allowance.`;
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
  if (wearablePipeline) {
    wearablePipeline.className = `status ${connectedCount ? 'connected' : 'muted'}`;
    wearablePipeline.textContent = connectedCount ? 'Connected' : 'Waiting';
  }
  setOverviewProvider('whoop', state.whoopConnected);
  setOverviewProvider('oura', state.ouraConnected);
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

function updateHealthConnectStatus(connection) {
  const connected = connection?.status === 'active' && connection?.mobile_sync_enabled === true;
  state.healthConnectConnected = connected;
  const statusText = connected ? 'Background sync active' : 'Not connected';
  const metaText = connected
    ? healthConnectFreshness(connection.last_synced_at)
    : 'Install ForeverBetter Connect to start syncing.';
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

$('#copy-key')?.addEventListener('click', () => copyText(state.apiKey, 'Key copied.'));
$('#copy-agent-handoff')?.addEventListener('click', () => copyText(state.agentHandoff, 'Copied. Paste it into your agent.'));
$('#copy-quickstart')?.addEventListener('click', () => copyText(quickstartOutput.textContent, 'Copied.'));
$('#close-result').addEventListener('click', () => { resultOverlay.hidden = true; });
resultOverlay?.addEventListener('click', (e) => { if (e.target === resultOverlay) resultOverlay.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !resultOverlay.hidden) resultOverlay.hidden = true; });

// ---- Connect Page (OAuth) ----

const whoopBtn = $('#whoop-connect-btn');
const ouraBtn = $('#oura-connect-btn');
const oauthFormArea = $('#oauth-form-area');
const oauthCallbackArea = $('#oauth-callback-area');
const oauthProviderLabel = $('#oauth-provider-label');
const oauthStartBtn = $('#oauth-start-btn');
const oauthCancelBtn = $('#oauth-cancel-btn');
const oauthCallbackBtn = $('#oauth-callback-btn');
const biomarkerConnectBtn = $('#biomarker-connect-btn');
const geneticsConnectBtn = $('#genetics-connect-btn');
const healthConnectBtn = $('#health-connect-btn');
const biomarkerUploadBtn = $('#biomarker-upload-btn');
const geneticsUploadBtn = $('#genetics-upload-btn');

// WHOOP and Oura use server-side OAuth. Google Health Connect connects through
// the separate ForeverBetter Connect mobile app.
const OAUTH_PROVIDER_LABELS = { whoop: 'WHOOP', oura: 'Oura' };
const providerLabel = (provider) => OAUTH_PROVIDER_LABELS[provider] || provider;

// Session tokens carry no endpoint grants, so connection calls need an API
// key. Prefer the key the user just created; otherwise mint a disposable
// 1-day self-serve key (never persisted anywhere).
async function workingKey() {
  if (state.apiKey) return state.apiKey;
  if (state.workingKey) return state.workingKey;
  const issued = await api('/api-keys', {
    name: 'dashboard session key', expires_in_days: 1,
  }, state.accessToken);
  state.workingKey = issued.api_key;
  return state.workingKey;
}

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
  syncProviderCardUi('whoop');
  syncProviderCardUi('oura');
}

function syncProviderCardUi(provider) {
  const availability = provider === 'whoop' ? state.whoopAvailability : state.ouraAvailability;
  const button = provider === 'whoop' ? whoopBtn : ouraBtn;
  const available = availability === 'first_party';
  if (button) {
    button.disabled = !available;
    button.innerHTML = available
      ? `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Connect your ${providerLabel(provider)}`
      : `${providerLabel(provider)} connection temporarily unavailable`;
  }
  $(`#${provider}-byo-link`)?.classList.toggle('hidden', available || availability === 'loading');
  refreshOverview();
}

async function loadWearableConnectionStatus() {
  if (!state.user?.id) return;
  try {
    const key = await workingKey();
    const params = new URLSearchParams({
      user_id: state.user.id,
      organization_id: personalOrganizationId(state.user.id),
    });
    const result = await apiGet(`/connections/wearables/status?${params}`, key);
    for (const provider of ['whoop', 'oura']) {
      const connection = result.connections?.find((item) => item.source_provider === provider);
      updateProviderStatus(provider, connection?.status === 'active', connection?.webhook_sync_enabled === true || connection?.server_sync_enabled === true);
    }
    const healthConnect = result.connections?.find((item) => item.source_provider === 'health_connect');
    updateHealthConnectStatus(healthConnect);
  } catch {
    // Capabilities and OAuth remain usable if the status read is temporarily unavailable.
  }
}

function hasActiveHostedSubscription() {
  return ['active', 'trialing', 'past_due', 'unpaid'].includes(state.billing?.subscription?.status);
}

async function activateSource(action, button) {
  if (!state.user?.id) return;
  if (!state.billing) {
    try {
      state.billing = await apiGet(`/billing/subscription?organization_id=${encodeURIComponent(personalOrganizationId(state.user.id))}`);
    } catch (error) {
      showConnectMessage(error.message || String(error), true);
      return;
    }
  }
  if (introductoryPaymentRequired()) {
    showConnectMessage('Your free hosted request allowance is complete. Choose a plan to add a payment method and continue.', false);
    window.location.hash = '#plan';
    return;
  }
  return continueSourceActivation(action);
}

function continueSourceActivation(action) {
  if (action?.type === 'wearable') return startFirstPartyConnect(action.provider);
  if (action?.type === 'oauth') return openOAuthSetup(action.provider);
  if (action?.type === 'health_connect') {
    showConnectMessage('Opening ForeverBetter Connect. Sign in there with this same account to enable Health Connect sync.', false);
    window.location.assign('https://play.google.com/apps/testing/com.foreverbetterhealthconnect.myapp');
    return;
  }
  if (action?.type === 'biomarkers' || action?.type === 'genetics') {
    showDataUploadPanel(action.type);
  }
}

function showDataUploadPanel(type) {
  const area = $('#data-upload-area');
  const biomarkerPanel = $('#biomarker-upload-panel');
  const geneticsPanel = $('#genetics-upload-panel');
  area?.classList.remove('hidden');
  biomarkerPanel?.classList.toggle('hidden', type !== 'biomarkers');
  geneticsPanel?.classList.toggle('hidden', type !== 'genetics');
  window.location.hash = '#connect';
  (type === 'biomarkers' ? biomarkerPanel : geneticsPanel)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showConnectMessage(type === 'biomarkers'
    ? 'Choose your lab file to upload it to your private workspace.'
    : 'Choose a VCF, SNP-array, or 23andMe/AncestryDNA raw export. It uploads directly to private storage.', false);
}

async function uploadBiomarkerFile() {
  const file = $('#biomarker-file')?.files?.[0];
  if (!file) { showConnectMessage('Choose a biomarker file first.', true); return; }
  if (file.size > 7 * 1024 * 1024) { showConnectMessage('This biomarker file is too large for dashboard upload. Use a smaller export or upload it through your agent.', true); return; }
  setLoading(biomarkerUploadBtn);
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
    showConnectMessage(`Biomarker panel uploaded${readings ? ` · ${readings} readings recognized` : ''}. Your agent can analyze it now.`, false);
  } catch (error) {
    showConnectMessage(error.message || String(error), true);
  } finally {
    clearLoading(biomarkerUploadBtn);
  }
}

async function uploadGeneticsFile() {
  const file = $('#genetics-file')?.files?.[0];
  if (!file) { showConnectMessage('Choose a VCF or SNP-array raw export first.', true); return; }
  if (!/\.(vcf|txt|tsv|csv|snp|raw)(?:\.gz)?$/i.test(file.name)) {
    showConnectMessage('Use a VCF/VCF.GZ or a SNP-array raw export (.txt, .tsv, .csv, .snp, or .raw; optional .gz).', true);
    return;
  }
  setLoading(geneticsUploadBtn);
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
    if (geneticsUploadBtn) geneticsUploadBtn.textContent = 'Uploading securely…';
    await uploadDirectGeneticsFile(session.upload, file);
    await api(session.finalize.endpoint, session.finalize.body, key);
    showConnectMessage('Genetic file uploaded to private storage. Your agent can now run genetics or ancestry analysis.', false);
  } catch (error) {
    showConnectMessage(error.message || String(error), true);
  } finally {
    clearLoading(geneticsUploadBtn);
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

async function startFirstPartyConnect(provider) {
  const button = provider === 'whoop' ? whoopBtn : ouraBtn;
  setLoading(button);
  try {
    const key = await workingKey();
    const result = await api('/connections/wearables/start', {
      user_id: state.user?.id,
      organization_id: personalOrganizationId(state.user?.id),
      source_provider: provider,
    }, key);
    if (!result.authorization_url) {
      showConnectMessage('Failed to get an authorization URL.', true);
      return;
    }
    const oauthState = new URL(result.authorization_url).searchParams.get('state');
    if (!oauthState || oauthState.length < 8) {
      showConnectMessage(`${providerLabel(provider)} authorization did not return a secure state. Start the connection again.`, true);
      return;
    }
    sessionStorage.setItem('fb_pending_oauth', JSON.stringify({ provider, mode: 'first_party', state: oauthState }));
    showConnectMessage(`Taking you to ${providerLabel(provider)} to approve access...`, false);
    window.location.assign(result.authorization_url);
  } catch (error) {
    showConnectMessage(error.message || String(error), true);
  } finally {
    clearLoading(button);
  }
}

function openOAuthSetup(provider) {
  state.oauthProvider = provider;
  if (oauthProviderLabel) oauthProviderLabel.textContent = `Connect ${providerLabel(provider)}`;
  if ($('#oauth-client-id')) $('#oauth-client-id').value = state.oauthClientId || '';
  if ($('#oauth-client-secret')) $('#oauth-client-secret').value = state.oauthClientSecret || '';
  if ($('#oauth-redirect-uri')) $('#oauth-redirect-uri').value = state.oauthRedirectUri;
  oauthFormArea?.classList.remove('hidden');
  oauthCallbackArea?.classList.add('hidden');
  if (connectMessageEl) connectMessageEl.textContent = '';
  oauthFormArea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

whoopBtn?.addEventListener('click', () => {
  if (state.whoopFirstParty) activateSource({ type: 'wearable', provider: 'whoop' }, whoopBtn);
});

ouraBtn?.addEventListener('click', () => {
  if (state.ouraFirstParty) activateSource({ type: 'wearable', provider: 'oura' }, ouraBtn);
});

$('#whoop-byo-link')?.addEventListener('click', () => activateSource({ type: 'oauth', provider: 'whoop' }));
$('#oura-byo-link')?.addEventListener('click', () => activateSource({ type: 'oauth', provider: 'oura' }));
biomarkerConnectBtn?.addEventListener('click', () => activateSource({ type: 'biomarkers' }, biomarkerConnectBtn));
geneticsConnectBtn?.addEventListener('click', () => activateSource({ type: 'genetics' }, geneticsConnectBtn));
healthConnectBtn?.addEventListener('click', () => activateSource({ type: 'health_connect' }, healthConnectBtn));
biomarkerUploadBtn?.addEventListener('click', uploadBiomarkerFile);
geneticsUploadBtn?.addEventListener('click', uploadGeneticsFile);
$('#change-activation-plan')?.addEventListener('click', () => { window.location.hash = '#plan'; });

oauthCancelBtn?.addEventListener('click', () => {
  oauthFormArea?.classList.add('hidden');
  state.oauthProvider = null;
});

oauthStartBtn?.addEventListener('click', async () => {
  const provider = state.oauthProvider;
  const clientId = $('#oauth-client-id')?.value.trim();
  const clientSecret = $('#oauth-client-secret')?.value.trim();
  const redirectUri = $('#oauth-redirect-uri')?.value.trim();

  if (!clientId || !clientSecret) {
    showConnectMessage('Client ID and Secret are required.', true);
    return;
  }

  state.oauthClientId = clientId;
  state.oauthClientSecret = clientSecret;
  state.oauthRedirectUri = redirectUri;

  setLoading(oauthStartBtn);
  try {
    const key = await workingKey();
    const result = await api('/connections/wearables/start', {
      user_id: state.user?.id,
      organization_id: personalOrganizationId(state.user?.id),
      source_provider: provider,
      client_id: clientId,
      redirect_uri: redirectUri,
      scopes: provider === 'oura'
        ? ['daily', 'heartrate', 'personal', 'workout']
        : ['offline', 'read:profile', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout'],
    }, key);

    if (result.authorization_url) {
      showConnectMessage(`Redirecting to ${providerLabel(provider)}...`, false);
      oauthFormArea?.classList.add('hidden');
      oauthCallbackArea?.classList.remove('hidden');
      oauthCallbackArea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.open(result.authorization_url, '_blank');
    } else {
      showConnectMessage('Failed to get authorization URL.', true);
    }
  } catch (error) {
    showConnectMessage(error.message || String(error), true);
  } finally {
    clearLoading(oauthStartBtn);
  }
});

oauthCallbackBtn?.addEventListener('click', async () => {
  const code = $('#oauth-code')?.value.trim();
  const provider = state.oauthProvider;
  if (!code) { showConnectMessage('Paste the authorization code.', true); return; }

  setLoading(oauthCallbackBtn);
  try {
    const key = await workingKey();
    const payload = {
      user_id: state.user?.id,
      organization_id: personalOrganizationId(state.user?.id),
      source_provider: provider,
      code,
    };
    if (state.oauthClientId) {
      payload.client_id = state.oauthClientId;
      payload.client_secret = state.oauthClientSecret;
      payload.redirect_uri = state.oauthRedirectUri;
    }
    await api('/connections/wearables/callback', payload, key);

    updateProviderStatus(provider, true);
    showConnectMessage(`${providerLabel(provider)} connected.`, false);
    oauthCallbackArea?.classList.add('hidden');
    state.oauthProvider = null;
    if ($('#oauth-code')) $('#oauth-code').value = '';
  } catch (error) {
    showConnectMessage(error.message || String(error), true);
  } finally {
    clearLoading(oauthCallbackBtn);
  }
});

function updateProviderStatus(provider, connected, automaticUpdates = false) {
  if (provider === 'whoop') state.whoopConnected = connected;
  if (provider === 'oura') state.ouraConnected = connected;
  const statusEl = $(`#${provider}-status`);
  const btnEl = $(`#${provider}-connect-btn`);
  if (statusEl) {
    statusEl.innerHTML = connected
      ? `<span class="status connected">${automaticUpdates ? 'Connected · Automatic updates enabled' : 'Connected'}</span>`
      : '<span class="status muted">Not connected</span>';
  }
  if (btnEl) btnEl.textContent = connected ? 'Reconnect' : `Connect ${providerLabel(provider)}`;
  setOverviewProvider(provider, connected, automaticUpdates);
  refreshOverview();
}

function showConnectMessage(text, error = false) {
  if (connectMessageEl) {
    connectMessageEl.textContent = text;
    connectMessageEl.className = 'message' + (error ? ' error' : ' success');
  }
}

// ---- Shared ----

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
    'You now have access to my ForeverBetter API.',
    `Base URL: ${baseUrl}`,
    `API key (keep it secret): ${key}`,
    'Send it on every call as: Authorization: Bearer <key>',
    `My user_id: ${userId}`,
    `My organization_id: ${orgId}`,
    `Endpoints: read ${baseUrl}/.well-known/health-agent.json, or connect over MCP at POST ${baseUrl}/mcp.`,
    'Start by calling GET /capabilities, then help me upload longevity data or connect my WHOOP.',
  ].join('\n');
}

// ---- OAuth redirect return (?code=...) ----

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

async function resumePendingSourceActivation(checkout) {
  if (checkout !== 'success') {
    if (checkout === 'cancelled') showConnectMessage('Checkout was cancelled. Your free request allowance is still available.', false);
    return;
  }
  try {
    state.billing = await apiGet(`/billing/subscription?organization_id=${encodeURIComponent(personalOrganizationId(state.user?.id))}`);
  } catch {
    // Stripe can deliver the subscription webhook just after redirect.
  }
  window.location.hash = '#connect';
  showConnectMessage('Your hosted plan is active. Connect a source whenever you are ready.', false);
}

async function completePendingOauth(returned) {
  const pending = readJson(sessionStorage.getItem('fb_pending_oauth'));
  sessionStorage.removeItem('fb_pending_oauth');
  const agentStartedProvider = providerFromFirstPartyState(returned.state);
  const provider = pending?.provider || agentStartedProvider || 'whoop';
    window.location.hash = '#overview';
  route();
  if (returned.error) {
    showConnectMessage(returned.error, true);
    return;
  }
  const code = returned.code;
  if (!code) {
    showConnectMessage(`${providerLabel(provider)} did not return an authorization code. Start the connection again.`, true);
    return;
  }
  if ((!pending || pending.mode !== 'first_party') && !agentStartedProvider) {
    // Bring-your-own flows keep the client secret in the tab that started
    // them, so here we only prefill the paste box.
    state.oauthProvider = state.oauthProvider || provider;
    if ($('#oauth-code')) $('#oauth-code').value = code;
    oauthCallbackArea?.classList.remove('hidden');
    showConnectMessage('Authorization code detected. Complete the connection below.', false);
    return;
  }
  if (pending?.mode === 'first_party' && (!returned.state || returned.state !== pending.state)) {
    showConnectMessage(`${providerLabel(provider)} returned an invalid state. Start the connection again so your account stays protected.`, true);
    return;
  }
  showConnectMessage(`Completing ${providerLabel(provider)} connection...`, false);
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
    showConnectMessage(result.webhook_sync_enabled || result.server_sync_enabled
      ? `${providerLabel(provider)} connected. Automatic updates are enabled.`
      : `${providerLabel(provider)} connected. Sync it from your agent or run an analysis when data arrives.`, false);
  } catch (error) {
    if (agentStartedProvider) {
      showConnectMessage(error.message || String(error), true);
      return;
    }
    state.oauthProvider = provider;
    if ($('#oauth-code')) $('#oauth-code').value = code;
    oauthCallbackArea?.classList.remove('hidden');
    showConnectMessage(`${error.message || String(error)} The code is prefilled below so you can retry.`, true);
  }
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
    if (response.status === 401 && useAuth) {
      expireDashboardSession();
    }
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

function clearMessage() {
  if (messageEl) { messageEl.textContent = ''; messageEl.className = 'message'; }
  if (authMessageEl) { authMessageEl.textContent = ''; authMessageEl.className = 'message'; }
}

async function copyText(text, successMessage) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    // Local HTTP and privacy-hardened browsers can expose the API but deny it.
    // Fall back to a focused textarea so copy still works outside HTTPS.
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    const copied = document.execCommand('copy');
    fallback.remove();
    if (!copied) throw new Error('Could not copy. Select the text and copy it manually.');
  }
  if (successMessage) showMessage(successMessage);
}

function personalOrganizationId(userId) {
  const normalized = String(userId || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
  return `org_personal_${normalized || 'user'}`;
}

function readJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); }
  catch { return null; }
}

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

// ---- Modality Pages ----

const MODALITY_META = {
  wearables: { category: 'wearables', sourcesId: 'wearables-sources', analysesId: 'wearables-analyses' },
  genetics: { category: 'genetics', sourcesId: 'genetics-sources', analysesId: 'genetics-analyses' },
  labs: { category: 'biomarkers', sourcesId: 'labs-sources', analysesId: 'labs-analyses' },
};

let modalityTimers = {};

async function loadModalityPage(page) {
  const meta = MODALITY_META[page];
  if (!meta) return;
  if (modalityTimers[page]) window.clearTimeout(modalityTimers[page]);
  const key = await workingKeySilent();
  if (!key || !state.user?.id) return;
  const orgId = personalOrganizationId(state.user.id);
  const params = new URLSearchParams({ user_id: state.user.id, organization_id: orgId, limit: '20' });
  await Promise.all([
    loadModalitySources(page, meta.category, key, params),
    loadModalityAnalyses(page, meta.category, key, params),
  ]);
  if (page === 'wearables') await loadWearablesModalityConnections(key, params);
  if (page === 'genetics') await loadGeneticsJobs(key, params);
}

async function workingKeySilent() {
  if (state.apiKey || state.workingKey) return state.apiKey || state.workingKey;
  try {
    return await workingKey();
  } catch {
    return null;
  }
}

async function loadModalitySources(page, category, key, params) {
  const container = $(`#${MODALITY_META[page].sourcesId}`);
  if (!container) return;
  try {
    const result = await apiGet(`/sources?category=${category}&${params}`, key);
    const sources = result.sources || [];
    if (!sources.length) {
      const labels = { wearables: 'wearable', genetics: 'genetic', labs: 'lab' };
      const descs = {
        wearables: 'Connect WHOOP, Oura, or Health Connect to begin streaming recovery, sleep, and activity metrics.',
        genetics: 'Upload a VCF, SNP-array, or whole-genome file through your agent or the Connect page.',
        labs: 'Upload a lab panel or biomarker file in CSV, JSON, PDF, or plain-text format through your agent or the Connect page.',
      };
      container.innerHTML = `<div class="card modality-placeholder"><div class="card-head"><h2>No ${labels[page]} data uploaded yet.</h2></div><p>${descs[page]}</p></div>`;
      return;
    }
    container.innerHTML = sources.map(source => `
      <article class="card source-data-card">
        <div class="source-card-top">
          <span class="source-mark">${sourceIcon(category)}</span>
          <div>
            <span class="status ${source.upload_status === 'complete' ? 'connected' : 'muted'}">${source.upload_status === 'pending' ? 'Uploading...' : 'Ready'}</span>
          </div>
        </div>
        <h3>${escapeHtml(source.filename || source.provider || 'Upload')}</h3>
        <div class="source-meta">
          <div><strong>Provider</strong><span>${escapeHtml(source.provider || '—')}</span></div>
          <div><strong>Size</strong><span>${formatFileSize(source.byte_length)}</span></div>
          <div><strong>Received</strong><span>${formatRelDate(source.received_at)}</span></div>
          <div><strong>Source ID</strong><code>${escapeHtml(source.id)}</code></div>
        </div>
      </article>
    `).join('');
  } catch {
    container.innerHTML = '<div class="card modality-placeholder"><p>Could not load sources. Try again shortly.</p></div>';
  }
}

async function loadModalityAnalyses(page, modality, key, params) {
  const container = $(`#${MODALITY_META[page].analysesId}`);
  if (!container) return;
  try {
    const result = await apiGet(`/analyses?modality=${modality}&${params}`, key);
    const analyses = result.analyses || [];
    if (!analyses.length) {
      const labels = { wearables: 'wearable', genetics: 'genetics', labs: 'biomarker' };
      container.innerHTML = `<div class="card modality-placeholder"><p>No ${labels[page]} analyses have been run yet.</p></div>`;
      return;
    }
    container.innerHTML = analyses.map(analysis => `
      <article class="card analysis-data-card">
        <div class="analysis-card-head">
          <span class="source-mark">${sourceIcon(modality)}</span>
          <div><h3>${escapeHtml(analysis.operation || 'Analysis')}</h3></div>
          <span class="status ${analysis.healthspan_score != null ? 'connected' : 'muted'}">${analysis.healthspan_score != null ? `${Math.round(analysis.healthspan_score)}/100` : 'Complete'}</span>
        </div>
        <div class="source-meta">
          <div><strong>Analysis ID</strong><code>${escapeHtml(analysis.id)}</code></div>
          <div><strong>Created</strong><span>${formatRelDate(analysis.created_at)}</span></div>
          <div><strong>Sources</strong><span>${analysis.source_count ?? analysis.source_ids?.length ?? '—'}</span></div>
          <div><strong>Findings</strong><span>${analysis.finding_count ?? '—'}</span></div>
        </div>
      </article>
    `).join('');
  } catch {
    container.innerHTML = '<div class="card modality-placeholder"><p>Could not load analyses. Try again shortly.</p></div>';
  }
}

async function loadWearablesModalityConnections(key, params) {
  const container = $('#wearables-connections');
  if (!container) return;
  try {
    const result = await apiGet(`/connections/wearables/status?${params}`, key);
    const connections = result.connections || [];
    if (!connections.length) {
      container.innerHTML = '<div class="card modality-placeholder"><div class="card-head"><h2>No wearables connected yet.</h2></div><p>Connect WHOOP, Oura, or Health Connect to begin syncing health metrics.</p></div>';
      return;
    }
    container.innerHTML = connections.map(conn => {
      const connected = conn.status === 'active' && (conn.webhook_sync_enabled || conn.server_sync_enabled || conn.mobile_sync_enabled);
      return `
        <article class="card source-data-card">
          <div class="source-card-top">
            <span class="source-mark source-mark-${conn.source_provider}">${providerInitials(conn.source_provider)}</span>
            <span class="status ${connected ? 'connected' : 'muted'}">${connected ? 'Connected' : 'Inactive'}</span>
          </div>
          <h3>${escapeHtml(providerLabel(conn.source_provider))}</h3>
          <div class="source-meta">
            <div><strong>Status</strong><span>${escapeHtml(conn.status || 'unknown')}</span></div>
            <div><strong>Sync</strong><span>${conn.webhook_sync_enabled ? 'Automatic (webhook)' : conn.server_sync_enabled ? 'Automatic (server)' : conn.mobile_sync_enabled ? 'Mobile bridge' : 'Manual'}</span></div>
            <div><strong>Last synced</strong><span>${conn.last_synced_at ? formatRelDate(conn.last_synced_at) : 'Never'}</span></div>
          </div>
        </article>
      `;
    }).join('');
  } catch {
    container.innerHTML = '<div class="card modality-placeholder"><p>Could not load wearable connections. Try again shortly.</p></div>';
  }
}

async function loadGeneticsJobs(key, params) {
  const container = $('#genetics-jobs');
  if (!container) return;
  try {
    const sourcesResult = await apiGet(`/sources?category=genetics&${params}`, key);
    const sources = sourcesResult.sources || [];
    if (!sources.length) {
      container.innerHTML = '<div class="card modality-placeholder"><div class="card-head"><h2>No genetics uploaded.</h2></div><p>Upload a genetic file to start analysis.</p></div>';
      return;
    }
    container.innerHTML = sources.map(source => `
      <article class="card source-data-card">
        <div class="source-card-top">
          <span class="source-mark">DNA</span>
          <span class="status ${source.upload_status === 'complete' ? 'connected' : 'muted'}">${source.upload_status === 'complete' ? 'Ready' : source.upload_status === 'pending' ? 'Uploading' : 'Stored'}</span>
        </div>
        <h3>${escapeHtml(source.filename || 'Genetic file')}</h3>
        <div class="source-meta">
          <div><strong>Provider</strong><span>${escapeHtml(source.provider || '—')}</span></div>
          <div><strong>Size</strong><span>${formatFileSize(source.byte_length)}</span></div>
          <div><strong>Received</strong><span>${formatRelDate(source.received_at)}</span></div>
          <div><strong>Source ID</strong><code>${escapeHtml(source.id)}</code></div>
        </div>
      </article>
    `).join('');
  } catch {
    container.innerHTML = '<div class="card modality-placeholder"><p>Could not load genetics status. Try again shortly.</p></div>';
  }
}

function sourceIcon(category) {
  if (category === 'wearables') return '⌁';
  if (category === 'genetics') return 'DNA';
  if (category === 'biomarkers') return 'LAB';
  return '·';
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

// ---- Init ----
// Runs last so every const binding above is initialized before the
// session-restore path touches the auth or dashboard UI.

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

if (returnedOauth) {
  if (state.accessToken && state.user) {
    sessionStorage.removeItem('fb_pending_oauth_return');
    completePendingOauth(returnedOauth);
  } else if (providerFromFirstPartyState(returnedOauth.state)) {
    // Agent-started OAuth can return before the dashboard has an authenticated
    // browser session. Keep the short-lived, signed redirect state locally and
    // complete it automatically as soon as this user signs in.
    sessionStorage.setItem('fb_pending_oauth_return', JSON.stringify(returnedOauth));
    showAuthMessage('Sign in to finish connecting your wearable.', false);
  } else {
    showOauthCodePanel(returnedOauth);
  }
}

loadCapabilities();
if (!state.agentLoginCode) loadWearableConnectionStatus();
