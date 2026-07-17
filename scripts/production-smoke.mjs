#!/usr/bin/env node
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, value] = process.argv[i].startsWith("--") && process.argv[i].includes("=")
    ? process.argv[i].split(/=(.*)/s, 2)
    : [process.argv[i], process.argv[i + 1]];
  if (key?.startsWith("--")) {
    args.set(key.slice(2), value ?? "true");
    if (!process.argv[i].includes("=")) i += 1;
  }
}

const baseUrl = String(args.get("base-url") ?? process.env.HEALTH_API ?? "https://api.foreverbetter.xyz").replace(/\/+$/, "");
const docsUrl = String(args.get("docs-url") ?? process.env.DOCS_URL ?? "https://foreverbetter.mintlify.app").replace(/\/+$/, "");
const timeoutMs = Number(args.get("timeout-ms") ?? 10000);

const checks = [];

async function fetchJson(path, expectedStatus = 200) {
  const res = await fetchWithTimeout(`${baseUrl}${path}`);
  if (res.status !== expectedStatus) {
    throw new Error(`${path} returned ${res.status}, expected ${expectedStatus}`);
  }
  return res.json();
}

async function fetchText(url, expectedStatus = 200) {
  const res = await fetchWithTimeout(url);
  if (res.status !== expectedStatus) {
    throw new Error(`${url} returned ${res.status}, expected ${expectedStatus}`);
  }
  return res.text();
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function check(name, fn) {
  checks.push({ name, fn });
}

check("health endpoint responds", async () => {
  const body = await fetchJson("/health");
  if (body.ok !== true) throw new Error("/health ok was not true");
});

check("API root sends developers to the docs", async () => {
  const res = await fetchWithTimeout(`${baseUrl}/`, { redirect: "manual" });
  if (res.status !== 302) throw new Error(`/ returned ${res.status}, expected 302`);
  if (res.headers.get("location") !== docsUrl) {
    throw new Error(`/ redirected to ${res.headers.get("location")}, expected ${docsUrl}`);
  }
});

check("consumer dashboard is reachable", async () => {
  const text = await fetchText(`${baseUrl}/dashboard`);
  if (!text.includes("Set up through your agent")) throw new Error("dashboard did not include agent-first onboarding");
  if (!text.includes("ForeverBetter Connect")) throw new Error("dashboard did not describe the ForeverBetter Connect app");
  if (text.includes('id="page-health-connect"') || text.includes('data-route="health-connect"')) {
    throw new Error("dashboard still exposes the confusing Health Connect page");
  }
  if (!text.includes(docsUrl)) throw new Error("dashboard did not link back to the docs");
});

check("ready endpoint is healthy", async () => {
  const body = await fetchJson("/ready");
  if (body.ok !== true) throw new Error("/ready ok was not true");
  if (body.service !== "foreverbetter-api") throw new Error(`unexpected service ${body.service}`);
});

check("OpenAPI branding is current", async () => {
  const body = await fetchJson("/openapi.json");
  if (body.info?.title !== "ForeverBetter API") throw new Error(`unexpected OpenAPI title ${body.info?.title}`);
  if (!body.paths?.["/imports/file"]?.post) throw new Error("OpenAPI missing POST /imports/file");
  if (!body.paths?.["/api/v1/sdk/users/{user_id}/sync"]?.post) throw new Error("OpenAPI missing the mobile SDK sync endpoint");
  if (!body.paths?.["/biomarkers/derive"]?.post) throw new Error("OpenAPI missing POST /biomarkers/derive");
  if (!body.paths?.["/biomarkers/analyze"]?.post) throw new Error("OpenAPI missing POST /biomarkers/analyze");
  if (!body.paths?.["/wearables/analyze"]?.post) throw new Error("OpenAPI missing POST /wearables/analyze");
  if (!body.paths?.["/dashboard-links"]?.post) throw new Error("OpenAPI missing POST /dashboard-links");
  if (!body.paths?.["/dashboards/private/{token}"]?.get) throw new Error("OpenAPI missing private dashboard view");
  if (!body.paths?.["/genetics/analyze"]?.post) throw new Error("OpenAPI missing POST /genetics/analyze");
  if (!body.paths?.["/mcp"]?.post) throw new Error("OpenAPI missing POST /mcp");
});

check("agent manifest is current", async () => {
  const body = await fetchJson("/.well-known/health-agent.json");
  if (body.name !== "ForeverBetter API") throw new Error(`unexpected agent manifest name ${body.name}`);
  if (!body.openapi_url?.endsWith("/openapi.json")) throw new Error("agent manifest missing OpenAPI URL");
  if (body.auth?.self_serve_key?.steps?.length !== 3) throw new Error("agent manifest missing the three-step self-serve key flow");
});

check("hosted agent skill is live", async () => {
  const res = await fetchWithTimeout(`${baseUrl}/SKILL.md`);
  if (res.status !== 200) throw new Error(`/SKILL.md returned ${res.status}, expected 200`);
  if (!res.headers.get("content-type")?.includes("text/markdown")) {
    throw new Error(`/SKILL.md returned unexpected content type ${res.headers.get("content-type")}`);
  }
  const text = await res.text();
  if (!text.includes("## Step 1: Execution mode") || !text.includes("Self-hosted API") || !text.includes("Local pipeline")) {
    throw new Error("hosted skill is missing cloud, self-hosted, and local onboarding");
  }
  if (!text.includes("github.com/liveforeverbetter/agentic-health-analysis")) throw new Error("hosted skill is missing the open-source local path");
  if (!text.includes("First value: a custom dashboard")) throw new Error("hosted skill is missing dashboard-first onboarding");
  if (!text.includes("Wearables are")) throw new Error("hosted skill is missing wearables-last onboarding");
  if (!text.includes("WHOOP and Oura use ForeverBetter first-party OAuth")) throw new Error("hosted skill is missing the agent WHOOP flow");
  if (!text.includes("ForeverBetter Connect")) throw new Error("hosted skill is missing the consumer Health Connect app flow");
});

check("consumer wearable capabilities are live", async () => {
  const body = await fetchJson("/capabilities");
  const whoop = body.capabilities?.find(item => item.id === "wearables.whoop");
  const healthConnect = body.capabilities?.find(item => item.id === "wearables.health_connect");
  if (whoop?.first_party_oauth !== true) throw new Error("WHOOP first-party OAuth is not enabled");
  if (healthConnect?.status !== "available") throw new Error("Google Health Connect is not available");
});

check("agent onboarding docs are live", async () => {
  const text = await fetchText(`${docsUrl}/connect-your-agent`);
  if (!text.includes("Connect your agent")) throw new Error("agent onboarding docs did not include the page title");
  if (!text.includes("Google Health Connect")) throw new Error("agent onboarding docs did not include Health Connect guidance");
});

let failures = 0;
console.log(`Production smoke target: ${baseUrl}`);
console.log(`Docs target: ${docsUrl}`);

for (const item of checks) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${item.name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`Smoke failed: ${failures}/${checks.length} checks failed.`);
  process.exit(1);
}

console.log(`Smoke passed: ${checks.length}/${checks.length} checks passed.`);
