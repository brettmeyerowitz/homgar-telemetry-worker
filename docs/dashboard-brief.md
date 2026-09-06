# Public stats dashboard — design brief

Brief for designing the public telemetry dashboard (`GET /` on this worker).
Hand the fenced block below to a designer or design tool verbatim; everything
outside it is context for us.

## Why this exists

`/stats` already returns the aggregates as JSON, but behind `STATS_TOKEN`.
Reading the numbers means a manual SQL pull or a token. The dashboard renders
the same aggregates as a public page.

## Implementation shape (decided 2026-09-06)

- New route `GET /`. `/ping`, `/stats`, `/health` unchanged; `/stats` keeps its
  bearer check and JSON shape.
- The page queries D1 server-side via the existing `TELEMETRY_DB` binding. It
  does **not** call `/stats`, so no token ever reaches a browser and there is
  no CORS surface.
- Lift the aggregate queries out of `handleStats` into a shared
  `loadAggregates(env)` used by both `/stats` and the dashboard, so the two
  cannot drift and the schema traps live in one place.
- Cache API + `Cache-Control: public, max-age=900`. A public URL must not hit
  D1 per view; aggregates move daily, so 15 minutes is generous.
- `X-Robots-Tag: noindex` — public and linkable, but not accumulating search
  presence on its own.
- Tests extend the existing suite. The source-level privacy guards in
  `test/privacy.test.js` (no forbidden `cf` fields, no `console.*` anywhere in
  worker source) apply to the new code too.

## Data integrity constraints

Three ways these numbers get misread, all of which the design has to prevent:

1. **Opt-in floor.** Telemetry is opt-in, so every figure is a lower bound, not
   a user count.
2. **Install-months.** `country_counts` and `model_counts` carry no `anon_id` by
   design. A model count is install-months claiming that model, never distinct
   users.
3. **Partial final day.** The last point of the growth series is still
   accumulating and must be visually distinguished, or the chart shows a daily
   cliff that isn't real.

Plus one historical artifact: the 2026-08-19 jump (2 → 34) is v3.0.44 shipping
telemetry, not adoption.

## The brief

