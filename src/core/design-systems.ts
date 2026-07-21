// Design systems for health & wellness UIs.
//
// A curated library of design-token sets so a developer or agent building a
// wellness product can style a UI quickly. Each system is *inspired by* the
// public aesthetic of a well-known health app, but the values here are our own
// encoding using open/system fonts - no proprietary assets, screenshots, or
// third-party design data are reproduced. Apps are credited as inspiration only.

export interface TypeStyle {
  size: string;
  line_height: string;
  weight: number;
  letter_spacing?: string;
}

export interface DesignMetricSpec {
  id: string;
  label: string;
  modality: "wearables" | "biomarkers" | "genetics" | "health-context";
  priority: "hero" | "primary" | "secondary" | "context";
  format: string;
  preferred_visual: string;
  highlight_reason: string;
  states: string[];
}

export interface DesignModalitySection {
  id: string;
  label: string;
  modality: "wearables" | "biomarkers" | "genetics" | "health-context";
  purpose: string;
  component: string;
  required_fields: string[];
  optional_fields: string[];
  empty_state: string;
  responsive_behavior: string;
}

export interface DesignAnimationSpec {
  id: string;
  trigger: string;
  motion: string;
  duration: string;
  reduced_motion: string;
}

export interface DesignActionPlanSpec {
  title: string;
  voice: string;
  ranking: string;
  cadence: string[];
  item_fields: string[];
  stages: string[];
  safety_boundary: string;
}

export interface DesignDataCaptureSpec {
  identity_fields: string[];
  provenance_fields: string[];
  modality_fields: Record<
    "wearables" | "biomarkers" | "genetics" | "health-context",
    string[]
  >;
  freshness_rule: string;
  missing_data_rule: string;
}

export interface DesignResponsiveSpec {
  breakpoints: string[];
  desktop: string;
  tablet: string;
  mobile: string;
}

export interface DesignSystem {
  id: string;
  name: string;
  inspired_by: string;
  vibe: string;
  best_for: string[];
  color_scheme: "light" | "dark";
  colors: {
    background: string;
    surface: string;
    surface_alt: string;
    border: string;
    text: string;
    text_muted: string;
    primary: string;
    on_primary: string;
    accent: string;
    positive: string;
    warning: string;
    negative: string;
    data_viz: string[];
    gradient?: string;
  };
  typography: {
    font_display: string;
    font_body: string;
    font_mono?: string;
    google_fonts: string[];
    scale: Record<
      "display" | "title" | "heading" | "body" | "label" | "caption",
      TypeStyle
    >;
  };
  spacing: { base_px: number; scale_px: number[] };
  radii: { sm: string; md: string; lg: string; pill: string };
  elevation: string[];
  motion: {
    duration: Record<"fast" | "base" | "slow", string>;
    easing: Record<"standard" | "entrance" | "exit", string>;
  };
  components: Record<
    string,
    { description: string; css: Record<string, string> }
  >;
  // Layout identity: each system renders a STRUCTURALLY different dashboard, not
  // just a recolor. This tells a client which hero component, section order, and
  // voice to use so the presentation matches the design (a WHOOP-style board
  // looks different from an Oura-style one). Mirrors the reference renderer in
  // the open-source analyze-longevity skill.
  layout?: DesignLayout;
  metrics?: DesignMetricSpec[];
  modality_sections?: DesignModalitySection[];
  animations?: DesignAnimationSpec[];
  action_plan?: DesignActionPlanSpec;
  data_capture?: DesignDataCaptureSpec;
  responsive?: DesignResponsiveSpec;
}

export interface DesignLayout {
  hero:
    | "score-ring"
    | "dual-gauge"
    | "apex-readiness"
    | "lab-table"
    | "zone-bar"
    | "card-grid"
    | "breathing-orb"
    | "gli-index"
    | "healthspan-performance"
    | "aperture-overview";
  score_word: string;
  voice:
    | "editorial"
    | "coach"
    | "clinical"
    | "data"
    | "system"
    | "calm"
    | "dossier";
  sections: string[];
  summary: string;
}

const LAYOUTS: Record<string, DesignLayout> = {
  foreverbetter: {
    hero: "gli-index",
    score_word: "Healthspan",
    voice: "dossier",
    sections: [
      "index-hero",
      "modality-coverage",
      "biomarker-panel",
      "superpowers",
      "polygenic-risk",
      "aging-hallmarks",
      "clinician-context",
      "action-plan",
    ],
    summary:
      "The full wellnizz Healthspan dossier: a composite Genomic Longevity Index hero, every connected modality (biomarkers, wearables, genetics), genetic superpowers, polygenic risk, aging hallmarks, pharmacogenomic context, and the complete action plan - in an editorial dossier voice.",
  },
  "ring-data": {
    hero: "score-ring",
    score_word: "Readiness",
    voice: "editorial",
    sections: ["ring-hero", "balance-tiles", "gentle-plan"],
    summary: "Circular readiness ring, three balance tiles, gentle next steps.",
  },
  performance: {
    hero: "dual-gauge",
    score_word: "Recovery",
    voice: "coach",
    sections: [
      "today-hero",
      "recovery-strain-gauges",
      "sleep-performance",
      "health-monitor",
      "stress-monitor",
      "activity-load",
      "biomarker-context",
      "genetic-context",
      "health-context",
      "action-plan",
      "data-provenance",
    ],
    summary:
      "A WHOOP-style training board: recovery, sleep, and strain lead the day; health-monitor and stress signals explain the score; biomarkers, genetics, and health context add slower-moving context; FOCUS turns the signal into an actionable plan.",
  },
  apex: {
    hero: "apex-readiness",
    score_word: "Readiness",
    voice: "coach",
    sections: [
      "apex-header",
      "readiness-hero",
      "insight-banner",
      "health-monitor",
      "daily-outlook",
      "action-plan",
      "genomic-index",
      "wearable-detail",
      "biomarker-age",
      "data-provenance",
    ],
    summary:
      "APEX is a dark healthspan command centre: a three-ring readiness hero (sleep, recovery, strain), an observation-led insight and monitor grid, then focused actions and expandable genomics, wearable, and biomarker context. The information hierarchy stays stable as more modalities connect.",
  },
  meridian: {
    hero: "healthspan-performance",
    score_word: "Health context",
    voice: "coach",
    sections: [
      "healthspan-readiness",
      "wearable-performance",
      "source-status",
      "agent-context",
      "action-plan",
      "data-provenance",
    ],
    summary:
      "A dark, data-forward healthspan workspace: live connection readiness leads, WHOOP recovery, strain, and sleep are the primary performance channel, and every result remains explicitly bound to source freshness and provenance.",
  },
  "clinical-modern": {
    hero: "lab-table",
    score_word: "Healthspan",
    voice: "clinical",
    sections: ["summary-stat", "panel-table", "priorities"],
    summary:
      "Biomarker table with reference-range bars and a flagged-marker count.",
  },
  metabolic: {
    hero: "zone-bar",
    score_word: "Metabolic",
    voice: "data",
    sections: ["zone-hero", "metric-chips", "protocol"],
    summary: "Time-in-range zone bar, metric chips, a protocol.",
  },
  "system-cards": {
    hero: "card-grid",
    score_word: "Overall",
    voice: "system",
    sections: ["category-card-grid", "suggestions"],
    summary: "Rounded category-card grid.",
  },
  serene: {
    hero: "breathing-orb",
    score_word: "Balance",
    voice: "calm",
    sections: ["orb-hero", "one-insight", "minimal-plan"],
    summary: "Single breathing-orb hero, one insight at a time.",
  },
  aperture: {
    hero: "aperture-overview",
    score_word: "Energy",
    voice: "coach",
    sections: [
      "day-brief",
      "energy-score",
      "activity-and-sleep",
      "health-pillars",
      "health-record",
      "action-plan",
    ],
    summary:
      "A calm, optimistic daily health overview: one conversational insight and a real-data energy signal lead, then activity, sleep, the five health pillars, health-record detail, and an actionable next step.",
  },
};

