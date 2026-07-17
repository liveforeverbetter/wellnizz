/**
 * Cloud client + theming tests (no network).
 * Run: npx tsx --test shared/cloud-client.test.ts
 */
import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert";
import { CloudApiError, HealthApiClient, cloudConfig } from "./cloud-client.js";
import {
  resolveTheme,
  themeCss,
  listBundledSystems,
  DEFAULT_DESIGN_ID,
  dashboardTemplateOverride,
  injectTheme,
} from "./design/theme.js";
import { renderDashboardSpec } from "./render-spec.js";
import {
  renderDesignDashboard,
  renderFullDashboard,
  DESIGN_IDS,
} from "./design/render-designs.js";

describe("cloudConfig", () => {
  it("defaults the base URL and reads env overrides", () => {
    assert.equal(cloudConfig({}).baseUrl.startsWith("https://"), true);
    assert.equal(
      cloudConfig({ HEALTH_API_URL: "http://x/" }).baseUrl,
      "http://x"
    );
    assert.equal(cloudConfig({ HEALTH_API_KEY: "k" }).apiKey, "k");
  });
});

describe("HealthApiClient", () => {
  afterEach(() => mock.restoreAll());

  it("requires a key for scoped calls and points to the dashboard", () => {
    const client = new HealthApiClient({ baseUrl: "http://api.test" });
    assert.throws(() => client.requireKey(), /dashboard/);
    assert.equal(client.dashboardUrl, "http://api.test/dashboard");
  });

  it("sends the bearer token and hits the right path", async () => {
    const calls: any[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "an_1" }), { status: 200 });
    });
    const client = new HealthApiClient({
      baseUrl: "http://api.test",
      apiKey: "secret",
    });
    const res = await client.createAnalysis({
      user_id: "u",
      source_ids: ["s1"],
    });
    assert.equal(res.id, "an_1");
    assert.equal(calls[0].url, "http://api.test/analyses");
    assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  });

  it("builds provider-finder query strings without a key", async () => {
    const calls: any[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ genetics: [] }), { status: 200 });
    });
    const client = new HealthApiClient({ baseUrl: "http://api.test" });
    await client.findProviders({
      modalities: ["genetics", "biomarkers"],
      region: "Europe",
    });
    assert.match(
      calls[0],
      /\/providers\?modality=genetics%2Cbiomarkers&region=Europe/
    );
  });

  it("surfaces API error detail", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            detail: "nope",
            code: "bad_input",
            request_id: "req_1",
          }),
          { status: 400 }
        )
    );
    const client = new HealthApiClient({
      baseUrl: "http://api.test",
      apiKey: "k",
    });
    await assert.rejects(
      () => client.getActionPlan("an_1"),
      (error: unknown) =>
        error instanceof CloudApiError &&
        error.status === 400 &&
        error.problem.code === "bad_input" &&
        error.problem.request_id === "req_1" &&
        /400: nope/.test(error.message)
    );
  });

  it("turns a non-JSON error response into an actionable typed failure", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response("upstream unavailable", { status: 502 })
    );
    const client = new HealthApiClient({
      baseUrl: "http://api.test",
      apiKey: "k",
    });
    await assert.rejects(
      () => client.getDashboardSpec("an_1"),
      (error: unknown) =>
        error instanceof CloudApiError &&
        error.status === 502 &&
        error.problem.code === "invalid_json_response" &&
        error.problem.retryable === true
    );
  });
});

