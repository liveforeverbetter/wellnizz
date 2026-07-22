import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('wearable connection messages render in the dashboard message area', async () => {
  const app = await readFile('public/dashboard/app.js', 'utf8');
  const source = app.match(
    /function showMessage\(text, error = false\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(source, 'showMessage source is present');

  const message = { textContent: '', className: '' };
  const run = new Function(
    'messageEl', 'showAuthMessage',
    `${source}\nshowMessage('Taking you to WHOOP to approve access...', false);`,
  );

  assert.doesNotThrow(() => run(message, () => {}));
  assert.equal(message.textContent, 'Taking you to WHOOP to approve access...');
  assert.equal(message.className, 'message success');
});

test('dashboard is agent-first with a first-party OTP flow behind a toggle', async () => {
  const [html, app, styles] = await Promise.all([
    readFile('public/dashboard/index.html', 'utf8'),
    readFile('public/dashboard/app.js', 'utf8'),
    readFile('public/dashboard/styles.css', 'utf8'),
  ]);

  // Default panel hands the user a setup prompt for their agent; the developer
  // panel uses the same first-party 8-digit email code as agent onboarding.
  assert.match(html, /id="agent-panel"/);
  assert.match(html, /id="mode-agent-btn"/);
  assert.match(html, /id="mode-dev-btn"/);
  assert.match(html, /aria-label="Use dashboard"/);
  assert.match(html, /mode-visual-agent/);
  assert.match(html, /mode-visual-dashboard/);
  const modalityFlow = html.match(/<div class="pipe-sources"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(modalityFlow, 'the public modality flow is present');
  assert.deepEqual(
    [...modalityFlow.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1]),
    ['Genetics', 'Biomarkers', 'Wearables'],
  );
  assert.match(html, /class="outcome-bento"/);
  assert.match(html, /bento-context/);
  assert.match(html, /bento-dashboard/);
  assert.match(html, /bento-plan/);
  assert.match(html, /id="page-overview"/);
  assert.match(html, /data-route="overview"/);
  assert.match(html, /id="overview-connected-count"/);
  assert.match(html, /id="overview-whoop-status"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(app, /ArrowLeft/);
  assert.match(html, /type="email"/);
  assert.match(html, /Send code/);
  assert.match(html, /id="auth-code-form"/);
  assert.match(app, /auth\/otp\/start/);
  assert.match(app, /auth\/otp\/verify/);
  assert.match(app, /response\.status === 401/);
  assert.match(app, /expireDashboardSession/);
  assert.match(app, /function refreshOverview\(\)/);
  assert.match(app, /window\.location\.hash = '#overview'/);
  assert.match(app, /const hash = window\.location\.hash \|\| '#overview'/);

  // Agent-started first-party wearable redirects are retained through dashboard
  // sign-in and complete automatically; the code panel remains only for BYO
  // OAuth apps, whose secrets stay in the initiating browser tab.
  assert.match(html, /id="oauth-code-panel"/);
  assert.match(app, /fb_pending_oauth/);
  assert.match(app, /fb_pending_oauth_return/);
  assert.match(app, /providerFromFirstPartyState/);
  assert.match(app, /whoopAvailability/);
  assert.match(app, /ouraAvailability/);
  assert.match(app, /Connect your \$\{providerLabel\(provider\)\}/);
  assert.match(html, /id="oura-connect-btn"/);
  assert.match(html, /Developer: use your own Oura app/);
  assert.match(html, /Install Wellnizz Connect/);
  assert.match(html, /android-logo/);
  assert.match(html, /Bring Fitbit, Samsung Health, Google Fit, and other Android health sources together/);
  assert.match(html, /id="wearables-connect"/);
  assert.match(html, /id="wearables-sources"/);
  assert.match(html, /id="whoop-connect-btn"/);
  assert.match(html, /id="oura-connect-btn"/);
  assert.match(html, /Your connected health data/);
  assert.match(html, /Add your data sources across multiple dimensions to customize an action plan and dashboard specific to you\./);
  assert.match(html, /id="overview-genetics-status"/);
  assert.match(html, /id="overview-data-count"/);
  assert.match(html, /Wearable connections/);
  assert.match(app, /function loadOverviewData\(\)/);
  assert.match(html, /class="genetics-upload-card"/);
  assert.match(html, /id="genetics-sources"/);
  assert.match(html, /id="labs-sources"/);
  assert.doesNotMatch(html, /Prefer to run it yourself/);
  assert.doesNotMatch(html, /id="page-health-connect"/);
  assert.doesNotMatch(html, /data-route="health-connect"/);
  assert.doesNotMatch(app, /page-health-connect/);

  assert.doesNotMatch(app, /access_token=/);
  assert.doesNotMatch(app, /sessionFromHash/);

  // The account dashboard uses the ForeverBetter warm-light identity; the
  // Meridian skin ships only as the pinned design-system implementation
  // snapshot. The hero remains driven by actual connection readiness, never
  // fabricated health metrics.
  assert.doesNotMatch(html, /meridian-/);
  assert.match(html, /pipe-hub/);
  assert.match(html, /ws-key/);
  assert.match(html, /source-card-whoop/);
  assert.match(styles, /--bg: #f6f3ee/);
  assert.match(styles, /--accent: #df1e39/);
  assert.doesNotMatch(styles, /--brand: #12d982/);
  assert.doesNotMatch(styles, /Metropolis/);
  assert.match(app, /contextCategoriesReady \/ 3/);
});

test('dashboard renders only the current analysis and keeps history separate', async () => {
  const [app, html] = await Promise.all([
    readFile('public/dashboard/app.js', 'utf8'),
    readFile('public/dashboard/index.html', 'utf8'),
  ]);

  assert.match(app, /analysisParams\.set\('limit', '1'\)/);
  assert.match(app, /const full = await apiGet\(`\/analyses\/\$\{current\.id\}`/);
  assert.doesNotMatch(app, /analyses\.slice\(0, 5\)/);
  assert.match(app, /function interpretationSections\(interpretations\)/);
  assert.match(app, /function dedupeCurrentInterpretations\(page, interpretations\)/);
  assert.match(app, /kept for trends, not repeated here/i);
  assert.match(app, /Explore all \$\{currentSignals\.length\} current findings by section/);
  assert.match(app, /genetic_condition_catalog_match: 'Catalog matches'/);
  assert.match(app, /function sourceHistory\(sources, heading\)/);
  assert.match(app, /Wearable data by provider/);
  assert.match(app, /older runs are not blended into this current interpretation/i);
  assert.match(html, /Historical panels belong in trends, not a blended result/);
});