```
I need a single-page stats dashboard designed. It reports opt-in anonymous
telemetry for an open-source Home Assistant integration (HomGar / RainPoint
smart irrigation + water devices — valves, timers, soil and water sensors).
Audience: the maintainer, contributors, and curious users. It should look
sharp and technical — a real telemetry dashboard, not a marketing page.

=== HARD RUNTIME CONSTRAINTS (these are absolute) ===

The page is served by a Cloudflare Worker that returns the HTML as a
JavaScript template string. That imposes:

1. ONE self-contained HTML document. All CSS in a single inline <style>.
   No external files.
2. ZERO external network requests. No CDN, no Google Fonts, no webfonts,
   no <img> to any URL, no analytics, no icon libraries. This page fronts
   privacy-sensitive telemetry — a third-party request would undercut the
   whole point. System font stack only, e.g.
   -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
   sans-serif; and ui-monospace, SFMono-Regular, Menlo, monospace for numerals.
3. NO JAVASCRIPT. None. The page must be fully correct with JS disabled.
   No chart library, no counters, no tabs, no theme toggle.
4. All charts must be INLINE SVG, hand-authored, with plain geometry
   (rect / path / line / text). I compute the coordinates server-side, so
   keep the maths obvious and the structure repetitive — one <rect> per bar,
   a single <path> for the line. Avoid clever transforms I'd have to reverse.
5. Light AND dark, via @media (prefers-color-scheme: dark) only. No toggle
   (that needs JS). Define colours as CSS custom properties on :root and
   override them in the dark block. Give <body> an explicit background.
6. Responsive from 320px to wide desktop. Any wide element (charts, tables)
   scrolls inside its own overflow-x:auto container — the body must never
   scroll sideways.
7. Budget: under ~50KB of HTML+CSS+SVG total. It's a Worker response.
8. TEMPLATABLE: every dynamic number, label, and chart coordinate must be an
   obvious placeholder token like {{INSTALLS}} or {{GROWTH_PATH}}, or sit in
   a clearly-marked repeated block I can generate in a loop. Don't bury a
   real value inside a hand-tuned SVG path with no marker.
9. Accessibility: WCAG AA contrast in both themes; every chart needs a
   <title>/aria-label; never encode meaning in colour alone — label the bars.

=== THE DATA (real values, 2026-09-06 — treat as a layout snapshot) ===

Headline tiles:
  Total installs        70
  Active last 7 days    69
  Active last 30 days   70
  New this week          5
  Countries             15
  Distinct models       38
  Collecting since      2026-08-12

Daily active installs, last 30 days (the main chart):
  08-12:2  08-13:2  08-14:2  08-15:2  08-16:2  08-17:2  08-18:4
  08-19:34 08-20:40 08-21:47 08-22:52 08-23:55 08-24:58 08-25:58
  08-26:58 08-27:59 08-28:60 08-29:62 08-30:64 08-31:65 09-01:66
  09-02:66 09-03:63 09-04:68 09-05:66 09-06:6

  TWO THINGS THE DESIGN MUST HANDLE HONESTLY:
  (a) The jump on 08-19 (2 → 34) is the release that ADDED telemetry, not a
      growth event. The flat 2s before it are test installs. Needs a subtle
      annotation or marker — something like "telemetry shipped" — not a
      dramatic hockey-stick read.
  (b) The final point is a PARTIAL DAY (still accumulating). It must be
      visually distinct — dashed segment, hollow point, muted fill — and
      labelled, or the chart shows a cliff that isn't real. Design this in;
      it recurs every single day.

Integration version adoption (last 3 days, distinct installs):
  3.0.50 → 59   3.0.49 → 8   3.0.47 → 2
  3.0.44 → 2    3.0.48 → 1   3.0.45 → 1
  (Sums above the install total on purpose: an install that updated
  mid-window appears under both versions. Note this in the UI.)

Home Assistant versions (last 7 days): 9 distinct
  2026.8.3 → 59   2026.9.0 → 45   2026.9.1 → 7   2026.8.2 → 3
  2026.8.1 → 2    2026.6.1 → 2    2026.9.0b4 → 1  2026.8.0 → 1
  2026.6.4 → 1

Countries (current month, 15):
  DE 13, US 12, ZA 10, GB 8, CH 5, FR 4, CA 3, ES 2,
  MY 1, CZ 1, LU 1, BE 1, IT 1, MT 1, AU 1
  (No map — that would need an external asset. Bars or a ranked list.)

Device models (current month, 38 distinct, 208 total):
  HWG023WBRF-V2 35, HCS026FRF 17, HCS012ARF 16, HCS021FRF 15,
  HTV145FRF 10, HTV245FRF 10, HTV405FRF 8, HWG0538WRF 8, HWG023WRF 8,
  HTV213FRF 7, HCS008FRF 6, HTV113FRF 6, HTV210B 5, HTP159W 5, ...
  (long tail: 15 of the 38 models sit at 1–2)
  Model names are opaque SKUs — they need monospace and room to breathe.
  Show the top ~12 and summarise the tail rather than listing all 38.

=== NON-NEGOTIABLE COPY ===

These aren't decoration; they stop the numbers being misread:

- "Telemetry is opt-in — these numbers are a floor, not a user count."
  Must be visible without scrolling, not buried in a footer.
- Country and model figures are INSTALL-MONTHS, not distinct users (the
  aggregate tables intentionally hold no per-install id). Never label them
  "users". A short inline explanation of install-months earns its space.
- A "last updated" timestamp, and a note that data is cached ~15 minutes.

=== AESTHETIC DIRECTION ===

Water and irrigation is the subject — a cool palette (teal/cyan through
deep blue) fits without being literal. Home Assistant's own blue is
#03A9F4 if you want an anchor. Please avoid: gradient hero banners, glassy
cards, emoji as icons, and huge animated-looking numbers. Dense, calm,
well-aligned, generous whitespace, strong typographic hierarchy. Tabular
figures for all numerals so columns line up. Think status page or a good
analytics console.

=== DELIVERABLE ===

One .html file, static, self-contained, no JS, with placeholder tokens for
every dynamic value. I'll port it straight into the Worker as a template
string — so please also avoid backticks and ${...} sequences in the CSS or
markup, since those would collide with JS template-string syntax.
```

## Regenerating the data snapshot

The queries behind those figures are in the integration repo at
`scripts/telemetry-stats.sql`, run against D1 `homgar-telemetry`
(`490d05e8-9fe0-4314-a3c6-007c2c21470d`). The growth series is query 1 of
`handleStats` in `src/index.js`.
