# foreverbetter Design System

> Personalized AI health: helping you deeply understand your biology and take action to improve it. A plan built around you.

foreverbetter is a European wellness membership for biomarker‑first longevity. The MVP is a **EUR 199/year founding membership** rolling out in Portugal first, with an open-source genomic-interpretation dashboard already available. The product positions itself as a **wellness and lifestyle insights service — not medical**, and is built around **EU data residency, explicit GDPR Art. 9 consent, and member-controlled export and deletion**.

> The legacy source codebases (under `website/` and `open-source/`) still reference the product by its previous working name `23longevity`. References to those filepaths are kept verbatim; brand-facing copy in this design system uses **foreverbetter**.

## Two surfaces, one brand

| Product | Role | Stack | Audience |
|---|---|---|---|
| **Marketing website** (`foreverbetter.com`) | Sells the membership, explains panels, FAQ, checkout | Next.js 16 static export → Cloudflare Pages | Health-literate Europeans pre-purchase |
| **Open-source dashboard** | Local-first VCF/WGS → healthspan dashboard rendered as a single self-contained HTML | TypeScript pipeline + Nunjucks template | Members + open-source/technical users |

Both surfaces share **one brand**: coral-red accent on warm paper background, tabular numerals everywhere, restrained motion, and copy that respects the reader's intelligence.

## Sources used to build this system

- `website/` — Next.js 16 marketing site (read-only mount).
  - `src/app/page.tsx` — current redesign homepage (Fraunces + DM Sans, brand `#df1e39`).
  - `src/app/layout.tsx`, `src/app/globals.css` — the underlying "Hallmark" layout shell.
  - `src/app/content.ts` — biomarker groups, FAQs, blog content, compare-page data.
  - `tokens.css` — Hallmark coral token export (Plus Jakarta Sans + JetBrains Mono in OKLCH).
- `open-source/` — local-first genomic-analysis + dashboard renderer (read-only mount).
  - `DESIGN.md` v2.5 — single source of truth for the dashboard (sections, components, tokens, behavior).
  - `README.md` — pipeline overview.
  - `skills/genomic-analysis/templates/genomic-dashboard.html` — canonical dashboard HTML/CSS.

If you have access to the GitHub repos (Cloudflare-deployed marketing site + open-source genomic pipeline), refer to those as the canonical source. This design system is a snapshot for design work.

---

## Content fundamentals

### Voice

Direct, scientific, and quietly confident. The product speaks like **a research-grade instrument**, not a wellness app and not a medical record. Sentences are short and end on the verb that matters. Numbers carry the argument; adjectives do not.

> "Know what your biology is doing, every year."
> "Annual longevity blood testing for Europe. 100+ biomarkers in a private EU-hosted dashboard with a protocol you can act on."

### Tone rules

