/**
 * Theme loader: turns a design system (bundled, hosted, or custom) into a set of
 * CSS custom properties the dashboard renderer injects. Keeps the generated UI
 * white-label and themeable from one source of tokens.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DesignTokens {
  id: string;
  name: string;
  scheme: "light" | "dark";
  colors: Record<string, string | string[]>;
  typography: {
    font_display: string;
    font_body: string;
    font_mono?: string;
    google_fonts?: string[];
  };
  radii: Record<string, string>;
  shadow?: string;
}

function bundled(): DesignTokens[] {
  const path = fileURLToPath(new URL("./systems.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")).systems as DesignTokens[];
}

export function listBundledSystems(): Array<{
  id: string;
  name: string;
  scheme: string;
  best_for?: string[];
  layout?: unknown;
  modalities?: string[];
  metric_ids?: string[];
}> {
  return bundled().map((s) => ({
    id: s.id,
    name: s.name,
    scheme: s.scheme,
    best_for: (s as any).best_for,
    layout: (s as any).layout,
    modalities: Array.from(
      new Set(
        ((s as any).modality_sections ?? []).map(
          (section: any) => section.modality
        )
      )
    ),
    metric_ids: ((s as any).metrics ?? []).map((metric: any) => metric.id),
  }));
}

export const DEFAULT_DESIGN_ID = "clinical-modern";

// Resolve a design system by id from the bundled set, or accept a custom token
// object (or a path to one). Falls back to the default if the id is unknown.
export function resolveTheme(idOrTokens?: string | DesignTokens): DesignTokens {
  if (idOrTokens && typeof idOrTokens === "object") return idOrTokens;
  const systems = bundled();
  if (typeof idOrTokens === "string" && idOrTokens.endsWith(".json")) {
    return JSON.parse(readFileSync(idOrTokens, "utf8")) as DesignTokens;
  }
  // `dossier` was the original local-only name for the ForeverBetter house
  // layout. Keep it as an input alias so existing generated commands remain
  // reproducible, while exposing the same canonical id as the API.
  const canonicalId = idOrTokens === "dossier" ? "foreverbetter" : idOrTokens;
  return (
    systems.find((s) => s.id === canonicalId) ??
    systems.find((s) => s.id === DEFAULT_DESIGN_ID)!
  );
}

// Map design tokens onto the local dashboard template's CSS custom properties
// (--color-canvas, --color-ink, --color-brand, ...) so the same 6 systems (or a
// custom token file) re-theme the deep-genomic dashboard. Injected as a second
// :root block after the template default, so later-wins overrides it.
export function dashboardTemplateOverride(theme: DesignTokens): {
  css: string;
  fontsHref: string | null;
} {
  const c = theme.colors as Record<string, string>;
  const t = theme.typography;
  const map: Record<string, string> = {
    "color-canvas": c.background,
    "color-paper": c.surface,
    "color-paper-2": c.surface_alt ?? c.surface,
    "color-surface": c.surface,
    "color-ink": c.text,
    "color-ink-soft": c.text,
    "color-ink-mute": c.text_muted,
    "color-ink-faint": c.text_muted,
    "color-inverse": c.on_primary ?? "#ffffff",
    "color-line": c.border,
    "color-line-soft": c.border,
    "color-line-strong": c.border,
    "color-brand": c.primary,
    "color-brand-hover": c.accent ?? c.primary,
    "color-brand-soft": c.surface_alt ?? c.surface,
    "color-brand-tint": c.surface_alt ?? c.surface,
    "color-good": c.positive,
    "color-optimal": c.positive,
    "color-neutral": c.accent ?? c.primary,
    "color-moderate": c.warning,
    "color-critical": c.negative,
    "color-inactive": c.text_muted,
    "color-focus": c.primary,
    "font-display": t.font_display,
    "font-body": t.font_body,
  };
  const lines = Object.entries(map)
    .filter(([, v]) => v)
    .map(([k, v]) => `  --${k}: ${v};`);
  const css = `:root {\n  color-scheme: ${theme.scheme};\n${lines.join(
    "\n"
  )}\n}`;
  const fonts = t.google_fonts ?? [];
  const fontsHref = fonts.length
    ? `https://fonts.googleapis.com/css2?${fonts
        .map((f) => `family=${f}`)
        .join("&")}&display=swap`
    : null;
  return { css, fontsHref };
}

// Inject a design system into a dashboard template's HTML: appends an override
// <style> (and optional fonts <link>) just before </head> so it wins the cascade.
// `design` is a bundled id, a path to a custom tokens JSON, or undefined (default).
export function injectTheme(templateHtml: string, design?: string): string {
  const theme = resolveTheme(design);
  const { css, fontsHref } = dashboardTemplateOverride(theme);
  const inject = `${
    fontsHref ? `<link rel="stylesheet" href="${fontsHref}">\n` : ""
  }<style id="theme-override" data-design="${
    theme.id
  }">\n${css}\n</style>\n</head>`;
  return templateHtml.includes("</head>")
    ? templateHtml.replace("</head>", inject)
    : `${templateHtml}\n<style id="theme-override">\n${css}\n</style>`;
}

// Emit a `:root { ... }` CSS block plus an optional Google Fonts <link>.
export function themeCss(theme: DesignTokens): {
  rootCss: string;
  fontsHref: string | null;
  scheme: string;
} {
  const c = theme.colors;
  const flat = (v: string | string[]) => (Array.isArray(v) ? v.join(", ") : v);
  const vars: string[] = [];
  for (const [k, v] of Object.entries(c))
    vars.push(`  --${k.replace(/_/g, "-")}: ${flat(v)};`);
  vars.push(`  --font-display: ${theme.typography.font_display};`);
  vars.push(`  --font-body: ${theme.typography.font_body};`);
  if (theme.typography.font_mono)
    vars.push(`  --font-mono: ${theme.typography.font_mono};`);
  for (const [k, v] of Object.entries(theme.radii))
    vars.push(`  --radius-${k}: ${v};`);
  if (theme.shadow) vars.push(`  --shadow: ${theme.shadow};`);
  const rootCss = `:root {\n  color-scheme: ${theme.scheme};\n${vars.join(
    "\n"
  )}\n}`;
  const fonts = theme.typography.google_fonts ?? [];
  const fontsHref = fonts.length
    ? `https://fonts.googleapis.com/css2?${fonts
        .map((f) => `family=${f}`)
        .join("&")}&display=swap`
    : null;
  return { rootCss, fontsHref, scheme: theme.scheme };
}
