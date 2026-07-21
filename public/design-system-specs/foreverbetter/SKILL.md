---
name: foreverbetter-design
description: Use this skill to generate well-branded interfaces and assets for foreverbetter, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc.), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick orientation

foreverbetter is a European biomarker-first wellness membership with an optional open-source genomic dashboard. Two surfaces, one brand. (Legacy codebases still say "23longevity" — that's the previous working name; brand-facing copy uses **foreverbetter**.)

- **Marketing site** — Fraunces (serif display) + DM Sans + DM Mono on warm paper. Coral red `#df1e39` brand accent. Editorial.
- **Product / dashboard** — Plus Jakarta Sans + JetBrains Mono on near-white. Same coral accent. Clinical.

## Files at a glance

- `README.md` — full brand brief: voice, content rules, visual foundations, iconography, anti-patterns
- `SKILL.md` — this file
- `colors_and_type.css` — drop-in token sheet; loads webfonts; defines every CSS custom property
- `assets/logo-mark.svg`, `logo-wordmark.svg`, `logo-wordmark-inverse.svg` — current placeholder marks (the brand is exploring health-coded alternatives — see `preview/brand-logo.html` for active directions)
- `preview/*.html` — small specimen cards (palette swatches, type ladder, component samples)
- `ui_kits/website/` — Fraunces+DM Sans marketing-site recreation, click-thru, with Hero/Steps/Bento/Pricing/FAQ/Footer
- `ui_kits/dashboard/` — Plus Jakarta dashboard recreation with tab nav, GLI hero, category grid, action plan, protocols
- `fonts/README.md` — note: fonts are loaded from Google Fonts CDN; drop local files here if you need offline embedding

## Hard rules (do these every time)

1. **Use `colors_and_type.css`.** Link or `@import` it; don't redefine tokens.
2. **Brand color is sacred.** `#df1e39` (= `oklch(58% 0.22 22)`). One single primary CTA color. One single chart-highlight color. Never decorative.
3. **Tabular nums on every number.** `font-variant-numeric: tabular-nums` on scores, prices, percentages, currencies.
4. **Sentence case for copy.** "Become a Member" is the lone Title-Cased CTA. No exclamation marks. No emoji. Brand is `foreverbetter` lowercase, one word; the wordmark accents `better` in coral.
5. **No colored left-border accent cards.** Risk encoded via top-left pill badge + score color. Banned everywhere, including dashboard.
6. **One gradient maximum per surface.** The Whoop-style ring (single-color arc on a track) for the GLI score. The ambient coral glow on the dark pricing block. Nothing else.
7. **Hairlines, not shadows.** `1px solid #e6e1d8` is the default depth. Shadows are a hint.
8. **Always include the medical disclaimer** in any complete page or deliverable. Verbatim from `README.md`.
9. **No invented metrics.** Sample data is fine if labelled, but don't fabricate plausible-looking scores in production-feeling artifacts.

## Choosing the type stack

| Surface | Stack |
|---|---|
| Marketing pages, decks, landing pages, blog | Fraunces + DM Sans + DM Mono |
| Product UI, dashboard, settings, in-app | Plus Jakarta Sans + JetBrains Mono |

Both stacks are loaded by `colors_and_type.css`. Switch by overriding `--font-display` / `--font-body` / `--font-mono` in your scoped `:root`.

## Component vocabulary

- **Pill button** (`border-radius: 9999px`, primary coral or dark ink) is the brand's button shape.
- **In-card CTA** (`radius-sm` 5px) is the only square-cornered button.
- **Mono eyebrow** with leading hairline (`::before { content:""; width:20px; height:1px; background: var(--color-ink-mute) }`) for category cues on insight cards.
- **Risk pill** at the top-left of trait/action cards: `oklch(<hue>% / 0.10)` background, full-saturation text, leading dot.
- **Whoop-style ring** for the GLI score: thin track + single-color rounded arc keyed to status (optimal / moderate / critical), big tabular-nums score, mono caps label.
- **Giant brand-soft numerals** (`color: #fce8eb`, `font-weight: 300`) as decorative wayfinding on marketing step rows.
- **Findings cells**: tabular-mono value, two-line mute label, hairline border, equal-width grid.

See `preview/` for specimens of each and `ui_kits/` for them composed into a full page.

## Common asks → starting points

| User asks | Start from |
|---|---|
| "Make a landing page" | `ui_kits/website/index.html` — fork sections you need |
| "Make a settings screen / member portal" | `ui_kits/dashboard/index.html` — fork the nav + section primitives |
| "Make a pitch deck" | Use `colors_and_type.css`, the dark pricing block as the section-divider style, and the marketing voice. Slide titles in Fraunces 56–80px. |
| "Make an icon set" | Don't draw SVGs from scratch. Link Lucide at 1.5–1.75 stroke or ask the user for assets. |
| "Make the homepage hero" | Copy the Hero + DashboardCard from `ui_kits/website/`. Replace the photo bg gradient with real warm golden-hour photography if available. |

## Anti-patterns (instant rejects)

- Colored left-border accent cards
- Bluish-purple gradients
- Emoji cards
- Decorative SVG illustrations
- Rounded buttons with `0 4px 20px rgba(blue,*,*,0.2)` glow
- Stock "smiling person at desk"
- "Insights / Growth / Scale" labels without numbers behind them
- AI-generated faces / portraits
- Multiple competing semantic colors on one screen

If you're tempted by any of the above, stop and re-read `README.md`'s Visual Foundations section.