describe("theming", () => {
  it("bundles eight systems and resolves by id with a safe default", () => {
    // Seven summary designs + the full-dashboard `foreverbetter` house layout.
    assert.equal(listBundledSystems().length, 8);
    assert.equal(resolveTheme("ring-data").name, "Ring Data");
    assert.equal(resolveTheme("apex").name, "APEX");
    assert.equal(resolveTheme("foreverbetter").name, "ForeverBetter");
    assert.equal(resolveTheme("foreverbetter").scheme, "light");
    assert.equal(resolveTheme("dossier").id, "foreverbetter");
    assert.equal(resolveTheme("does-not-exist").id, DEFAULT_DESIGN_ID);
  });

  it("emits CSS variables from tokens", () => {
    const { rootCss, scheme } = themeCss(resolveTheme("ring-data"));
    assert.match(rootCss, /--primary: #d4b483/);
    assert.match(rootCss, /--font-body:/);
    assert.equal(scheme, "dark");
  });

  it("renders a white-label dashboard with no brand string", () => {
    const html = renderDashboardSpec(
      {
        title: "Health",
        score: 78,
        cards: [{ title: "ApoB", score: 55, status: "watch" }],
      },
      "clinical-modern"
    );
    assert.match(html, /--primary: #1d6ef2/);
    assert.equal(/foreverbetter/i.test(html), false);
  });

  it("maps design tokens onto the local template variables", () => {
    const { css } = dashboardTemplateOverride(resolveTheme("serene"));
    assert.match(css, /--color-canvas: #141d33/); // background -> canvas
    assert.match(css, /--color-brand: #a78bfa/); // primary -> brand
    assert.match(css, /--color-ink: /); // text -> ink
  });

  it("injects a theme override before </head>", () => {
    const themed = injectTheme(
      "<html><head><title>x</title></head><body></body></html>",
      "metabolic"
    );
    assert.match(themed, /data-design="metabolic"/);
    assert.match(themed, /--color-brand: #ff5c39[\s\S]*<\/head>/);
  });
});

describe("per-design dashboards are structurally unique", () => {
  const data = {
    score: 74,
    summary: "Built from blood test and wearable.",
    cards: [
      {
        title: "ApoB",
        score: 55,
        status: "needs_attention",
        summary: "High",
        action: "Review with clinician",
      },
      { title: "Sleep", score: 82, status: "optimal", summary: "Consistent" },
      { title: "HbA1c", score: 68, status: "watch" },
    ],
    priorities: [{ title: "Lower ApoB", why: "Top signal" }],
  };
  const SIG: Record<string, RegExp> = {
    "ring-data": /class="ring"/,
    performance: /class="gauge"/,
    "clinical-modern": /<table>/,
    apex: /class="apex-readiness"/,
    metabolic: /class="zone"/,
    "system-cards": /class="grid"/,
    serene: /class="orb"/,
  };

  it("renders all seven ids", () => assert.equal(DESIGN_IDS.length, 7));

  it("each design has its signature component and no bleed", () => {
    const rendered = Object.fromEntries(
      DESIGN_IDS.map((id) => [id, renderDesignDashboard(data, id)])
    );
    for (const id of DESIGN_IDS) {
      assert.match(rendered[id], SIG[id], `${id} missing signature`);
      for (const other of DESIGN_IDS) {
        if (other !== id)
          assert.equal(
            SIG[id].test(rendered[other]),
            false,
            `${id} bled into ${other}`
          );
      }
    }
  });

  it("produces seven distinct outputs (not a recolor)", () => {
    assert.equal(
      new Set(DESIGN_IDS.map((id) => renderDesignDashboard(data, id))).size,
      7
    );
  });

  it("applies distinct voice per design", () => {
    assert.match(renderDesignDashboard(data, "performance"), /FOCUS/);
    assert.match(renderDesignDashboard(data, "serene"), /Take a breath/);
    assert.match(
      renderDesignDashboard(data, "clinical-modern"),
      /Reference range|markers in range/
    );
  });

  it("keeps the full performance renderer white-label", () => {
    const html = renderFullDashboard(
      { brand_name: "My health app" },
      "performance"
    );
    assert.match(html, /My health app/);
    assert.doesNotMatch(html, /WHOOP/);
  });

  it("renders the APEX full dashboard from the pipeline contract", () => {
    const html = renderFullDashboard(
      {
        brand_name: "My health app",
        biomarker_analysis: {
          measured_count: 1,
          biological_age: { score: 66, model_version: "biomarker-internal-v1" },
        },
        quality: {
          total_variants: 608,
          annotated_variants: 0,
          matched_markers: 0,
        },
      },
      "apex"
    );
    assert.match(html, /data-design="apex"/);
    assert.match(html, /class="apex-readiness"/);
    assert.match(html, /role="tablist"/);
    assert.match(html, /data-apex-tab="wearables"/);
    assert.match(html, /data-apex-panel="biomarkers"/);
    assert.match(html, /apex-tab-transition/);
    assert.match(html, /My health app/);
    assert.match(html, /Biological-age signal/);
    assert.match(html, /66 \/ 100/);
    assert.match(html, /No evidence-backed genetic findings are shown/);
    assert.doesNotMatch(html, /\[object Object\]/);
    assert.doesNotMatch(html, /WHOOP/);
  });
});
