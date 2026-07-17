# Dashboard theming

Generated dashboards are white-label and themed from design tokens. Pass a
system with `--design=<id>` (pipeline) or fetch live tokens in cloud mode.

## Bundled systems (`systems.json`)

| id                | scheme | good for                                                               |
| ----------------- | ------ | ---------------------------------------------------------------------- |
| `ring-data`       | dark   | sleep & readiness, circular scores                                     |
| `performance`     | dark   | recovery, sleep, strain, health monitor, stress, all-modality coaching |
| `apex`            | dark   | source-aware readiness, health monitor, FOCUS, biological-age context  |
| `clinical-modern` | light  | biomarker panels (default)                                             |
| `metabolic`       | light  | CGM & glucose, nutrition                                               |
| `system-cards`    | light  | multi-metric summaries                                                 |
| `serene`          | dark   | mood & recovery, mindfulness                                           |
| `foreverbetter`   | light  | full multimodal Healthspan dossier, composite index                    |

`dossier` remains a supported legacy alias for `foreverbetter`, so existing
pipeline commands and generated reports remain reproducible. New integrations
should use `foreverbetter`, which matches the API design-system identifier.

## Custom tokens

Pass `--design=/absolute/path/to/tokens.json` with your own token file. Minimum
shape:

```json
{
  "id": "my-brand",
  "name": "My Brand",
  "scheme": "light",
  "colors": {
    "background": "#ffffff",
    "surface": "#f7f7f8",
    "surface_alt": "#eeeef0",
    "border": "rgba(0,0,0,0.10)",
    "text": "#111111",
    "text_muted": "#666666",
    "primary": "#3b5bdb",
    "on_primary": "#ffffff",
    "accent": "#12b3a6",
    "positive": "#16a34a",
    "warning": "#d97706",
    "negative": "#dc2626",
    "data_viz": ["#3b5bdb", "#12b3a6", "#8b5cf6", "#f59e0b", "#ef4444"]
  },
  "typography": {
    "font_display": "\"Your Font\", system-ui, sans-serif",
    "font_body": "system-ui, sans-serif",
    "google_fonts": []
  },
  "radii": { "sm": "8px", "md": "12px", "lg": "18px", "pill": "999px" },
  "shadow": "0 12px 32px -16px rgba(0,0,0,0.18)"
}
```

The renderer maps every color/radius key to a CSS custom property
(`--background`, `--primary`, `--radius-md`, `--shadow`, `--font-body`, etc.),
so any template that reads those variables re-themes automatically. No brand
names are baked into the output.

## WHOOP-style performance contract

`performance` is the first full design contract, not only a color palette. It
is intentionally a responsive, white-label athletic/recovery board inspired by
the performance-tracking genre. The structured fields in `systems.json` let a
custom web or mobile-width dashboard renderer discover the same model without
copying the reference renderer:

- `layout.sections` fixes the information order: today hero → recovery/sleep/strain → health monitor → stress → activity load → biomarker context → genetic context → daily context → action plan → provenance.
- `metrics` names which signals lead (`recovery_score`, `sleep_performance`, `strain`), which support them (HRV, resting heart rate, respiratory rate, oxygen, temperature), and which are slower context (ApoB, HbA1c, genetic training response).
- `modality_sections` defines required/optional fields, empty states, and responsive behavior for wearables, biomarkers, genetics, and health context. Missing modalities stay explicit; they never become fabricated scores.
- `action_plan` defines the direct-coach voice, FOCUS / MAINTAIN / WATCH / RETEST stages, cadence, ranking rules, provenance fields, and the wellness safety boundary.
- `animations` describes a small choreography (gauge sweep, optional healthspan orb, count-in, bar growth, focus reveal) and the reduced-motion fallback for each.
- `data_capture` is the handoff contract: identity, provenance, freshness, modality fields, and missing-data behavior.

The local `render-performance.ts` consumes the full transformed dashboard object
and degrades each section gracefully. Keep the visual order and voice, but feel
free to replace the HTML components with a responsive React, native, or agent-
generated implementation.

## APEX dashboard contract

`apex` is a first-class, full-pipeline dashboard renderer and an exact
recreation contract for the supplied APEX Design System handoff. It does not
ship the handoff's prototype files or imagery; it encodes their reusable system:

- Near-black `#07100C` canvas, `#14181A` surfaces, Archivo hierarchy, and
  JetBrains Mono measurement values.
- A sticky header and keyboard-operable scrolling tabs for Overview, Action
  plan, Genomic, Wearable, and Biomarker panels; then Sleep (cyan), Recovery
  (amber), and Strain (blue) circular readiness rings. Source/freshness chips
  stay attached to measured signals. Panel changes use a short staggered
  transition and switch instantly when reduced motion is requested.
- An observation-led insight banner, health-monitor tiles, FOCUS actions,
  evidence-tiered genomic cards, and a separate long-horizon biomarker /
  biological-age view.
- `systems.json` carries the layout, token values, metric emphasis, data
  contracts, source freshness rules, responsive behavior, and reduced-motion
  choreography; the hosted API exposes the same `apex` identity at
  `GET /design/systems/apex`.

Run `npm run sample:report -- --design=apex` to produce it from the normal
pipeline, or select `apex` in a cloud render. Missing modalities render as
explicit empty states; the renderer never invents a readiness, streak, or
biological-age value.