- **Address the reader as "you" / "your".** First person ("we") is reserved for the team/operator.
- **Sentence case for headings.** Not title case. (`Become a Member` is the only consistent Title-Cased CTA — it's the button label.)
- **No exclamation marks.** No emoji in product or marketing copy.
- **No clinical jargon without translation.** "ApoB" appears with "Cardiovascular load". `HbA1c` with "Glucose control".
- **Concrete units, never approximations.** `EUR 199/year`, `5–7 days`, `100+ markers`, `Top 18%`. Currency code (`EUR`) rather than symbol.
- **Hedged claims about biology, sharp claims about logistics.** "Personalised protocol" yes; "diagnose" never. Always: *not a medical service*.
- **Brand name is `foreverbetter`** — lowercase, no space, no hyphen. Never "Forever Better", "Forever-Better", or "FB". When the word appears as a wordmark, the coral accent lands on the second half (`forever`<span style="color:#df1e39">`better`</span>) because *better* is the product promise.

### Example labels (from `DESIGN.md`)

✅ Good
- "APOE4 variant detected — elevated neurodegenerative risk. Protocol available."
- "Your cardiovascular aging trajectory is above average. 3 interventions identified."
- "Sirtuin pathway: favorable. NAD+ precursor protocol recommended."

❌ Bad
- "You have the Alzheimer gene! Unlock your brain power!"
- "Your heart health is moderate. Talk to your doctor."

### CTA patterns

| Type | Examples |
|---|---|
| Primary action | "Become a Member", "Add genomics", "View Protocol" |
| Secondary | "See how it works", "See what we test", "Read the guide" |
| Inline link | "Read the guide", "→ 2 recommended actions" |
| Navigational | "Overview", "Categories", "Protocols", "Genetic Variants" |

CTAs never use generic verbs ("Get started", "Learn more", "Sign up"). They always name the action.

### Compliance phrasing

The medical disclaimer is **mandatory** in any footer/long-form context and uses this language verbatim or close to it:

> foreverbetter is a wellness and lifestyle service, not a medical service. The biomarker analysis, healthspan score, genomic interpretation, and protocol recommendations are informational only. They do not constitute medical advice, diagnosis, treatment, or prescription. Always consult a qualified physician before changing medication, diet, supplementation, or training.

---

## Visual foundations

### Identity in one sentence

**Coral-red accent on a warm paper canvas, set in Fraunces editorial display for marketing and Plus Jakarta Sans for product, with JetBrains/DM Mono for every numeric value.**

### Two type stacks (one brand)

| Surface | Display | Body / UI | Mono |
|---|---|---|---|
| **Marketing** (web) | Fraunces (serif, variable opsz/wght) | DM Sans | DM Mono |
| **Product** (dashboard) | Plus Jakarta Sans (display weights 700–800) | Plus Jakarta Sans | JetBrains Mono |

The marketing site is editorial and warm; the product is engineered and clinical. They share the palette and rhythm so the seam between them is intentional, not accidental. See `colors_and_type.css` for the full token export and `fonts/` for the local font files.

### Color palette

The brand is **monochromatic accent** — a single coral-red against warm neutrals. No purple gradients, no rainbow status, no decorative blues.

| Role | Hex | OKLCH | Usage |
|---|---|---|---|
| **brand / accent** | `#df1e39` | `oklch(58% 0.22 22)` | One single CTA color, one single chart-highlight color. Used sparingly. |
| brand soft | `#fce8eb` | `oklch(94% 0.024 22)` | Quiet coral wash for "innate strength" cards and number ornaments |
| brand tint | `#fdf3f5` | `oklch(97% 0.012 22)` | Subtle tinted surface |
| canvas | `#f6f3ee` | `oklch(95.5% 0.01 35)` | Default page background (warm paper) |
| paper | `#fbf9f5` | `oklch(98% 0.006 35)` | Cards / lifted surfaces |
| ink | `#0e0e0e` | `oklch(18% 0.012 35)` | Headlines, primary text |
| ink soft | `#3a3a38` | `oklch(28% 0.014 35)` | Body copy |
| ink mute | `#7a7770` | `oklch(56% 0.016 35)` | Captions, metadata |
| line | `#e6e1d8` | `oklch(86% 0.012 35)` | Hairline dividers |
| good (optimal) | `#1e7a52` | `oklch(52% 0.16 145)` | Semantic only — "in range", "improving" |
| moderate | — | `oklch(55% 0.14 72)` | Semantic only — "watch this" |
| critical | — | `oklch(48% 0.20 22)` | Semantic only — same hue as brand; reserved for risk labels |
| night | `#0a0806` | `oklch(8% 0.012 35)` | Inverted hero panels, the pricing card |

**Rule:** Red is both the brand color and the "critical risk" color. They coexist because the brand is unapologetically clinical — the product genuinely is built around flagging risk and acting on it. Never use red decoratively.

### Spacing

A 4px base scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`. Marketing site adds editorial breathing room: section padding is `clamp(80px, 10vw, 128px)`. Max content width is **1240–1440px** (1240 in `globals.css`, 1440 in the redesign).

### Borders, radii, shadows

- **Hairlines do the work.** `1px solid #e6e1d8` is the default depth mechanism. Shadows are a hint, never theatrical.
- **Radii:** `5/8/14/20` and `9999px` for pills. Cards = `8–14px`. Pills (buttons, badges) = `9999px`.
- **Shadows:**
  - `--shadow-card`: `0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.06)` — resting card
  - `--shadow-elevated`: `0 4px 12px rgba(0,0,0,.06), 0 2px 4px rgba(0,0,0,.04)` — hover/focus
  - `--shadow-modal`: `0 20px 60px rgba(0,0,0,.12)` — modals only
- **Pill buttons** (`border-radius: 9999px`) are the brand's button shape. Square buttons exist only as in-card CTAs (`radius-sm` 5px).

### Motion

Motion **serves comprehension, not delight.**

- `--dur-micro 120ms` — hover/active state changes
- `--dur-short 220ms` — card expand, tab swap
- `--dur-long 420ms` — page-level transitions
- `--ease-out cubic-bezier(0.16, 1, 0.3, 1)` — the default
- **No bounce. No spring. No parallax. No scroll-driven animation.** `prefers-reduced-motion` removes everything.

### Hover / press states

| Surface | Hover | Press |
|---|---|---|
| Card | `border-color: ink mute`, `box-shadow: elevated`, `transform: scale(1.01)` | `transform: scale(.99)` |
| Pill button (primary) | `transform: translateY(-1.5px)` | `transform: translateY(1px)` |
| Pill button (dark) | brightness 0.95 | brightness 0.9 |
| Nav link | `color: ink` (from `ink soft`) | — |
| Action item / list row | background darkens 5% | scale 0.98 |

### Imagery rules

- **Photography is warm, golden-hour, athletic.** Morning light, clinical-but-human moments (blood draw, dashboard review, outdoor run, video consult).
- **EU faces in EU cities.** Names + cities are explicit in testimonials (Lisbon, Berlin, Amsterdam).
- **No stock smiles at the camera.** Subjects are mid-action or in profile.
- **No illustrations.** No decorative SVGs. No hand-drawn icons. No emoji.
- **The product itself is the dominant visual.** The dashboard card mockup is the hero on the homepage — not a photo of a phone, not a 3D render.
- **Full-bleed dark sections** (the pricing block) carry a `radial-gradient` ambient coral glow. This is the **only** gradient permitted in the system besides the GLI conic ring.

### Transparency and blur

- The **nav pill** uses `backdrop-filter: blur(18–20px) saturate(140–160%)` over a 86% paper background. This is the brand's only persistent blur surface.
- The **pricing card** on the dark hero uses a "liquid glass" treatment: `backdrop-filter: blur(32px) saturate(160%)`, `linear-gradient(135deg, rgba(255,255,255,.14), rgba(255,255,255,.06))`, with `inset 0 1px 0 rgba(255,255,255,.32)` for an inner edge highlight. Used sparingly — once per page.

### Layout patterns

- **Sticky pill nav** on a `radius-full` capsule, centered, with translucent paper background.
- **Hero with split copy + product card.** Dashboard mockup lives in the hero, not a photo.
- **Number-prefix step rows.** Steps use giant `01 / 02 / 03 / 04` numerals in `brandSoft` tint as decorative wayfinding.
- **3×3 bento + 10th full-width "optional" cell.** The biomarker grid uses 9 standard cells plus a wide dark "Optional WGS" cell.
- **Sticky-left + scrolling-right two-column** for FAQ and value-comparison sections.
- **Alternating photo / copy rows** for "How it works", each 500px min-height.

### Dashboard-specific motifs

- **GLI conic ring.** A 120–160px radial gauge — the *only* multi-stop gradient in the system. Stops: `optimal → critical → moderate → border-subtle` between fixed angles.
- **Risk encoding on cards is done in the pill + score, NEVER on the card edge.** A top-left `.pill` with `background: <risk-color> / 0.10–0.12` + saturated text. The score itself takes the same color when severity matters. No `border-left: 4px solid` accent strips.
- **Tier badges.** Tier 1 Established (green), Tier 2 Emerging (blue), Tier 3 Investigational (muted). Always paired with a text label, never color-only.
- **Tabular-nums everywhere.** Every score, percentile, marker count, currency value.

### Anti-patterns (banned)

From `DESIGN.md` §0.5 and reinforced here:

- **Colored left-border accent cards.** Banned everywhere. This is the AI-tell pattern. Risk and category are encoded via a top-left pill badge, a monospace eyebrow, and the score color — not by painting one edge of the card.
- Aggressive gradient backgrounds (only the GLI conic ring + the one dark-hero ambient glow are allowed)
- Glassmorphism beyond the nav pill and pricing card
- Emoji in product or marketing copy
- Decorative SVG illustrations
- Stock-photo "hero with smiling person at desk"
- Rainbow palettes / multiple semantic colors competing for attention
- Vague labels ("Insights", "Growth", "Scale") without data behind them

---

## Iconography

**The brand barely uses icons.** The marketing site has effectively no icon system — wayfinding is done with **numeric prefixes** (`01 / 02 / 03 / 04`), monospace metadata, hairline dividers, and `+` / arrow glyphs typed as text. The dashboard uses **emoji-as-category-icon** in a few category cards (see screenshot: 🌿 / 💊 / 🌙 / ⭐ / 🩺), which is the one exception, but each is paired with a text label and the emoji is decorative rather than load-bearing.

### Implementation guidance

| Use case | How to render it |
|---|---|
| **Plus / add** | Unicode `+` styled in `font-mono`, brand color, 18–22px |
| **Right arrow** | Unicode `→` typed inline, used in inline links ("→ 2 recommended actions") |
| **Bullet status dot** | 6–10px `border-radius: 999` div with semantic color background |
| **Brand mark** | Inline SVG: `<rect width="28" height="28" rx="6" fill="ink"><text fontFamily="Fraunces" fill="brand">23</text>` — used in `Logo` component (see `assets/logo-mark.svg`) |
| **Checkmark in lists** | Coral filled circle with white `+` (DOM `<span style="background:brand; color:#fff">+</span>`) — see the price card |
| **Tier / status badge** | Pill with `radius-full`, `text-label` uppercase 10–11px, semantic color at 12% opacity background + full saturation text |
| **Wordmark** | Plain text "foreverbetter" in DM Sans 700, letter-spacing `-0.025em`, coral on `better`. Never break across lines. |

### If you must add an icon set

The brand has no built-in icon font or sprite. If a design genuinely needs more iconography, link **Lucide** (`https://unpkg.com/lucide@latest`) at 1.5–1.75 stroke width and `currentColor` — its hairline geometric style matches the brand. **Flag the substitution to the user** and document it on the page so it can be reviewed.

Never:
- Use Heroicons solid (too heavy)
- Use Font Awesome (style mismatch)
- Draw custom icon SVGs from scratch in a design
- Use emoji as load-bearing UI (the dashboard category emoji are the only exception and even those are decorative)

---

## Index

| Path | Purpose |
|---|---|
| `README.md` | You are here — content + visual foundations. |
| `SKILL.md` | Skill manifest for Claude Code / Agent Skills. |
| `colors_and_type.css` | Full token export — drop in via `<link>` or `@import`. Loads all five webfonts. |
| `assets/logo-mark.svg` · `logo-wordmark.svg` · `logo-wordmark-inverse.svg` | Wordmark — DM Sans, coral on `better`. |
| `fonts/README.md` | Notes on the Google Fonts CDN setup. |
| **`preview/` — design system cards** | |
| Brand → `brand-logo` · `brand-iconography` · `brand-photography` · `voice-microcopy` | Identity + decision cards. |
| Colors → `color-brand` · `color-neutrals` · `color-semantic` · `color-dark-mode` | Palettes light + dark. |
| Type → `type-display` · `type-body` · `type-mono` | Specimens. |
| Spacing → `spacing-scale` · `radii-shadows` · `pattern-motion` | Layout + motion. |
| Components → `buttons` · `badges` · `form-inputs` · `component-tabs` · `component-tooltip` · `component-modal` · `component-alert` · `component-nav-pill` · `component-trait-card` · `component-insight-card` · `component-gli-ring` · `lab-result-row` · `state-empty` · `state-loading` · `state-error` · `pattern-pricing-table` · `pattern-footer` · `pattern-findings-cells` · `pattern-step-row` · `pattern-email` | Building blocks. |
| **UI kits** | |
| `ui_kits/website/` | Marketing site recreation (Hero, Steps, Bento, Pricing, FAQ, Footer + checkout modal). |
| `ui_kits/dashboard/` | Genomic dashboard (Overview / Categories / Protocols / Variants tabs). |
| `_research/` | Reference screenshots from legacy source. |

## Iterate with me

This system is a **working brief**, not a finished spec. If anything feels off — copy tone, accent saturation, where the line between "marketing warm" and "product clinical" sits — tell me and I'll tighten it.