const SYSTEMS: DesignSystem[] = [
  {
    id: "foreverbetter",
    name: "ForeverBetter",
    inspired_by: "ForeverBetter",
    vibe: 'The house design. A warm-paper editorial "Healthspan Dossier": near-black ink on soft paper, Plus Jakarta Sans for the interface, a single coral accent, and a composite Genomic Longevity Index at the top. Reads like a clinical report with heart, not a dashboard widget factory. The full multimodal board - biomarkers, wearables, genetics, superpowers, action plan.',
    best_for: [
      "full multimodal longevity reports",
      "composite healthspan index dashboards",
      "editorial/clinical-style health dossiers",
    ],
    color_scheme: "light",
    colors: {
      background: "#f6f3ee",
      surface: "#fbf9f5",
      surface_alt: "#f1ede5",
      border: "#e6e1d8",
      text: "#0e0e0e",
      text_muted: "#7a7770",
      primary: "#df1e39",
      on_primary: "#ffffff",
      accent: "#2f5b9e",
      positive: "#1e7a52",
      warning: "#b0791f",
      negative: "#c0223a",
      data_viz: ["#df1e39", "#2f5b9e", "#1e7a52", "#b0791f", "#6d4aa8"],
      gradient: "linear-gradient(180deg, #fbf9f5, #f6f3ee)",
    },
    typography: {
      font_display: '"Fraunces", "Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
      font_body: '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
      font_mono: '"JetBrains Mono", "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      google_fonts: [
        "Fraunces:opsz,wght@9..144,100..900",
        "Plus+Jakarta+Sans:wght@400;500;600;700",
        "DM+Sans:opsz,wght@9..40,100..1000",
        "JetBrains+Mono:wght@400;500",
      ],
      scale: {
        display: {
          size: "60px",
          line_height: "1.0",
          weight: 600,
          letter_spacing: "-0.02em",
        },
        title: {
          size: "30px",
          line_height: "1.1",
          weight: 600,
          letter_spacing: "-0.01em",
        },
        heading: { size: "18px", line_height: "1.3", weight: 600 },
        body: { size: "15px", line_height: "1.6", weight: 400 },
        label: {
          size: "11px",
          line_height: "1.4",
          weight: 600,
          letter_spacing: "0.08em",
        },
        caption: { size: "11px", line_height: "1.4", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 24, 32, 48, 72] },
    radii: { sm: "6px", md: "12px", lg: "20px", pill: "999px" },
    elevation: [
      "none",
      "0 1px 2px rgba(20,16,10,0.06)",
      "0 24px 60px -28px rgba(20,16,10,0.30)",
    ],
    motion: {
      duration: { fast: "140ms", base: "280ms", slow: "560ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0.16,1,0.3,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      gli_dial: {
        description:
          "The hero: a tick-marked semicircular dial for the composite Genomic Longevity Index (0-100), number set large in Schibsted Grotesk.",
        css: {
          "stroke-width": "14px",
          "stroke-linecap": "round",
          color: "#df1e39",
          "font-family": '"Schibsted Grotesk", sans-serif',
        },
      },
      modality_chip: {
        description:
          'Data-provenance chip naming a connected modality and its signal count (e.g. "42 blood · 27 wearable").',
        css: {
          border: "1px solid #e6e1d8",
          "border-radius": "999px",
          padding: "6px 12px",
          "font-size": "12px",
          color: "#7a7770",
        },
      },
      superpower_card: {
        description:
          'A genetic superpower call-out card: gene, what it grants, and how rare it is. Green-left-border with positive framing.',
        css: {
          background: "#fbf9f5",
          border: "1px solid #e6e1d8",
          "border-left": "3px solid #1e7a52",
          "border-radius": "12px",
          padding: "18px",
        },
      },
      primary_button: {
        description: "Coral editorial action button, lightly rounded.",
        css: {
          background: "#df1e39",
          color: "#ffffff",
          "border-radius": "8px",
          "font-weight": "600",
          padding: "13px 22px",
        },
      },
    },
  },
  {
    id: "ring-data",
    name: "Ring Data",
    inspired_by: "Oura",
    vibe: "Calm, premium, dark. Circular readiness/score data on a near-black canvas with a warm metallic accent and an elegant serif for numbers.",
    best_for: [
      "sleep & readiness scores",
      "circular/ring data viz",
      "daily wellness summaries",
    ],
    color_scheme: "dark",
    colors: {
      background: "#0d0e12",
      surface: "#16181f",
      surface_alt: "#1e212b",
      border: "rgba(255,255,255,0.08)",
      text: "#f2f0ea",
      text_muted: "#9a978d",
      primary: "#d4b483",
      on_primary: "#1a1408",
      accent: "#4ecdc4",
      positive: "#5ec98c",
      warning: "#e6b450",
      negative: "#e06c6c",
      data_viz: ["#d4b483", "#4ecdc4", "#e28f6b", "#9b8cce", "#6ea8d8"],
      gradient: "linear-gradient(160deg, #16181f, #0d0e12)",
    },
    typography: {
      font_display: '"Fraunces", "Times New Roman", serif',
      font_body: '"Inter", system-ui, sans-serif',
      font_mono: '"DM Mono", ui-monospace, monospace',
      google_fonts: [
        "Fraunces:opsz,wght@9..144,400;9..144,600",
        "Inter:wght@400;500;600",
        "DM+Mono:wght@400;500",
      ],
      scale: {
        display: {
          size: "56px",
          line_height: "1.0",
          weight: 500,
          letter_spacing: "-0.02em",
        },
        title: {
          size: "28px",
          line_height: "1.15",
          weight: 500,
          letter_spacing: "-0.01em",
        },
        heading: { size: "18px", line_height: "1.3", weight: 600 },
        body: { size: "15px", line_height: "1.6", weight: 400 },
        label: {
          size: "12px",
          line_height: "1.4",
          weight: 600,
          letter_spacing: "0.04em",
        },
        caption: { size: "11px", line_height: "1.4", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 24, 32, 48, 64] },
    radii: { sm: "8px", md: "16px", lg: "24px", pill: "999px" },
    elevation: [
      "none",
      "0 8px 24px -12px rgba(0,0,0,0.6)",
      "0 20px 50px -20px rgba(0,0,0,0.7)",
    ],
    motion: {
      duration: { fast: "120ms", base: "240ms", slow: "480ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0,0,0.2,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      score_ring: {
        description:
          "Large circular progress ring for a single 0-100 score, number set in the display serif.",
        css: {
          "stroke-width": "10px",
          "stroke-linecap": "round",
          color: "#d4b483",
        },
      },
      metric_tile: {
        description:
          "Rounded surface tile with a label, big value, and small delta.",
        css: {
          background: "#16181f",
          border: "1px solid rgba(255,255,255,0.08)",
          "border-radius": "16px",
          padding: "20px",
        },
      },
      primary_button: {
        description: "Warm metallic pill button.",
        css: {
          background: "#d4b483",
          color: "#1a1408",
          "border-radius": "999px",
          "font-weight": "600",
          padding: "12px 20px",
        },
      },
    },
  },
  {
    id: "performance",
    name: "Performance",
    inspired_by: "WHOOP",
    vibe: "High-contrast dark for athletes. A complete daily board: three headline scores, an emerald healthspan orb, dense monitor tiles, stress/activity context, and a direct FOCUS plan. Bold condensed headings and strain/recovery color coding map green→yellow→red without sacrificing the slower biomarker, genetics, or human-context layers.",
    best_for: [
      "full multimodal performance dashboards",
      "strain & recovery",
      "training load dashboards",
      "performance/HRV apps",
    ],
    color_scheme: "dark",
    colors: {
      background: "#0a0a0a",
      surface: "#151515",
      surface_alt: "#1f1f1f",
      border: "rgba(255,255,255,0.10)",
      text: "#ffffff",
      text_muted: "#8a8a8a",
      primary: "#16ec8f",
      on_primary: "#04180f",
      accent: "#0093e9",
      positive: "#16ec8f",
      warning: "#ffde5a",
      negative: "#ff4d4d",
      data_viz: ["#16ec8f", "#ffde5a", "#ff4d4d", "#0093e9", "#b06cff"],
      gradient: "linear-gradient(135deg, #0093e9, #16ec8f)",
    },
    typography: {
      font_display: '"Archivo", "Arial Narrow", sans-serif',
      font_body: '"Inter", system-ui, sans-serif',
      font_mono: '"Roboto Mono", ui-monospace, monospace',
      google_fonts: [
        "Archivo:wght@600;700;800",
        "Inter:wght@400;500;600",
        "Roboto+Mono:wght@400;500",
      ],
      scale: {
        display: {
          size: "52px",
          line_height: "0.95",
          weight: 800,
          letter_spacing: "-0.02em",
        },
        title: {
          size: "26px",
          line_height: "1.1",
          weight: 700,
          letter_spacing: "-0.01em",
        },
        heading: {
          size: "16px",
          line_height: "1.25",
          weight: 700,
          letter_spacing: "0.02em",
        },
        body: { size: "14px", line_height: "1.55", weight: 400 },
        label: {
          size: "11px",
          line_height: "1.3",
          weight: 700,
          letter_spacing: "0.08em",
        },
        caption: { size: "11px", line_height: "1.3", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 20, 32, 40, 56] },
    radii: { sm: "4px", md: "8px", lg: "14px", pill: "999px" },
    elevation: [
      "none",
      "0 4px 16px -8px rgba(0,0,0,0.7)",
      "0 16px 40px -16px rgba(0,0,0,0.8)",
    ],
    motion: {
      duration: { fast: "100ms", base: "200ms", slow: "360ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0.2,0.8,0.2,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      strain_bar: {
        description:
          "Segmented horizontal bar coloring load across recovery zones.",
        css: {
          height: "8px",
          "border-radius": "4px",
          background: "linear-gradient(90deg,#16ec8f,#ffde5a,#ff4d4d)",
        },
      },
      stat_block: {
        description: "Uppercase label + big mono value on a flat dark surface.",
        css: {
          background: "#151515",
          "border-radius": "8px",
          padding: "16px 18px",
        },
      },
      recovery_gauge: {
        description:
          "Semicircular tick-marked gauge for recovery/readiness; green is available capacity, yellow is caution, red is depleted.",
        css: {
          "stroke-width": "15px",
          "stroke-linecap": "round",
          "track-color": "#1f1f1f",
          "value-gradient": "linear-gradient(90deg,#ff4d4d,#ffde5a,#16ec8f)",
        },
      },
      strain_gauge: {
        description:
          "Semicircular blue-to-violet gauge for cardiovascular and training load; never present strain as a health grade.",
        css: {
          "stroke-width": "15px",
          "stroke-linecap": "round",
          "value-gradient": "linear-gradient(90deg,#0093e9,#b06cff)",
        },
      },
      sleep_gauge: {
        description:
          "Sleep performance gauge with sleep need, duration, debt, and consistency shown beneath the score.",
        css: {
          "stroke-width": "15px",
          "stroke-linecap": "round",
          "value-gradient": "linear-gradient(90deg,#6ea8d8,#16ec8f)",
        },
      },
      healthspan_orb: {
        description:
          "Optional dark hero orb for a long-horizon healthspan/pace-of-aging insight; particles drift slowly behind a single legible number.",
        css: {
          width: "min(360px,72vw)",
          "aspect-ratio": "1",
          "border-radius": "50%",
          background:
            "radial-gradient(circle at 50% 48%,rgba(22,236,143,.25),rgba(22,236,143,.04) 48%,transparent 70%)",
          filter: "drop-shadow(0 0 28px rgba(22,236,143,.18))",
        },
      },
      monitor_tile: {
        description:
          "Dense health-monitor tile for one physiological signal, its value, baseline range, and freshness/provenance.",
        css: {
          background: "#151515",
          border: "1px solid rgba(255,255,255,.10)",
          "border-radius": "8px",
          padding: "16px",
          "min-height": "112px",
        },
      },
      trend_sparkline: {
        description:
          "Small baseline-relative sparkline used beside monitor values; label the window and never imply clinical precision.",
        css: {
          width: "92px",
          height: "28px",
          stroke: "#0093e9",
          "stroke-width": "2px",
          fill: "none",
        },
      },
      stress_band: {
        description:
          "Low/moderate/high stress state with a time-of-day marker and a plain-language contributor.",
        css: {
          height: "8px",
          "border-radius": "4px",
          background:
            "linear-gradient(90deg,#16ec8f 0 33%,#ffde5a 33% 66%,#ff4d4d 66%)",
        },
      },
      activity_timeline: {
        description:
          "Chronological training/activity strip showing duration, strain contribution, and recovery cost.",
        css: {
          border: "1px solid rgba(255,255,255,.10)",
          "border-radius": "8px",
          padding: "14px 16px",
        },
      },
      focus_item: {
        description:
          "Numbered FOCUS action with why-now, one to three steps, expected check-in, and source evidence.",
        css: {
          "border-left": "3px solid #16ec8f",
          padding: "12px 0 12px 16px",
        },
      },
      source_chip: {
        description:
          "Compact provenance chip naming source, time window, signal count, and sync freshness.",
        css: {
          border: "1px solid rgba(255,255,255,.10)",
          "border-radius": "999px",
          padding: "6px 12px",
          "font-size": "11px",
        },
      },
      primary_button: {
        description: "Recovery-green action button, slightly sharp.",
        css: {
          background: "#16ec8f",
          color: "#04180f",
          "border-radius": "8px",
          "font-weight": "700",
          "text-transform": "uppercase",
          padding: "12px 18px",
        },
      },
    },
    responsive: {
      breakpoints: ["<=720px mobile", "721-1024px tablet", ">1024px desktop"],
      desktop:
        "Three hero gauges in one row; health-monitor metrics in a 2–3 column grid; biomarker/genetic context follows below the live wearable signal; action plan remains visible without scrolling back to the hero.",
      tablet:
        "Keep the hero gauges in two rows; use two-column monitor and modality cards; keep section headers and provenance chips sticky within their region.",
      mobile:
        "Stack recovery, sleep, and strain in that order; switch monitor tiles to one column; keep values left-aligned with sparklines right-aligned; collapse optional genetics and long explanations behind disclosure rows.",
    },
    metrics: [
      {
        id: "recovery_score",
        label: "Recovery",
        modality: "wearables",
        priority: "hero",
        format: "0–100 score",
        preferred_visual: "recovery_gauge",
        highlight_reason:
          "Sets the day’s available capacity and the safest training posture.",
        states: ["green available", "yellow caution", "red depleted"],
      },
      {
        id: "sleep_performance",
        label: "Sleep performance",
        modality: "wearables",
        priority: "hero",
        format: "percentage + duration",
        preferred_visual: "sleep_gauge",
        highlight_reason:
          "Explains recovery through sleep need coverage, debt, and consistency.",
        states: ["complete", "partial", "insufficient", "missing"],
      },
      {
        id: "strain",
        label: "Strain",
        modality: "wearables",
        priority: "hero",
        format: "0–21 load score",
        preferred_visual: "strain_gauge",
        highlight_reason:
          "Shows training load in context of current recovery, not as a standalone goal.",
        states: ["easy", "productive", "high", "unavailable"],
      },
      {
        id: "hrv",
        label: "HRV",
        modality: "wearables",
        priority: "primary",
        format: "ms vs personal baseline",
        preferred_visual: "trend_sparkline",
        highlight_reason:
          "A baseline-relative recovery signal; avoid population ranking.",
        states: [
          "above baseline",
          "within baseline",
          "below baseline",
          "missing",
        ],
      },
      {
        id: "resting_heart_rate",
        label: "Resting heart rate",
        modality: "wearables",
        priority: "primary",
        format: "bpm vs personal baseline",
        preferred_visual: "monitor_tile",
        highlight_reason:
          "Adds cardiovascular recovery and illness-load context.",
        states: ["within baseline", "elevated", "low", "missing"],
      },
      {
        id: "respiratory_rate",
        label: "Respiratory rate",
        modality: "wearables",
        priority: "primary",
        format: "breaths/min vs baseline",
        preferred_visual: "monitor_tile",
        highlight_reason:
          "Useful for trend and recovery context when it moves away from baseline.",
        states: ["within baseline", "elevated", "low", "missing"],
      },
      {
        id: "blood_oxygen",
        label: "Blood oxygen",
        modality: "wearables",
        priority: "secondary",
        format: "percentage",
        preferred_visual: "monitor_tile",
        highlight_reason:
          "A context signal with a clear source and measurement-quality note.",
        states: ["within range", "watch", "missing"],
      },
      {
        id: "skin_temperature",
        label: "Skin temperature",
        modality: "wearables",
        priority: "secondary",
        format: "delta from baseline",
        preferred_visual: "monitor_tile",
        highlight_reason:
          "Highlights deviation from personal baseline rather than a universal target.",
        states: [
          "near baseline",
          "above baseline",
          "below baseline",
          "missing",
        ],
      },
      {
        id: "blood_pressure",
        label: "Blood pressure",
        modality: "wearables",
        priority: "secondary",
        format: "systolic/diastolic",
        preferred_visual: "monitor_tile",
        highlight_reason:
          "Only show when the source and measurement context are explicit.",
        states: ["within target", "watch", "missing"],
      },
      {
        id: "apo_b",
        label: "ApoB",
        modality: "biomarkers",
        priority: "context",
        format: "value + unit + lab range",
        preferred_visual: "range_bar",
        highlight_reason:
          "A slower-moving cardiovascular context signal that can explain training and recovery priorities.",
        states: ["in range", "watch", "out of range", "missing"],
      },
      {
        id: "hba1c",
        label: "HbA1c",
        modality: "biomarkers",
        priority: "context",
        format: "percentage + lab range",
        preferred_visual: "range_bar",
        highlight_reason:
          "Metabolic context belongs below live recovery metrics, with collection date visible.",
        states: ["in range", "watch", "out of range", "missing"],
      },
      {
        id: "inflammation",
        label: "Inflammation",
        modality: "biomarkers",
        priority: "context",
        format: "marker set + trend",
        preferred_visual: "metric_table",
        highlight_reason:
          "Provides a retestable explanation for persistent low recovery without turning one marker into a diagnosis.",
        states: ["quiet", "watch", "elevated", "missing"],
      },
      {
        id: "training_response",
        label: "Training response",
        modality: "genetics",
        priority: "context",
        format: "evidence-graded context",
        preferred_visual: "context_card",
        highlight_reason:
          "Genetics can tune training questions but never override observed wearable or biomarker data.",
        states: [
          "supportive context",
          "mixed evidence",
          "no signal",
          "not provided",
        ],
      },
      {
        id: "daily_context",
        label: "Daily context",
        modality: "health-context",
        priority: "primary",
        format: "structured note + tags",
        preferred_visual: "context_strip",
        highlight_reason:
          "Lets the user explain illness, travel, alcohol, stress, pain, and goals that sensors cannot infer reliably.",
        states: ["captured", "partial", "not captured"],
      },
      {
        id: "stress",
        label: "Stress monitor",
        modality: "wearables",
        priority: "primary",
        format: "state + time-of-day + contributor",
        preferred_visual: "stress_band",
        highlight_reason:
          "Explains why a recovery score moved and gives the user a non-judgmental next step.",
        states: ["low", "moderate", "high", "missing"],
      },
      {
        id: "sleep_debt",
        label: "Sleep debt",
        modality: "wearables",
        priority: "primary",
        format: "minutes vs target",
        preferred_visual: "sleep_gauge",
        highlight_reason:
          "Turns sleep need into a concrete recovery decision instead of a passive score.",
        states: ["repaid", "building", "high", "missing"],
      },
      {
        id: "activity_load",
        label: "Activity load",
        modality: "wearables",
        priority: "primary",
        format: "timeline + load contribution",
        preferred_visual: "activity_timeline",
        highlight_reason:
          "Keeps training, steps, and strength visible as a sequence of choices that affect recovery.",
        states: ["easy", "productive", "high", "missing"],
      },
    ],
    modality_sections: [
      {
        id: "wearables-live",
        label: "Live wearable signal",
        modality: "wearables",
        purpose:
          "Lead with what the person can safely do today, using the latest synced recovery, sleep, strain, and baseline-relative monitor signals.",
        component: "recovery_gauge + health_monitor + activity_timeline",
        required_fields: [
          "source_provider",
          "observed_at",
          "recovery_score",
          "sleep_performance",
          "strain",
          "sync_status",
        ],
        optional_fields: [
          "hrv",
          "resting_heart_rate",
          "respiratory_rate",
          "blood_oxygen",
          "skin_temperature",
          "blood_pressure",
          "stress",
          "activities",
        ],
        empty_state:
          "Connect a wearable to unlock recovery, sleep, strain, and baseline trends. Do not fabricate a readiness score.",
        responsive_behavior:
          "Desktop uses gauges plus a dense monitor grid; mobile stacks the three headline scores then exposes monitor tiles in priority order.",
      },
      {
        id: "biomarker-context",
        label: "Biomarker context",
        modality: "biomarkers",
        purpose:
          "Add slower-moving physiological context and retestable markers beneath the live signal.",
        component: "range_bar + biomarker_table + trend_sparkline",
        required_fields: [
          "marker_id",
          "value",
          "unit",
          "collected_at",
          "reference_range",
          "provenance",
        ],
        optional_fields: [
          "previous_value",
          "optimal_range",
          "interpretation",
          "lab_name",
        ],
        empty_state:
          "No blood panel is connected. Wearable guidance still works; add biomarkers when you want a deeper context layer.",
        responsive_behavior:
          "Desktop shows a compact table with ranges; mobile turns each marker into a stacked card with value, range, delta, and next check-in.",
      },
      {
        id: "genetic-context",
        label: "Genetic context",
        modality: "genetics",
        purpose:
          "Use evidence-graded genetic findings as background context for training response, recovery, and longevity questions.",
        component: "context_card + evidence_badge",
        required_fields: [
          "finding_id",
          "trait",
          "evidence_tier",
          "source",
          "disclosure",
        ],
        optional_fields: ["gene", "rsid", "direction", "recommended_question"],
        empty_state:
          "Genetic context is optional and does not block a wearable-first dashboard.",
        responsive_behavior:
          "Keep genetics below observed signals; collapse long evidence text on mobile and always expose the source/disclosure.",
      },
      {
        id: "health-context",
        label: "Daily context",
        modality: "health-context",
        purpose:
          "Capture the human context that changes interpretation: symptoms, illness, travel, alcohol, stress, pain, schedule, goals, and perceived exertion.",
        component: "context_strip + check_in_form",
        required_fields: [
          "recorded_at",
          "context_type",
          "value_or_note",
          "source",
        ],
        optional_fields: [
          "severity",
          "duration",
          "goal_id",
          "related_activity_id",
        ],
        empty_state:
          "Add a short check-in when the dashboard misses the why behind a score.",
        responsive_behavior:
          "Use quick tags on mobile and a timeline/filterable context rail on desktop.",
      },
    ],
    animations: [
      {
        id: "hero-gauge-sweep",
        trigger: "page load or date change",
        motion:
          "Animate each semicircular gauge from empty to its value with a 60ms stagger; keep score text stable until the arc settles.",
        duration: "1200ms entrance + 60ms stagger",
        reduced_motion:
          "Render the final arc immediately and keep the value readable.",
      },
      {
        id: "healthspan-particle-orb",
        trigger: "hero visible and long-horizon insight is present",
        motion:
          "Slow, low-opacity particles orbit a green radial orb; no constant shimmer or distracting looping.",
        duration: "12–18s ambient loop",
        reduced_motion: "Use a static radial glow with no particle motion.",
      },
      {
        id: "metric-count-in",
        trigger: "metric card enters viewport",
        motion:
          "Count numeric values once, then reveal the baseline delta and freshness label.",
        duration: "360ms",
        reduced_motion: "Show the final value and delta immediately.",
      },
      {
        id: "bar-growth",
        trigger: "section enters viewport",
        motion:
          "Grow strain, sleep need, stress, and biomarker range bars from zero using the same status color.",
        duration: "480ms",
        reduced_motion: "Show the final width immediately.",
      },
      {
        id: "focus-reveal",
        trigger: "action plan enters viewport",
        motion:
          "Reveal FOCUS items in priority order with a short vertical slide; never hide the first action behind animation.",
        duration: "240ms per item",
        reduced_motion: "Render all actions immediately.",
      },
      {
        id: "source-refresh",
        trigger: "sync completes",
        motion:
          "Pulse the source chip once, update the freshness timestamp, and crossfade changed metric values.",
        duration: "200ms",
        reduced_motion: "Update values without pulsing.",
      },
    ],
    action_plan: {
      title: "Your plan",
      voice:
        "ForeverBetter voice: evidence-first, direct, and literate. Every recommendation cites the observation or variant that triggered it. Use the connected data to form a narrative arc — here is what your body is telling you, here is what to do about it. Frame actions as 'your biomarkers suggest' or 'your genetics show', never as unsupported wellness claims. Be specific about timing ('this week', 'retest in 3 months'), dosage when evidence-graded, and the expected signal to watch for improvement. Never invent certainty where the evidence is preliminary; say 'the data suggest' rather than 'the data prove'. Maintain the editorial warmth without losing clinical rigor.",
      ranking:
        "Rank by safety tier first (intervention cannot cause harm), then by expected healthspan impact, evidence quality (A→D), and actionability (can the user do this today). Observed signals outrank genetic predisposition; maintenance habits that are already working get their own section.",
      cadence: ["Now", "Today", "This week", "This month", "Retest"],
      item_fields: [
        "priority",
        "title",
        "why_now",
        "steps",
        "target_metric",
        "expected_check_in",
        "source_ids",
        "confidence",
        "safety_note",
        "status",
      ],
      stages: [
        "FOCUS: one to three evidence-backed actions for this week",
        "MAINTAIN: habits already supporting your biomarkers",
        "WATCH: what would change the recommendation",
        "RETEST: when to measure again to close the loop",
      ],
      safety_boundary: "Wellness education only. Do not diagnose or prescribe; route concerning findings to a qualified clinician. Always include the medical disclaimer.",
    },
    data_capture: {
      identity_fields: [
        "user_id",
        "display_name",
        "timezone",
        "age_band (optional)",
        "goals",
      ],
      provenance_fields: [
        "source_id",
        "source_provider",
        "integration_type",
        "observed_at",
        "collected_at",
        "synced_at",
        "freshness",
        "coverage",
        "confidence",
      ],
      modality_fields: {
        wearables: [
          "recovery_score",
          "sleep_performance",
          "sleep_duration",
          "sleep_need",
          "sleep_debt",
          "strain",
          "hrv",
          "resting_heart_rate",
          "respiratory_rate",
          "blood_oxygen",
          "skin_temperature",
          "blood_pressure",
          "stress",
          "activities",
        ],
        biomarkers: [
          "marker_id",
          "value",
          "unit",
          "collected_at",
          "reference_range",
          "optimal_range",
          "previous_value",
          "lab_name",
        ],
        genetics: [
          "finding_id",
          "trait",
          "direction",
          "evidence_tier",
          "source",
          "recommended_question",
        ],
        "health-context": [
          "recorded_at",
          "context_type",
          "value_or_note",
          "severity",
          "duration",
          "goal_id",
          "source",
        ],
      },
      freshness_rule:
        "Show the observation window and last sync beside every live score; never imply a current score when the source is stale.",
      missing_data_rule:
        "Use an explicit not-connected or not-provided state. Preserve the section order so adding a modality does not rearrange the user’s learned mental model.",
    },
  },
  {
    id: "apex",
    name: "APEX",
    inspired_by: "APEX Design System handoff",
    vibe: "A dark, technical, lightly gamified healthspan dashboard on a near-black green canvas. Archivo carries the hierarchy; JetBrains Mono carries measured values. Readiness is three circular rings, source freshness is always visible, and green / amber / red mean optimal / monitor / act. This is a user-provided source design encoded as a durable implementation contract.",
    best_for: [
      "full multimodal healthspan dashboards",
      "readiness and recovery coaching",
      "source-aware consumer health dashboards",
    ],
    color_scheme: "dark",
    colors: {
      background: "#07100C",
      surface: "#14181A",
      surface_alt: "#1C2124",
      border: "rgba(255,255,255,0.08)",
      text: "#F2F5F3",
      text_muted: "#8A938E",
      primary: "#16EC8F",
      on_primary: "#04180F",
      accent: "#4ECDC4",
      positive: "#16EC8F",
      warning: "#E6B450",
      negative: "#E8615F",
      data_viz: [
        "#16EC8F",
        "#E6B450",
        "#E8615F",
        "#4ECDC4",
        "#5AA9E6",
        "#A78BFA",
      ],
      gradient:
        "radial-gradient(900px 440px at 50% -160px, #0D1F16 0%, #07100C 72%)",
    },
    typography: {
      font_display: '"Archivo", Arial, sans-serif',
      font_body: '"Archivo", Arial, sans-serif',
      font_mono: '"JetBrains Mono", ui-monospace, monospace',
      google_fonts: [
        "Archivo:wght@400;500;600;700;800;900",
        "JetBrains+Mono:wght@400;500;700",
      ],
      scale: {
        display: {
          size: "44px",
          line_height: "1.0",
          weight: 800,
          letter_spacing: "-0.03em",
        },
        title: {
          size: "28px",
          line_height: "1.12",
          weight: 800,
          letter_spacing: "-0.02em",
        },
        heading: {
          size: "16px",
          line_height: "1.3",
          weight: 700,
          letter_spacing: "-0.01em",
        },
        body: { size: "14px", line_height: "1.55", weight: 400 },
        label: {
          size: "10px",
          line_height: "1.35",
          weight: 700,
          letter_spacing: "0.14em",
        },
        caption: { size: "11px", line_height: "1.4", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 20, 24, 32, 48, 64] },
    radii: { sm: "8px", md: "14px", lg: "22px", pill: "999px" },
    elevation: [
      "none",
      "0 8px 30px -8px rgba(0,0,0,0.70)",
      "0 0 24px -6px rgba(22,236,143,0.28)",
    ],
    motion: {
      duration: { fast: "160ms", base: "500ms", slow: "1300ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(.22,1,.36,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      apex_tab_nav: {
        description:
          "Keyboard-operable dashboard tablist for Overview, Action plan, Genomic, Wearable, and Biomarker panels. Only the selected modality panel is visible; arrow keys, Home, and End move selection and preserve focus.",
        css: {
          display: "flex",
          gap: "20px",
          overflow: "auto",
          "border-bottom": "1px solid rgba(255,255,255,.08)",
          "active-indicator": "2px solid #16EC8F",
        },
      },
      apex_readiness_ring: {
        description:
          "A 150px circular progress ring for Sleep, Recovery, or Strain. The ring uses a faint white track, tabular score, tracked label, and a source/status sublabel. Sleep is cyan, recovery amber, and strain blue.",
        css: {
          width: "150px",
          "stroke-width": "8px",
          "track-color": "rgba(255,255,255,.06)",
          "stroke-linecap": "round",
        },
      },
      apex_status_badge: {
        description:
          "Small uppercase status badge: green for optimal, amber for monitor, red for act, plus cyan evidence-tier and blue drug-response variants.",
        css: {
          "border-radius": "999px",
          padding: "4px 8px",
          "font-size": "9px",
          "letter-spacing": ".12em",
        },
      },
      apex_source_chip: {
        description:
          "Compact, square-cornered provenance chip in monospace. It identifies source, observation window or collection date, and sync freshness.",
        css: {
          background: "rgba(255,255,255,.04)",
          border: "1px solid rgba(255,255,255,.08)",
          "border-radius": "6px",
          padding: "6px 8px",
          "font-family": "JetBrains Mono",
        },
      },
      apex_monitor_tile: {
        description:
          "Dense dark monitor tile with tracked label, mono value, baseline/context line, and one colored baseline indicator.",
        css: {
          background: "#14181A",
          border: "1px solid rgba(255,255,255,.08)",
          "border-radius": "14px",
          padding: "16px",
          "min-height": "112px",
        },
      },
      apex_insight_banner: {
        description:
          "A concise observation-led insight on an accent-wash surface with a 3px left status rule. It must cite the measured signal or source.",
        css: {
          background: "#0E2018",
          "border-left": "3px solid #16EC8F",
          "border-radius": "8px",
          padding: "16px 18px",
        },
      },
      apex_range_bar: {
        description:
          "Reference-range bar with an ideal-range wash and a clear current-value marker. Use source date and unit; do not imply a clinical diagnosis.",
        css: { height: "8px", "border-radius": "999px", background: "#1C2124" },
      },
      apex_bio_age_orb: {
        description:
          "A biological-age or long-horizon healthspan orb: one legible value over a low-motion green radial glow. Render only when its method and source are available.",
        css: {
          width: "min(320px,80vw)",
          "aspect-ratio": "1",
          "border-radius": "50%",
          background:
            "radial-gradient(circle,rgba(22,236,143,.24),transparent 70%)",
        },
      },
      apex_focus_card: {
        description:
          "Numbered FOCUS action with priority/cadence, why-now, source chips, and up to three concrete next steps.",
        css: {
          "border-left": "3px solid #16EC8F",
          padding: "16px 0 16px 18px",
        },
      },
      apex_gamification_strip: {
        description:
          "Optional streak, level/XP, and weekly-progress strip. Render only from supplied progress data and never invent streaks or rewards.",
        css: {
          background: "#14181A",
          border: "1px solid rgba(255,255,255,.08)",
          "border-radius": "14px",
          padding: "14px 16px",
        },
      },
    },
    responsive: {
      breakpoints: ["<=720px mobile", "721-1024px tablet", ">1024px desktop"],
      desktop:
        "Use a sticky slim header and section tabs, three readiness rings in one row, a three-column monitor grid, and a two-column long-horizon context region. Keep source chips beside the signal they qualify.",
      tablet:
        "Allow the readiness rings to wrap while keeping their order; use two monitor columns and horizontally scroll the tabs without hiding labels.",
      mobile:
        "Keep the header compact, let tabs scroll horizontally, stack Sleep → Recovery → Strain, then single-column monitor and action cards. Respect reduced motion and keep source freshness visible without hover.",
    },
    metrics: [
      {
        id: "sleep_performance",
        label: "Sleep",
        modality: "wearables",
        priority: "hero",
        format: "percentage + duration",
        preferred_visual: "apex_readiness_ring",
        highlight_reason:
          "Sleep leads the daily readiness trio and explains recovery through need coverage, debt, and consistency.",
        states: ["optimal", "monitor", "act", "missing"],
      },
      {
        id: "recovery_score",
        label: "Recovery",
        modality: "wearables",
        priority: "hero",
        format: "0–100 score",
        preferred_visual: "apex_readiness_ring",
        highlight_reason:
          "Shows current capacity only when the wearable observation is fresh.",
        states: ["optimal", "monitor", "act", "missing"],
      },
      {
        id: "strain",
        label: "Strain",
        modality: "wearables",
        priority: "hero",
        format: "0–21 load score",
        preferred_visual: "apex_readiness_ring",
        highlight_reason:
          "Presents load in recovery context, never as a universal health grade.",
        states: ["easy", "productive", "high", "missing"],
      },
      {
        id: "hrv",
        label: "HRV",
        modality: "wearables",
        priority: "primary",
        format: "ms vs personal baseline",
        preferred_visual: "apex_monitor_tile",
        highlight_reason: "A baseline-relative recovery signal.",
        states: [
          "above baseline",
          "within baseline",
          "below baseline",
          "missing",
        ],
      },
      {
        id: "resting_heart_rate",
        label: "Resting heart rate",
        modality: "wearables",
        priority: "primary",
        format: "bpm vs personal baseline",
        preferred_visual: "apex_monitor_tile",
        highlight_reason: "Provides cardiovascular and illness-load context.",
        states: ["within baseline", "elevated", "low", "missing"],
      },
      {
        id: "stress",
        label: "Stress",
        modality: "wearables",
        priority: "primary",
        format: "state + contributor",
        preferred_visual: "apex_monitor_tile",
        highlight_reason:
          "Turns a score movement into an observation and next question.",
        states: ["low", "moderate", "high", "missing"],
      },
      {
        id: "biological_age",
        label: "Biological age",
        modality: "biomarkers",
        priority: "context",
        format: "age + method + collection date",
        preferred_visual: "apex_bio_age_orb",
        highlight_reason:
          "A long-horizon indicator shown only with method and source provenance.",
        states: ["available", "unavailable"],
      },
      {
        id: "biomarker_panel",
        label: "Blood panel",
        modality: "biomarkers",
        priority: "context",
        format: "value + unit + range + date",
        preferred_visual: "apex_range_bar",
        highlight_reason:
          "Adds measured, retestable physiological context beneath daily readiness.",
        states: ["optimal", "monitor", "act", "missing"],
      },
      {
        id: "genetic_context",
        label: "Genetic context",
        modality: "genetics",
        priority: "context",
        format: "evidence-tiered finding",
        preferred_visual: "apex_status_badge",
        highlight_reason:
          "Keeps inherited context visible without outranking observed signals.",
        states: ["supportive", "mixed", "not provided"],
      },
      {
        id: "daily_context",
        label: "Daily context",
        modality: "health-context",
        priority: "primary",
        format: "structured note + tags",
        preferred_visual: "apex_insight_banner",
        highlight_reason: "Records the human explanation sensors cannot infer.",
        states: ["captured", "partial", "missing"],
      },
    ],
    modality_sections: [
      {
        id: "wearable-readiness",
        label: "Wearable readiness",
        modality: "wearables",
        purpose:
          "Lead with sleep, recovery, strain, and baseline-relative health monitor readings with explicit source freshness.",
        component: "apex_readiness_ring + apex_monitor_tile",
        required_fields: [
          "source_provider",
          "observed_at",
          "synced_at",
          "sleep_performance",
          "recovery_score",
          "strain",
        ],
        optional_fields: [
          "hrv",
          "resting_heart_rate",
          "respiratory_rate",
          "blood_oxygen",
          "skin_temperature",
          "stress",
          "activities",
        ],
        empty_state:
          "Connect a wearable to unlock live readiness. Do not create a readiness score from missing data.",
        responsive_behavior:
          "Desktop uses three rings and a monitor grid; mobile keeps the supplied Sleep → Recovery → Strain order and one-column tiles.",
      },
      {
        id: "biomarker-age",
        label: "Biomarker context",
        modality: "biomarkers",
        purpose:
          "Show biological-age context, measured values, range bars, dates, and derived values as clearly separate from raw labs.",
        component: "apex_bio_age_orb + apex_range_bar",
        required_fields: [
          "marker_id",
          "value",
          "unit",
          "collected_at",
          "reference_range",
          "provenance",
        ],
        optional_fields: [
          "previous_value",
          "optimal_range",
          "interpretation",
          "lab_name",
          "biological_age_method",
        ],
        empty_state:
          "No blood panel is connected. Daily wearable guidance can still be useful.",
        responsive_behavior:
          "Desktop pairs the long-horizon orb with domain bars; mobile puts the orb first then stacks named value/range cards.",
      },
      {
        id: "genomic-index",
        label: "Genetic context",
        modality: "genetics",
        purpose:
          "Keep evidence-tiered gene and trait context behind the live signals, with source and disclosure visible.",
        component: "apex_status_badge + context_card",
        required_fields: [
          "finding_id",
          "trait",
          "evidence_tier",
          "source",
          "disclosure",
        ],
        optional_fields: ["gene", "rsid", "direction", "recommended_question"],
        empty_state:
          "Genetic context is optional and never blocks a readiness or action plan.",
        responsive_behavior:
          "Show concise gene cards on wide screens and disclosure rows on mobile.",
      },
      {
        id: "daily-outlook",
        label: "Daily context",
        modality: "health-context",
        purpose:
          "Capture illness, travel, alcohol, stress, symptoms, schedule, goals, and perceived exertion that may explain a signal.",
        component: "apex_insight_banner + check_in_strip",
        required_fields: [
          "recorded_at",
          "context_type",
          "value_or_note",
          "source",
        ],
        optional_fields: [
          "severity",
          "duration",
          "goal_id",
          "related_activity_id",
        ],
        empty_state:
          "Add a short check-in when the dashboard misses the why behind a score.",
        responsive_behavior:
          "Use quick tags and one visible most-recent note on mobile; expand the timeline on desktop.",
      },
    ],
    animations: [
      {
        id: "apex-tab-transition",
        trigger: "a dashboard tab is selected with pointer or keyboard",
        motion:
          "Change the selected tab state immediately, then fade and raise the active panel by 8px with a 55ms stagger for its tiles and actions. Do not delay the first datum or action.",
        duration: "500ms panel + 55ms item stagger",
        reduced_motion:
          "Switch panels immediately while preserving keyboard focus; do not fade or translate.",
      },
      {
        id: "apex-ring-sweep",
        trigger: "page load or date change",
        motion:
          "Sweep the three readiness rings to their supplied values with an 80ms stagger; leave value text stable and readable.",
        duration: "1300ms entrance + 80ms stagger",
        reduced_motion: "Render final arcs and values immediately.",
      },
      {
        id: "apex-bar-growth",
        trigger: "section enters viewport",
        motion: "Grow range and progress bars from their left baseline once.",
        duration: "900ms",
        reduced_motion: "Render completed bars immediately.",
      },
      {
        id: "apex-section-reveal",
        trigger: "page load",
        motion:
          "Fade and lift sections in reading order without delaying the first action.",
        duration: "500ms + 80ms stagger",
        reduced_motion: "Render all sections immediately.",
      },
      {
        id: "apex-orb-ambient",
        trigger: "biological age or healthspan context is present",
        motion:
          "Use a slow, low-opacity green orb glow only; no competing shimmer.",
        duration: "5s ambient loop",
        reduced_motion: "Use a static radial glow.",
      },
      {
        id: "apex-source-refresh",
        trigger: "sync completes",
        motion:
          "Pulse the affected source chip once and crossfade only the changed metric.",
        duration: "200ms",
        reduced_motion: "Update text without pulse or crossfade.",
      },
    ],
    action_plan: {
      title: "FOCUS",
      voice:
        "Meridian voice: performance-coach direct, concise, and recovery-aware. Every recommendation is rooted in a measured signal — never genetic speculation. Frame actions around what the body is recovering from or adapting to. Use the same athletic-systems language as the dashboard: strain demands rest, sleep drives readiness, consistency compounds.",
      ranking:
        "Rank by immediate safety, recovery constraint, expected impact, evidence confidence, and ease. Observed wearable and biomarker data outrank inherited context.",
      cadence: ["Now", "Today", "Tonight", "This week", "Retest"],
      item_fields: [
        "priority",
        "cadence",
        "title",
        "why_now",
        "steps",
        "target_metric",
        "expected_check_in",
        "source_ids",
        "confidence",
        "safety_note",
        "status",
      ],
      stages: [
        "FOCUS: one to three next actions",
        "MAINTAIN: habits supporting the signal",
        "WATCH: conditions that change the recommendation",
        "RETEST: when and what to measure again",
      ],
      safety_boundary:
        "Wellness education only. Do not diagnose, prescribe, or tell someone to train through concerning symptoms; route high-stakes findings to a qualified clinician.",
    },
    data_capture: {
      identity_fields: [
        "user_id",
        "display_name",
        "timezone",
        "age_band (optional)",
        "goals",
      ],
      provenance_fields: [
        "source_id",
        "source_provider",
        "integration_type",
        "observed_at",
        "collected_at",
        "synced_at",
        "freshness",
        "coverage",
        "confidence",
      ],
      modality_fields: {
        wearables: [
          "sleep_performance",
          "sleep_duration",
          "sleep_need",
          "sleep_debt",
          "recovery_score",
          "strain",
          "hrv",
          "resting_heart_rate",
          "respiratory_rate",
          "blood_oxygen",
          "skin_temperature",
          "stress",
          "activities",
        ],
        biomarkers: [
          "marker_id",
          "value",
          "unit",
          "collected_at",
          "reference_range",
          "optimal_range",
          "previous_value",
          "lab_name",
          "biological_age_method",
        ],
        genetics: [
          "finding_id",
          "trait",
          "direction",
          "evidence_tier",
          "source",
          "recommended_question",
        ],
        "health-context": [
          "recorded_at",
          "context_type",
          "value_or_note",
          "severity",
          "duration",
          "goal_id",
          "source",
        ],
      },
      freshness_rule:
        "Show the observation window and last sync beside every readiness or monitor signal; never make a stale score appear current.",
      missing_data_rule:
        "Use an explicit not-connected or not-provided state. Keep the APEX section order stable as a person adds modalities.",
    },
  },
  {
    id: "clinical-modern",
    name: "Clinical Modern",
    inspired_by: "Superpower",
    vibe: "Light, premium and medical. Generous whitespace, a calm blue-teal system, and neutral grays. Feels clinical but not cold.",
    best_for: [
      "biomarker panels",
      "lab results & memberships",
      "concierge/medical dashboards",
    ],
    color_scheme: "light",
    colors: {
      background: "#fbfcfd",
      surface: "#ffffff",
      surface_alt: "#f3f6f9",
      border: "rgba(12,17,22,0.10)",
      text: "#0c1116",
      text_muted: "#5b6672",
      primary: "#1d6ef2",
      on_primary: "#ffffff",
      accent: "#12b3a6",
      positive: "#16a34a",
      warning: "#d97706",
      negative: "#dc2626",
      data_viz: ["#1d6ef2", "#12b3a6", "#8b5cf6", "#f59e0b", "#ef4444"],
    },
    typography: {
      font_display: '"Inter", system-ui, sans-serif',
      font_body: '"Inter", system-ui, sans-serif',
      font_mono: '"IBM Plex Mono", ui-monospace, monospace',
      google_fonts: [
        "Inter:wght@400;500;600;700",
        "IBM+Plex+Mono:wght@400;500",
      ],
      scale: {
        display: {
          size: "44px",
          line_height: "1.05",
          weight: 700,
          letter_spacing: "-0.025em",
        },
        title: {
          size: "24px",
          line_height: "1.2",
          weight: 600,
          letter_spacing: "-0.015em",
        },
        heading: { size: "17px", line_height: "1.3", weight: 600 },
        body: { size: "15px", line_height: "1.6", weight: 400 },
        label: {
          size: "12px",
          line_height: "1.4",
          weight: 600,
          letter_spacing: "0.02em",
        },
        caption: { size: "12px", line_height: "1.4", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 24, 32, 48, 80] },
    radii: { sm: "8px", md: "12px", lg: "18px", pill: "999px" },
    elevation: [
      "none",
      "0 1px 2px rgba(12,17,22,0.06)",
      "0 12px 32px -16px rgba(12,17,22,0.18)",
    ],
    motion: {
      duration: { fast: "120ms", base: "200ms", slow: "320ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0,0,0.2,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      result_card: {
        description:
          "White card with a biomarker name, value, unit, and a reference-range bar.",
        css: {
          background: "#ffffff",
          border: "1px solid rgba(12,17,22,0.10)",
          "border-radius": "12px",
          padding: "20px",
        },
      },
      range_bar: {
        description:
          "Horizontal range bar with optimal band and a value marker.",
        css: { height: "6px", "border-radius": "999px", background: "#f3f6f9" },
      },
      primary_button: {
        description: "Solid blue action button.",
        css: {
          background: "#1d6ef2",
          color: "#ffffff",
          "border-radius": "10px",
          "font-weight": "600",
          padding: "12px 18px",
        },
      },
    },
  },
  {
    id: "metabolic",
    name: "Metabolic",
    inspired_by: "Levels",
    vibe: "Warm, friendly light theme built around a glucose graph: in-range green, watch amber, high red. Approachable rather than clinical.",
    best_for: [
      "CGM & glucose graphs",
      "metabolic/nutrition apps",
      "time-in-range views",
    ],
    color_scheme: "light",
    colors: {
      background: "#faf9f6",
      surface: "#ffffff",
      surface_alt: "#f2efe9",
      border: "rgba(26,26,26,0.10)",
      text: "#1a1a1a",
      text_muted: "#6b665c",
      primary: "#ff5c39",
      on_primary: "#ffffff",
      accent: "#3aa76d",
      positive: "#4caf50",
      warning: "#ffb020",
      negative: "#f44336",
      data_viz: ["#4caf50", "#ffb020", "#f44336", "#ff5c39", "#3aa76d"],
      gradient:
        "linear-gradient(180deg, #4caf50 0%, #ffb020 70%, #f44336 100%)",
    },
    typography: {
      font_display: '"Poppins", system-ui, sans-serif',
      font_body: '"Inter", system-ui, sans-serif',
      google_fonts: ["Poppins:wght@500;600;700", "Inter:wght@400;500;600"],
      scale: {
        display: {
          size: "46px",
          line_height: "1.05",
          weight: 700,
          letter_spacing: "-0.02em",
        },
        title: { size: "25px", line_height: "1.2", weight: 600 },
        heading: { size: "17px", line_height: "1.3", weight: 600 },
        body: { size: "15px", line_height: "1.6", weight: 400 },
        label: {
          size: "12px",
          line_height: "1.4",
          weight: 600,
          letter_spacing: "0.02em",
        },
        caption: { size: "12px", line_height: "1.4", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 24, 32, 44, 64] },
    radii: { sm: "10px", md: "16px", lg: "24px", pill: "999px" },
    elevation: [
      "none",
      "0 2px 8px rgba(26,26,26,0.06)",
      "0 14px 34px -18px rgba(26,26,26,0.2)",
    ],
    motion: {
      duration: { fast: "120ms", base: "240ms", slow: "400ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0.2,0.8,0.2,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      glucose_graph: {
        description:
          "Line/area chart with a shaded optimal band and zone-colored fills.",
        css: {
          "--in-range": "#4caf50",
          "--high": "#ffb020",
          "--very-high": "#f44336",
        },
      },
      zone_pill: {
        description:
          "Small rounded pill showing the current zone with its color.",
        css: {
          "border-radius": "999px",
          padding: "4px 12px",
          "font-weight": "600",
          "font-size": "12px",
        },
      },
      primary_button: {
        description: "Warm coral action button.",
        css: {
          background: "#ff5c39",
          color: "#ffffff",
          "border-radius": "14px",
          "font-weight": "600",
          padding: "12px 20px",
        },
      },
    },
  },
  {
    id: "system-cards",
    name: "System Cards",
    inspired_by: "Apple Health",
    vibe: "Native iOS feel: grouped light-gray background, white rounded cards, system font, and category colors (heart red, activity green, sleep indigo).",
    best_for: [
      "multi-metric summaries",
      "native iOS-style apps",
      "category-organized wellness data",
    ],
    color_scheme: "light",
    colors: {
      background: "#f2f2f7",
      surface: "#ffffff",
      surface_alt: "#e9e9ef",
      border: "rgba(60,60,67,0.12)",
      text: "#000000",
      text_muted: "#6c6c70",
      primary: "#0a84ff",
      on_primary: "#ffffff",
      accent: "#ff375f",
      positive: "#34c759",
      warning: "#ff9f0a",
      negative: "#ff3b30",
      data_viz: ["#ff375f", "#92d64d", "#5e5ce6", "#00b9d4", "#ff9f0a"],
    },
    typography: {
      font_display: '-apple-system, "SF Pro Display", system-ui, sans-serif',
      font_body: '-apple-system, "SF Pro Text", system-ui, sans-serif',
      google_fonts: [],
      scale: {
        display: {
          size: "34px",
          line_height: "1.1",
          weight: 700,
          letter_spacing: "0.01em",
        },
        title: { size: "22px", line_height: "1.2", weight: 700 },
        heading: { size: "17px", line_height: "1.3", weight: 600 },
        body: { size: "17px", line_height: "1.45", weight: 400 },
        label: { size: "13px", line_height: "1.3", weight: 600 },
        caption: { size: "12px", line_height: "1.3", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 20, 28, 40, 56] },
    radii: { sm: "10px", md: "16px", lg: "20px", pill: "999px" },
    elevation: [
      "none",
      "0 1px 3px rgba(0,0,0,0.08)",
      "0 8px 24px -12px rgba(0,0,0,0.16)",
    ],
    motion: {
      duration: { fast: "150ms", base: "250ms", slow: "400ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0.16,1,0.3,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      metric_card: {
        description:
          "White rounded card with a category-colored icon, title, and large value.",
        css: {
          background: "#ffffff",
          "border-radius": "16px",
          padding: "16px",
        },
      },
      category_icon: {
        description: "Rounded square icon tinted by health category.",
        css: { width: "30px", height: "30px", "border-radius": "8px" },
      },
      primary_button: {
        description: "iOS-style filled blue button.",
        css: {
          background: "#0a84ff",
          color: "#ffffff",
          "border-radius": "12px",
          "font-weight": "600",
          padding: "14px 18px",
        },
      },
    },
  },
  {
    id: "serene",
    name: "Serene",
    inspired_by: "Calm",
    vibe: "Meditative and soft. Deep blue-to-purple gradients, muted lavender accents, large gentle serif type, and slow easing. Made to lower the heart rate.",
    best_for: [
      "mindfulness & sleep stories",
      "mood/stress check-ins",
      "breathing & meditation UIs",
    ],
    color_scheme: "dark",
    colors: {
      background: "#141d33",
      surface: "#1e2942",
      surface_alt: "#27324f",
      border: "rgba(255,255,255,0.10)",
      text: "#eef1f8",
      text_muted: "#9aa4c0",
      primary: "#a78bfa",
      on_primary: "#1a1333",
      accent: "#7ec8e3",
      positive: "#7fd1ae",
      warning: "#f0c987",
      negative: "#e79a9a",
      data_viz: ["#a78bfa", "#7ec8e3", "#f0a6c0", "#7fd1ae", "#b6a4e8"],
      gradient:
        "linear-gradient(160deg, #2d4a7c 0%, #1b2a4a 60%, #141d33 100%)",
    },
    typography: {
      font_display: '"Newsreader", Georgia, serif',
      font_body: '"Inter", system-ui, sans-serif',
      google_fonts: [
        "Newsreader:opsz,wght@6..72,400;6..72,500",
        "Inter:wght@400;500",
      ],
      scale: {
        display: {
          size: "48px",
          line_height: "1.1",
          weight: 400,
          letter_spacing: "-0.01em",
        },
        title: { size: "28px", line_height: "1.25", weight: 400 },
        heading: { size: "18px", line_height: "1.4", weight: 500 },
        body: { size: "16px", line_height: "1.7", weight: 400 },
        label: {
          size: "12px",
          line_height: "1.4",
          weight: 500,
          letter_spacing: "0.06em",
        },
        caption: { size: "12px", line_height: "1.5", weight: 400 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 16, 24, 32, 48, 64, 96] },
    radii: { sm: "12px", md: "20px", lg: "28px", pill: "999px" },
    elevation: [
      "none",
      "0 10px 30px -16px rgba(0,0,0,0.5)",
      "0 24px 60px -24px rgba(0,0,0,0.6)",
    ],
    motion: {
      duration: { fast: "200ms", base: "400ms", slow: "800ms" },
      easing: {
        standard: "cubic-bezier(0.4,0,0.2,1)",
        entrance: "cubic-bezier(0.22,1,0.36,1)",
        exit: "cubic-bezier(0.4,0,1,1)",
      },
    },
    components: {
      breathing_orb: {
        description:
          "Soft glowing circle that scales slowly for breath pacing.",
        css: {
          background: "radial-gradient(circle, #a78bfa, transparent 70%)",
          "border-radius": "999px",
          filter: "blur(2px)",
        },
      },
      calm_card: {
        description:
          "Translucent surface with a large serif title over the gradient.",
        css: {
          background: "rgba(30,41,66,0.7)",
          "backdrop-filter": "blur(20px)",
          "border-radius": "20px",
          padding: "24px",
        },
      },
      primary_button: {
        description: "Soft lavender pill button.",
        css: {
          background: "#a78bfa",
          color: "#1a1333",
          "border-radius": "999px",
          "font-weight": "500",
          padding: "14px 24px",
        },
      },
    },
  },
  {
    id: "aperture",
    name: "Aperture",
    inspired_by: "Aperture Design System handoff",
    vibe:
      "A soft, optimistic health workspace on a warm-white canvas. Fustat gives the interface a friendly humanist voice while Geist Mono makes measurements legible. Teal guides selection and progress, a single low-saturation aura spotlights the daily insight, and Sleep, Activity, Nutrition, Mindfulness, Vitals, and Heart Health retain distinct colors.",
    best_for: [
      "consumer-facing multimodal health dashboards",
      "daily health coaching with clear next actions",
      "mobile-first health records for wearables, biomarkers, and genetics",
    ],
    color_scheme: "light",
    colors: {
      background: "#F4F6F7",
      surface: "#FFFFFF",
      surface_alt: "#EDEFF2",
      border: "#ECEEF1",
      text: "#171A1F",
      text_muted: "#6E7783",
      primary: "#0EA5A0",
      on_primary: "#FFFFFF",
      accent: "#5B67EA",
      positive: "#22B45E",
      warning: "#EE9E22",
      negative: "#F25B49",
      data_viz: ["#0EA5A0", "#5B67EA", "#22B45E", "#EE9E22", "#8B5CF0", "#F25B49", "#F2456F"],
      gradient:
        "radial-gradient(120% 90% at 0% 0%, #C4EFE9 0%, transparent 55%), radial-gradient(120% 90% at 100% 0%, #EEF0FE 0%, transparent 55%), linear-gradient(180deg, #FCF3E4 0%, #F4F6F7 70%)",
    },
    typography: {
      font_display: '"Fustat", "Segoe UI", system-ui, sans-serif',
      font_body: '"Fustat", "Segoe UI", system-ui, sans-serif',
      font_mono: '"Geist Mono", ui-monospace, "SF Mono", monospace',
      google_fonts: [],
      scale: {
        display: { size: "56px", line_height: "1.1", weight: 800, letter_spacing: "-0.02em" },
        title: { size: "28px", line_height: "1.25", weight: 700, letter_spacing: "-0.02em" },
        heading: { size: "20px", line_height: "1.25", weight: 600 },
        body: { size: "16px", line_height: "1.45", weight: 400 },
        label: { size: "13px", line_height: "1.25", weight: 500 },
        caption: { size: "12px", line_height: "1.25", weight: 500 },
      },
    },
    spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80] },
    radii: { sm: "10px", md: "14px", lg: "26px", pill: "999px" },
    elevation: [
      "none",
      "0 1px 2px rgba(23,26,31,0.04), 0 6px 20px -8px rgba(23,26,31,0.10)",
      "0 0 0 1px rgba(14,165,160,0.10), 0 18px 48px -12px rgba(14,165,160,0.35)",
    ],
    motion: {
      duration: { fast: "120ms", base: "200ms", slow: "320ms" },
      easing: {
        standard: "cubic-bezier(0.65,0,0.35,1)",
        entrance: "cubic-bezier(0.22,1,0.36,1)",
        exit: "cubic-bezier(0.65,0,0.35,1)",
      },
    },
    components: {
      aperture_insight_banner: {
        description:
          "One featured, conversational insight per view on the cyan-lilac-cream mesh. State the observed signal, its likely context, and one gentle next action; never fabricate an observation.",
        css: {
          background: "var(--grad-mesh)",
          "border-radius": "32px",
          padding: "22px",
          "box-shadow": "0 0 0 1px rgba(14,165,160,.10), 0 18px 48px -12px rgba(14,165,160,.35)",
        },
      },
      aperture_energy_score: {
        description:
          "A large, precise Energy score with one word band. Render only when a documented calculation has sufficient current data; otherwise show the source connection state and the next useful action.",
        css: { "font-family": "Fustat", "font-weight": "800", "font-size": "56px", "letter-spacing": "-0.02em", "border-radius": "26px" },
      },
      aperture_activity_ring: {
        description:
          "A compact concentric activity ring: color is reserved for the supplied activity channels, and the center never implies completion when a channel is absent.",
        css: { width: "104px", "stroke-linecap": "round", "track-color": "#EDEFF2", "border-radius": "999px" },
      },
      aperture_progress_ring: {
        description:
          "A sleep or goal progress ring with score, duration or unit, and a full reduced-motion final state.",
        css: { width: "104px", "stroke-width": "9px", color: "#5B67EA", "border-radius": "999px" },
      },
      aperture_pillar_list: {
        description:
          "A white, rounded list of the five core pillars. Each row has a tinted Lucide icon chip, a clear status, a measured value when present, and an explicit empty state otherwise.",
        css: { background: "#FFFFFF", "border-radius": "26px", "row-radius": "14px", "divider-color": "#ECEEF1" },
      },
      aperture_range_gauge: {
        description:
          "A biomarker range bar with value, unit, collection date, reference range, and a clearly separate marker. It is explanatory, not diagnostic.",
        css: { height: "8px", background: "#EDEFF2", "border-radius": "999px", marker: "#0EA5A0" },
      },
      aperture_action_card: {
        description:
          "A dawn-gradient action-plan focus card. Use a verb-first action, why now, cadence, and a check-in date; keep clinical boundaries visible when a finding warrants it.",
        css: { background: "linear-gradient(160deg, #E6F7F5 0%, #E8F8EE 45%, #FCF3E4 100%)", "border-radius": "32px", padding: "24px" },
      },
    },
    responsive: {
      breakpoints: ["<=719px mobile", "720-1023px tablet", ">=1024px desktop"],
      desktop:
        "Use a 248px sidebar and 68px top bar. Keep one insight aura at the top, then arrange Energy, activity, sleep, pillars, and health-record cards in a calm 14–18px grid with a 1200px content maximum.",
      tablet:
        "Collapse secondary chrome before the content hierarchy. Keep the insight first, use two-column metric cards, and retain labels beside values and freshness rather than hiding them in hover states.",
      mobile:
        "Use 20px gutters and a floating bottom tab bar. Stack the insight, Energy score, rings, pillars, record, and action plan in that order; never require horizontal scrolling to read a value or its provenance.",
    },
    metrics: [
      { id: "energy_score", label: "Energy score", modality: "wearables", priority: "hero", format: "0–100 calculation + band + contributing source freshness", preferred_visual: "aperture_energy_score", highlight_reason: "Turns current, sufficiently complete observations into one plainly qualified daily signal.", states: ["excellent", "good", "fair", "needs attention", "not enough data"] },
      { id: "sleep_score", label: "Sleep score", modality: "wearables", priority: "hero", format: "0–100 score + duration", preferred_visual: "aperture_progress_ring", highlight_reason: "A daily pillar with its duration beside the score.", states: ["excellent", "good", "fair", "needs attention", "missing"] },
      { id: "activity_load", label: "Daily activity", modality: "wearables", priority: "primary", format: "concentric channel progress + units", preferred_visual: "aperture_activity_ring", highlight_reason: "Shows movement context without collapsing distinct channels into an invented aggregate.", states: ["on track", "building", "rest day", "missing"] },
      { id: "hrv", label: "HRV", modality: "wearables", priority: "primary", format: "ms vs personal baseline", preferred_visual: "metric_tile", highlight_reason: "A baseline-relative recovery signal, never a standalone diagnosis.", states: ["above baseline", "within baseline", "below baseline", "missing"] },
      { id: "resting_heart_rate", label: "Resting heart rate", modality: "wearables", priority: "primary", format: "bpm vs personal baseline", preferred_visual: "metric_tile", highlight_reason: "Adds cardiovascular context to the day’s reading.", states: ["within baseline", "elevated", "low", "missing"] },
      { id: "biomarker_panel", label: "Biomarker panel", modality: "biomarkers", priority: "context", format: "value + unit + range + collection date", preferred_visual: "aperture_range_gauge", highlight_reason: "Keeps measured lab context precise and date-bound.", states: ["in range", "watch", "out of range", "missing"] },
      { id: "heart_health_score", label: "Heart Health Score", modality: "biomarkers", priority: "context", format: "documented composite + method + contributing sources", preferred_visual: "score_card", highlight_reason: "A longer-horizon heart-health view only when its method and required signals are available.", states: ["excellent", "good", "fair", "needs attention", "unavailable"] },
      { id: "genetic_context", label: "Genetic context", modality: "genetics", priority: "context", format: "evidence-tiered finding + disclosure", preferred_visual: "evidence_card", highlight_reason: "Personalizes questions without outranking observed health data.", states: ["supportive", "mixed", "not provided"] },
      { id: "nutrition_pattern", label: "Nutrition", modality: "health-context", priority: "secondary", format: "check-in or logged pattern + date", preferred_visual: "aperture_pillar_list", highlight_reason: "Makes a recognised pillar useful even when it begins with a short check-in.", states: ["captured", "partial", "not captured"] },
      { id: "mindfulness_context", label: "Mindfulness", modality: "health-context", priority: "secondary", format: "check-in + note + date", preferred_visual: "aperture_pillar_list", highlight_reason: "Keeps the human explanation for a signal visible without pretending a sensor measured it.", states: ["captured", "partial", "not captured"] },
    ],
    modality_sections: [
      {
        id: "aperture-wearables",
        label: "Today’s signals",
        modality: "wearables",
        purpose: "Lead with a qualified Energy score or data-ready state, then sleep, activity, and baseline-relative vital signs.",
        component: "aperture_energy_score + aperture_activity_ring + aperture_progress_ring",
        required_fields: ["source_provider", "observed_at", "synced_at"],
        optional_fields: ["energy_score", "energy_score_method", "sleep_score", "sleep_duration", "activity_channels", "hrv", "resting_heart_rate"],
        empty_state: "Connect a wearable to start with sleep, activity, and recovery context. The rest of your record can still be useful.",
        responsive_behavior: "Desktop pairs activity and sleep rings; mobile stacks Energy, activity, and sleep with values and source freshness always visible.",
      },
      {
        id: "aperture-biomarkers",
        label: "Your health record",
        modality: "biomarkers",
        purpose: "Place dated lab values and range context behind the daily overview, with derived scores visibly separated from raw results.",
        component: "aperture_range_gauge + score_card",
        required_fields: ["marker_id", "value", "unit", "collected_at", "reference_range", "provenance"],
        optional_fields: ["previous_value", "optimal_range", "lab_name", "heart_health_score", "score_method"],
        empty_state: "No blood panel is connected. Daily wearable guidance and health-context check-ins can still be useful.",
        responsive_behavior: "Use compact range rows on desktop and stack named value, unit, range, date, and provenance on mobile.",
      },
      {
        id: "aperture-genetics",
        label: "Genetic context",
        modality: "genetics",
        purpose: "Offer evidence-tiered inherited context as supporting detail, never as the daily lead signal.",
        component: "evidence_card + disclosure",
        required_fields: ["finding_id", "trait", "evidence_tier", "source", "disclosure"],
        optional_fields: ["gene", "rsid", "direction", "recommended_question"],
        empty_state: "Genetic context is optional. Connect a WGS VCF or VCF.GZ when you want this layer of your record.",
        responsive_behavior: "Keep concise evidence and disclosure rows on mobile; expand supporting detail on desktop without displacing today’s signals.",
      },
      {
        id: "aperture-context",
        label: "Your pillars",
        modality: "health-context",
        purpose: "Capture the nutrition, mindfulness, symptoms, goals, and schedule context that explains why the data feels the way it does.",
        component: "aperture_pillar_list + check_in_strip",
        required_fields: ["recorded_at", "context_type", "value_or_note", "source"],
        optional_fields: ["severity", "duration", "goal_id", "related_activity_id", "nutrition_pattern", "mindfulness_minutes"],
        empty_state: "Add a short check-in to fill in what your devices and lab results cannot know.",
        responsive_behavior: "Use a legible list row per pillar at every breakpoint; show the next action rather than hiding it in a dense timeline on mobile.",
      },
    ],
    animations: [
      { id: "aperture-insight-entrance", trigger: "view load or a new supported insight", motion: "Reveal the single featured insight with a gentle fade and 8px rise; keep its text readable before the animation completes.", duration: "320ms", reduced_motion: "Render the insight in its final position immediately." },
      { id: "aperture-ring-sweep", trigger: "page load or supplied metric change", motion: "Sweep progress and activity arcs once to their supplied values; animate only channels with data.", duration: "900ms", reduced_motion: "Render final arcs and labels immediately." },
      { id: "aperture-card-hover", trigger: "pointer hovers an interactive card or list row", motion: "Lift the card by 2px and strengthen its soft card shadow; do not scale or use an opacity-only state.", duration: "120ms", reduced_motion: "Change the surface wash without movement." },
      { id: "aperture-source-refresh", trigger: "a source sync completes", motion: "Update the freshness label and pulse its teal provenance treatment once without shifting the layout.", duration: "200ms", reduced_motion: "Update the label only." },
    ],
    action_plan: {
      title: "This week’s focus",
      voice: "Aperture voice: evidence-graded, data-literate, and gently opinionated. Each recommendation cites the observation that triggered it. State the signal, the context, and one concrete action in plain language. Frame every suggestion as 'your data show' rather than 'you should'. Grade confidence: the user should know when the evidence is strong vs preliminary.",
      ranking: "Rank by safety, expected impact, confidence, and ease. Current observed signals outrank inherited context, and unsupported scores never create an action.",
      cadence: ["Now", "Today", "This week", "Retest"],
      item_fields: ["priority", "title", "why_now", "steps", "target_metric", "expected_check_in", "source_ids", "confidence", "safety_note", "status"],
      stages: ["FOCUS", "MAINTAIN", "WATCH", "RETEST"],
      safety_boundary: "Wellness education only. Do not diagnose or prescribe; route concerning findings to a qualified clinician.",
    },
  },
];

// Every selectable system is a complete multimodal dashboard contract. The
// visual hierarchy changes by system (hero, palette, typography, voice), but
// switching themes must never silently drop wearables, biomarkers, genetics,
// human context, provenance, or the action plan.
const FULL_MODALITY_SECTIONS: DesignModalitySection[] = [
  {
    id: "wearables",
    label: "Wearables",
    modality: "wearables",
    purpose:
      "Show the latest connected-device signals and what they mean for today.",
    component: "hero_metric + monitor_grid + activity_timeline",
    required_fields: ["source_provider", "observed_at", "sync_status"],
    optional_fields: [
      "recovery_score",
      "sleep_performance",
      "strain",
      "hrv",
      "resting_heart_rate",
      "stress",
      "activities",
    ],
    empty_state:
      "Connect a wearable to unlock live recovery and activity context.",
    responsive_behavior:
      "Keep the hero signal above the fold; stack tiles and preserve source freshness on mobile.",
  },
  {
    id: "biomarkers",
    label: "Biomarkers",
    modality: "biomarkers",
    purpose:
      "Show slower-moving measured signals with units, ranges, dates, and retest guidance.",
    component: "range_table + trend_cards",
    required_fields: [
      "marker_id",
      "value",
      "unit",
      "collected_at",
      "reference_range",
      "provenance",
    ],
    optional_fields: [
      "previous_value",
      "optimal_range",
      "lab_name",
      "interpretation",
    ],
    empty_state: "No blood panel connected. Other modalities remain useful.",
    responsive_behavior:
      "Use a table on wide screens and stacked value/range cards on mobile.",
  },
  {
    id: "genetics",
    label: "Genetic context",
    modality: "genetics",
    purpose:
      "Keep evidence-graded inherited context available without letting it override observed data.",
    component: "evidence_cards + disclosure",
    required_fields: [
      "finding_id",
      "trait",
      "evidence_tier",
      "source",
      "disclosure",
    ],
    optional_fields: ["gene", "rsid", "direction", "recommended_question"],
    empty_state:
      "Genetic context is optional and does not block the dashboard.",
    responsive_behavior:
      "Place below observed signals; disclose long evidence text on smaller screens.",
  },
  {
    id: "health-context",
    label: "Human context",
    modality: "health-context",
    purpose:
      "Capture illness, travel, alcohol, stress, symptoms, pain, schedule, goals, and perceived exertion.",
    component: "check_in_strip + context_timeline",
    required_fields: ["recorded_at", "context_type", "value_or_note", "source"],
    optional_fields: ["severity", "duration", "goal_id", "related_activity_id"],
    empty_state: "Add a short check-in when the sensors miss the why.",
    responsive_behavior:
      "Use quick tags on mobile and a filterable timeline on desktop.",
  },
];

const FULL_METRICS: DesignMetricSpec[] = [
  {
    id: "recovery_score",
    label: "Recovery",
    modality: "wearables",
    priority: "hero",
    format: "0–100 score",
    preferred_visual: "hero_metric",
    highlight_reason: "Sets the day’s available capacity.",
    states: ["available", "caution", "depleted", "missing"],
  },
  {
    id: "sleep_performance",
    label: "Sleep performance",
    modality: "wearables",
    priority: "hero",
    format: "percentage + duration",
    preferred_visual: "hero_metric",
    highlight_reason: "Explains recovery through sleep need coverage.",
    states: ["complete", "partial", "insufficient", "missing"],
  },
  {
    id: "strain",
    label: "Strain",
    modality: "wearables",
    priority: "hero",
    format: "load score",
    preferred_visual: "hero_metric",
    highlight_reason: "Shows training load in recovery context.",
    states: ["easy", "productive", "high", "missing"],
  },
  {
    id: "hrv",
    label: "HRV",
    modality: "wearables",
    priority: "primary",
    format: "value vs personal baseline",
    preferred_visual: "monitor_tile",
    highlight_reason: "Baseline-relative recovery signal.",
    states: ["above", "within", "below", "missing"],
  },
  {
    id: "resting_heart_rate",
    label: "Resting heart rate",
    modality: "wearables",
    priority: "primary",
    format: "bpm vs baseline",
    preferred_visual: "monitor_tile",
    highlight_reason: "Adds cardiovascular and illness context.",
    states: ["within", "elevated", "low", "missing"],
  },
  {
    id: "stress",
    label: "Stress",
    modality: "wearables",
    priority: "primary",
    format: "state + contributor",
    preferred_visual: "stress_band",
    highlight_reason: "Turns a score change into a next step.",
    states: ["low", "moderate", "high", "missing"],
  },
  {
    id: "activity_load",
    label: "Activity load",
    modality: "wearables",
    priority: "primary",
    format: "timeline + contribution",
    preferred_visual: "activity_timeline",
    highlight_reason: "Shows the choices affecting recovery.",
    states: ["easy", "productive", "high", "missing"],
  },
  {
    id: "biomarker_panel",
    label: "Biomarker panel",
    modality: "biomarkers",
    priority: "context",
    format: "value + unit + range + date",
    preferred_visual: "range_table",
    highlight_reason: "Adds slower-moving context and retest decisions.",
    states: ["in range", "watch", "out of range", "missing"],
  },
  {
    id: "genetic_context",
    label: "Genetic context",
    modality: "genetics",
    priority: "context",
    format: "evidence-graded finding",
    preferred_visual: "evidence_card",
    highlight_reason: "Tunes questions without overriding observed data.",
    states: ["supportive", "mixed", "none", "missing"],
  },
  {
    id: "daily_context",
    label: "Daily context",
    modality: "health-context",
    priority: "primary",
    format: "structured note + tags",
    preferred_visual: "context_timeline",
    highlight_reason: "Captures what sensors cannot infer.",
    states: ["captured", "partial", "missing"],
  },
];

const FULL_ANIMATIONS: DesignAnimationSpec[] = [
  {
    id: "hero-entrance",
    trigger: "page load or date change",
    motion:
      "Reveal the signature hero first, then stagger modality sections in reading order.",
    duration: "600ms entrance + 80ms stagger",
    reduced_motion: "Render all sections immediately.",
  },
  {
    id: "metric-transition",
    trigger: "metric enters viewport or sync completes",
    motion:
      "Count once, then reveal delta and freshness; crossfade changed values.",
    duration: "360ms",
    reduced_motion: "Show final values without motion.",
  },
  {
    id: "trend-draw",
    trigger: "trend enters viewport",
    motion:
      "Draw the trend line or range bar from the baseline anchor to the current value.",
    duration: "480ms",
    reduced_motion: "Show the completed visual.",
  },
  {
    id: "action-reveal",
    trigger: "action plan enters viewport",
    motion:
      "Reveal the first action immediately, then stagger supporting actions by priority.",
    duration: "240ms per item",
    reduced_motion: "Render all actions immediately.",
  },
  {
    id: "source-refresh",
    trigger: "sync completes",
    motion:
      "Pulse the provenance chip once and update freshness without shifting layout.",
    duration: "200ms",
    reduced_motion: "Update text only.",
  },
];

const FULL_ACTION_PLAN: DesignActionPlanSpec = {
  title: "Action plan",
  voice:
    "Specific, calm, and non-judgmental. Say what to do next, why it matters, and when to check it again.",
  ranking:
    "Rank by safety, expected impact, confidence, and ease. Observed signals outrank inherited context.",
  cadence: ["Now", "Today", "This week", "Retest"],
  item_fields: [
    "priority",
    "title",
    "why_now",
    "steps",
    "target_metric",
    "expected_check_in",
    "source_ids",
    "confidence",
    "safety_note",
    "status",
  ],
  stages: ["FOCUS", "MAINTAIN", "WATCH", "RETEST"],
  safety_boundary:
    "Wellness education only. Do not diagnose or prescribe; route concerning findings to a qualified clinician.",
};

const FULL_DATA_CAPTURE: DesignDataCaptureSpec = {
  identity_fields: ["user_id", "display_name", "timezone", "goals"],
  provenance_fields: [
    "source_id",
    "source_provider",
    "observed_at",
    "collected_at",
    "synced_at",
    "freshness",
    "coverage",
    "confidence",
  ],
  modality_fields: {
    wearables: [
      "recovery_score",
      "sleep_performance",
      "sleep_duration",
      "sleep_debt",
      "strain",
      "hrv",
      "resting_heart_rate",
      "stress",
      "activities",
    ],
    biomarkers: [
      "marker_id",
      "value",
      "unit",
      "collected_at",
      "reference_range",
      "previous_value",
      "lab_name",
    ],
    genetics: [
      "finding_id",
      "trait",
      "evidence_tier",
      "source",
      "recommended_question",
    ],
    "health-context": [
      "recorded_at",
      "context_type",
      "value_or_note",
      "severity",
      "duration",
      "goal_id",
      "source",
    ],
  },
  freshness_rule: "Show observation window and last sync beside live scores.",
  missing_data_rule:
    "Use explicit not-connected or not-provided states without reordering the learned dashboard structure.",
};

const performanceSystem = SYSTEMS.find((system) => system.id === "performance")!;
SYSTEMS.push({
  ...performanceSystem,
  id: "meridian",
  name: "Meridian wearable dashboard",
  inspired_by: "WHOOP (Meridian handoff)",
  vibe:
    "A WHOOP-inspired, dark electric-mint wearable-performance dashboard: a live readiness orb, recovery/strain/sleep channels, quiet instrument-panel chrome, and source-aware agent context. The exact production HTML, CSS, JavaScript, and assets are available from its implementation package. It is not affiliated with or endorsed by WHOOP.",
  best_for: [
    "agent-built wearable and longevity apps",
    "WHOOP-first recovery, strain, and sleep workflows",
    "healthspan dashboards with explicit source readiness",
  ],
  color_scheme: "dark",
  colors: {
    background: "#07090C",
    surface: "#12161C",
    surface_alt: "#171C24",
    border: "rgba(255,255,255,0.10)",
    text: "#F4F7FA",
    text_muted: "#9AA4B0",
    primary: "#12D982",
    on_primary: "#07090C",
    accent: "#3BB6F5",
    positive: "#34E08A",
    warning: "#FFD23F",
    negative: "#FF5A6E",
    data_viz: ["#34E08A", "#3BB6F5", "#8A9BFF", "#FFD23F"],
    gradient: "linear-gradient(135deg, #12D982 0%, #0E9DE8 100%)",
  },
  typography: {
    font_display: '"Metropolis", system-ui, sans-serif',
    font_body: '"Metropolis", system-ui, sans-serif',
    font_mono: '"DM Mono", ui-monospace, monospace',
    google_fonts: [],
    scale: {
      display: { size: "46px", line_height: "1.0", weight: 700, letter_spacing: "-0.04em" },
      title: { size: "30px", line_height: "1.09", weight: 700, letter_spacing: "-0.04em" },
      heading: { size: "20px", line_height: "1.3", weight: 600 },
      body: { size: "14px", line_height: "1.55", weight: 400 },
      label: { size: "10px", line_height: "1.4", weight: 700, letter_spacing: "0.12em" },
      caption: { size: "11px", line_height: "1.4", weight: 500 },
    },
  },
  spacing: { base_px: 4, scale_px: [4, 8, 12, 16, 20, 24, 32, 48, 64] },
  radii: { sm: "8px", md: "12px", lg: "20px", pill: "999px" },
  elevation: ["none", "0 2px 8px rgba(0,0,0,0.45)", "0 24px 64px rgba(0,0,0,0.66)"],
  motion: {
    duration: { fast: "120ms", base: "200ms", slow: "320ms" },
    easing: { standard: "cubic-bezier(0.16,1,0.3,1)", entrance: "cubic-bezier(0.16,1,0.3,1)", exit: "cubic-bezier(0.65,0,0.35,1)" },
  },
  components: {
    ...performanceSystem.components,
    healthspan_readiness: {
      description: "A connection-backed readiness orb. It shows data coverage only and must not imply a physiological score until a real analysis supplies one.",
      css: { "border-radius": "50%", "accent": "#12D982", "track": "rgba(255,255,255,0.08)" },
    },
    whoop_performance_card: {
      description: "A primary WHOOP connection card with recovery green, strain blue, and sleep indigo channels and a first-party OAuth CTA.",
      css: { "border-radius": "16px", "recovery": "#34E08A", "strain": "#3BB6F5", "sleep": "#8A9BFF" },
    },
  },
});

// Meridian is derived from shared performance primitives above. Once it is
// assembled, discard every non-curated candidate from the runtime catalog.
const CURATED_SYSTEM_IDS = new Set(["foreverbetter", "meridian", "aperture"]);
SYSTEMS.splice(
  0,
  SYSTEMS.length,
  ...SYSTEMS.filter((system) => CURATED_SYSTEM_IDS.has(system.id))
);

for (const system of SYSTEMS) {
  system.metrics ??= FULL_METRICS;
  system.modality_sections ??= FULL_MODALITY_SECTIONS;
  system.animations ??= FULL_ANIMATIONS;
  system.action_plan ??= FULL_ACTION_PLAN;
  system.data_capture ??= FULL_DATA_CAPTURE;
  system.responsive ??= {
    breakpoints: ["<=720px mobile", "721-1024px tablet", ">1024px desktop"],
    desktop:
      "Signature hero followed by all modality sections and the action plan in a scannable grid.",
    tablet:
      "Use two-column metric and modality cards while preserving section order and provenance.",
    mobile:
      "Stack the hero, modality sections, and action plan; keep values and next actions visible without horizontal scrolling.",
  };
}

export function listDesignSystems() {
  return {
    count: SYSTEMS.length,
    note: "Three curated, production-ready design contracts for health & wellness UIs. Each carries a distinct layout, full multimodal data contract, provenance rules, and action-plan guidance rather than a palette-only theme.",
    systems: SYSTEMS.map((system) => ({
      id: system.id,
      name: system.name,
      inspired_by: system.inspired_by,
      color_scheme: system.color_scheme,
      vibe: system.vibe,
      best_for: system.best_for,
      layout: LAYOUTS[system.id],
    })),
  };
}

export function getDesignSystem(
  id: string
): (DesignSystem & { design_md: string }) | undefined {
  const system = SYSTEMS.find((item) => item.id === id);
  if (!system) return undefined;
  return {
    ...system,
    layout: LAYOUTS[system.id],
    design_md: designSystemMarkdown(system),
  };
}

// A ready-to-paste DESIGN.md, generated from the tokens so it never drifts.
export function designSystemMarkdown(system: DesignSystem): string {
  const c = system.colors;
  const t = system.typography;
  // The house design is ours; the "inspired by / not affiliated" framing that
  // applies to the aesthetic-category systems would be nonsensical for it.
  const house = system.id === "foreverbetter";
  const importedHandoff = system.id === "aperture";
  const line = (k: string, v: string) => `- **${k}:** \`${v}\``;
  const scaleRows = Object.entries(t.scale)
    .map(
      ([name, s]) =>
        `| ${name} | ${s.size} | ${s.line_height} | ${s.weight} | ${
          s.letter_spacing ?? "none"
        } |`
    )
    .join("\n");
  const components = Object.entries(system.components)
    .map(([name, def]) => `- **${name}** - ${def.description}`)
    .join("\n");
  const metricRows = (system.metrics ?? [])
    .map(
      (m) =>
        `| ${m.label} | ${m.modality} | ${m.priority} | ${m.format} | ${m.preferred_visual} | ${m.highlight_reason} |`
    )
    .join("\n");
  const modalityRows = (system.modality_sections ?? [])
    .map(
      (s) =>
        `### ${s.label}\n\n- **Purpose:** ${s.purpose}\n- **Component:** \`${
          s.component
        }\`\n- **Required:** ${s.required_fields.join(", ")}\n- **Optional:** ${
          s.optional_fields.join(", ") || "none"
        }\n- **Empty state:** ${s.empty_state}\n- **Responsive:** ${
          s.responsive_behavior
        }`
    )
    .join("\n\n");
  const animationRows = (system.animations ?? [])
    .map(
      (a) =>
        `- **${a.id}** - trigger: ${a.trigger}; motion: ${a.motion}; duration: ${a.duration}; reduced motion: ${a.reduced_motion}`
    )
    .join("\n");
  const plan = system.action_plan;
  const capture = system.data_capture;
  const responsive = system.responsive;
  return [
    `# ${system.name} - design system`,
    ``,
    house
      ? `_The ForeverBetter house design. ${system.vibe}_`
      : importedHandoff
      ? `_Source: user-provided ${system.inspired_by}. ${system.vibe}_`
      : `_Inspired by ${system.inspired_by}. ${system.vibe}_`,
    ``,
    `**Best for:** ${system.best_for.join(", ")}. **Scheme:** ${
      system.color_scheme
    }.`,
    ``,
    ...(LAYOUTS[system.id]
      ? [
          `**Layout:** ${LAYOUTS[system.id].summary} Hero: \`${
            LAYOUTS[system.id].hero
          }\`. Voice: ${LAYOUTS[system.id].voice}. Sections: ${LAYOUTS[
            system.id
          ].sections.join(" → ")}.`,
          ``,
        ]
      : []),
    `## Color`,
    line("background", c.background),
    line("surface", c.surface),
    line("surface-alt", c.surface_alt),
    line("border", c.border),
    line("text", c.text),
    line("text-muted", c.text_muted),
    line("primary", `${c.primary} (on ${c.on_primary})`),
    line("accent", c.accent),
    line(
      "positive / warning / negative",
      `${c.positive} / ${c.warning} / ${c.negative}`
    ),
    line("data-viz palette", c.data_viz.join(", ")),
    c.gradient ? line("gradient", c.gradient) : "",
    ``,
    `## Typography`,
    line("display font", t.font_display),
    line("body font", t.font_body),
    t.font_mono ? line("mono font", t.font_mono) : "",
    t.google_fonts.length
      ? line("google fonts", t.google_fonts.join(" | "))
      : "- **fonts:** system stack (no web fonts to load)",
    ``,
    `| role | size | line-height | weight | tracking |`,
    `| --- | --- | --- | --- | --- |`,
    scaleRows,
    ``,
    `## Spacing & shape`,
    line("spacing scale (px)", system.spacing.scale_px.join(", ")),
    line(
      "radii",
      `sm ${system.radii.sm} · md ${system.radii.md} · lg ${system.radii.lg} · pill ${system.radii.pill}`
    ),
    line(
      "elevation",
      system.elevation.filter((e) => e !== "none").join("  |  ")
    ),
    ``,
    `## Motion`,
    line(
      "duration",
      `fast ${system.motion.duration.fast} · base ${system.motion.duration.base} · slow ${system.motion.duration.slow}`
    ),
    line("easing (standard)", system.motion.easing.standard),
    ``,
    responsive
      ? `## Responsive composition\n- **Breakpoints:** ${responsive.breakpoints.join(
          " · "
        )}\n- **Desktop:** ${responsive.desktop}\n- **Tablet:** ${
          responsive.tablet
        }\n- **Mobile:** ${responsive.mobile}`
      : "",
    responsive ? `` : "",
    metricRows
      ? `## Metric emphasis\n\n| metric | modality | priority | format | preferred visual | why it is highlighted |\n| --- | --- | --- | --- | --- | --- |\n${metricRows}`
      : "",
    metricRows ? `` : "",
    modalityRows ? `## Modality sections\n\n${modalityRows}` : "",
    modalityRows ? `` : "",
    plan
      ? `## Action plan\n- **Title:** ${plan.title}\n- **Voice:** ${
          plan.voice
        }\n- **Ranking:** ${plan.ranking}\n- **Cadence:** ${plan.cadence.join(
          " → "
        )}\n- **Item fields:** ${plan.item_fields.join(
          ", "
        )}\n- **Stages:** ${plan.stages.join(" · ")}\n- **Safety boundary:** ${
          plan.safety_boundary
        }`
      : "",
    plan ? `` : "",
    animationRows ? `## Animation choreography\n${animationRows}` : "",
    animationRows ? `` : "",
    capture
      ? `## Data capture contract\n- **Identity:** ${capture.identity_fields.join(
          ", "
        )}\n- **Provenance:** ${capture.provenance_fields.join(
          ", "
        )}\n- **Wearables:** ${capture.modality_fields.wearables.join(
          ", "
        )}\n- **Biomarkers:** ${capture.modality_fields.biomarkers.join(
          ", "
        )}\n- **Genetics:** ${capture.modality_fields.genetics.join(
          ", "
        )}\n- **Health context:** ${capture.modality_fields[
          "health-context"
        ].join(", ")}\n- **Freshness:** ${
          capture.freshness_rule
        }\n- **Missing data:** ${capture.missing_data_rule}`
      : "",
    capture ? `` : "",
    `## Signature components`,
    components,
    ``,
    house
      ? `> The ForeverBetter house design system - the canonical Healthspan dossier. Uses open/system fonts; no proprietary font files are bundled.`
      : importedHandoff
      ? `> Encoded from the user-provided ${system.name} handoff as tokens, layout, data, and motion guidance. The implementation includes no source HTML, prototype runtime, images, or proprietary assets.`
      : `> Educational design guidance inspired by ${system.inspired_by}. Not affiliated with or endorsed by ${system.inspired_by}; no proprietary fonts, assets, or screenshots are included.`,
  ]
    .filter((row) => row !== "")
    .join("\n");
}
