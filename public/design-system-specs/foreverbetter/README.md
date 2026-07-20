# wellnizz Healthspan Dossier

The house design system for wellnizz. A warm-paper editorial healthspan dossier: near-black ink on soft paper, Schibsted Grotesk display for the numbers, a single coral accent (`#df1e39`), and a composite Genomic Longevity Index at the top. Reads like a printed report, not an app.

## Implementation

This is a code-defined design system. All tokens, components, metrics, and layout
are available from the live API at `GET /design/systems/foreverbetter` and the
full implementation package at `GET /design/systems/foreverbetter/implementation`.

### Color tokens

| Token | Value | Usage |
|---|---|---|
| `background` | `#f6f3ee` | Page canvas |
| `paper` | `#fbf9f5` | Card/panel surface |
| `ink` | `#0e0e0e` | Primary text |
| `ink-soft` | `#3a3a38` | Secondary text |
| `ink-muted` | `#6b675f` | Tertiary text |
| `line` | `#e6e1d8` | Borders, dividers |
| `accent` | `#df1e39` | Coral accent (buttons, highlights, wordmark) |
| `accent-soft` | `#fce8eb` | Accent background |
| `ok` | `#256b4b` | Positive/success |
| `watch` | `#7d5700` | Caution/watch |
| `data-viz` | 5-color palette | `#df1e39`, `#256b4b`, `#0e0e0e`, `#7d5700`, `#8b7355` |

### Typography

| Role | Font | Weight | Size |
|---|---|---|---|
| Display | Schibsted Grotesk | 600 | 32-64px |
| Body | DM Sans | 400-600 | 14-16px |
| Mono | DM Mono | 400-500 | 11-13px |

### Layout sections (8)

1. **index-hero** — Composite Genomic Longevity Index (0-100) dial
2. **modality-coverage** — Connected modality chips with signal counts
3. **biomarker-panel** — Blood markers with optimal/watch/attention ranges
4. **superpowers** — Protective/advantageous genetic variants as green-left-border superpower cards
5. **polygenic-risk** — Polygenic risk scores with percentiles
6. **aging-hallmarks** — Hallmark of aging mapping per variant
7. **clinician-context** — Pharmacogenomic and actionable medical context
8. **action-plan** — Evidence-graded interventions and supplement discussion

### Components

| Component | Selector | Description |
|---|---|---|
| `gli_dial` | `.gli-dial` | Semicircular 0-100 composite index dial |
| `modality_chip` | `.modality-chip` | Data-provenance pill per connected modality |
| `edge_card` | `.edge-card` | Green-left-border genetic edge call-out |
| `primary_button` | `.primary-btn[data-variant="editorial"]` | Coral editorial CTA |

### Metrics (10)

recovery_score, sleep_performance, hrv, resting_heart_rate, steps, zone2_minutes, hba1c, apob, egfr, ldl

### Data bindings

| Component | Endpoint | Key fields |
|---|---|---|
| `gli_dial` | `GET /dashboard-specs/{analysis_id}` | `scores[].value`, `scores[].label` |
| `modality_chip` | `GET /sources` | `category`, `upload_status` |
| `edge_card` | `GET /analyses/{id}/genetic-slice` | `findings[].gene`, `findings[].interpretation` |
| `primary_button` | `GET /analyses/{id}/action-plan` | `interventions[]` |
