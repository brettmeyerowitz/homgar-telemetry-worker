/**
 * Public telemetry dashboard renderer.
 *
 * Server-rendered, zero JavaScript, zero external requests: charts are inline
 * SVG and the CSS is inlined verbatim from docs/dashboard-design.html. Keep it
 * that way — this page fronts privacy-sensitive telemetry, so a third-party
 * request would undercut the point.
 *
 * Chart geometry is generated, not hand-tuned. Bar width is value/max * 380;
 * the growth plot maps x over 56..876 and y over 232..24.
 */

const CSS = `:root{
  --bg:#f4f7f9; --panel:#ffffff; --panel-2:#fafcfd;
  --ink:#0c1a24; --ink-2:#26404f; --muted:#4c626f;
  --line:#dae3e8; --grid:#e6edf1;
  --accent:#0b7fa3; --accent-ink:#065a75; --accent-soft:#dcf0f7;
  --bar:#0b7fa3; --bar-2:#7fb3c6; --warn:#8a5a12; --warn-soft:#fdf3e0;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0a1015; --panel:#121b22; --panel-2:#0f171d;
    --ink:#e9f1f5; --ink-2:#c3d3dc; --muted:#94a8b4;
    --line:#213039; --grid:#1b272f;
    --accent:#3fc0e2; --accent-ink:#7ad6ef; --accent-soft:#132a34;
    --bar:#3fc0e2; --bar-2:#2c6a7f; --warn:#e0b063; --warn-soft:#251d0e;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px; line-height:1.5; overflow-x:hidden;
  font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1;
}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:1280px; margin:0 auto; padding:28px 20px 64px}
@media (max-width:520px){ .wrap{padding:20px 14px 48px} }

/* ---- header ---- */
.head{display:flex; flex-wrap:wrap; gap:16px 32px; align-items:flex-end; justify-content:space-between; padding-bottom:18px; border-bottom:1px solid var(--line)}
h1{margin:0; font-size:21px; letter-spacing:-.01em; font-weight:650}
.sub{margin:5px 0 0; color:var(--muted); font-size:13.5px; max-width:58ch}
.stamp{color:var(--muted); font-size:12px; text-align:right; line-height:1.7}
.stamp b{color:var(--ink-2); font-weight:600}
@media (max-width:640px){ .stamp{text-align:left} }

/* ---- opt-in notice: above the fold, not a footer ---- */
.notice{
  display:flex; gap:12px; align-items:baseline; margin:18px 0 26px;
  padding:12px 14px; background:var(--accent-soft); border:1px solid var(--line);
  border-radius:4px; font-size:13.5px; color:var(--ink-2);
}
.notice .tag{
  flex:0 0 auto; font-size:10.5px; letter-spacing:.09em; text-transform:uppercase;
  font-weight:700; color:var(--accent-ink);
}
.notice p{margin:0}
.notice strong{color:var(--ink)}

/* ---- tiles ---- */
.tiles{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px}
@media (min-width:900px){ .tiles{grid-template-columns:repeat(7,minmax(0,1fr))} }
.tile{background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:13px 14px 15px}
.t-lab{font-size:10.5px; white-space:nowrap; letter-spacing:.085em; text-transform:uppercase; color:var(--muted); font-weight:650}
.t-val{margin-top:7px; font-size:25px; line-height:1.05; font-weight:600; letter-spacing:-.02em}
.t-val.sm{font-size:13.5px; padding-top:11px; letter-spacing:0; white-space:nowrap}
.t-note{margin-top:4px; font-size:11.5px; color:var(--muted)}

/* ---- sections / cards ---- */
section{margin-top:34px}
.sec-head{display:flex; flex-wrap:wrap; gap:4px 18px; align-items:baseline; margin-bottom:10px}
h2{margin:0; font-size:14px; font-weight:650; letter-spacing:.005em}
.sec-head .meta{font-size:12px; color:var(--muted)}
.card{background:var(--panel); border:1px solid var(--line); border-radius:4px}
.card-pad{padding:14px 4px 10px}
.scroll{overflow-x:auto; -webkit-overflow-scrolling:touch}
.scroll svg{display:block}
.foot-note{margin:9px 2px 0; font-size:12px; color:var(--muted); max-width:76ch}
.foot-note code{font-size:11.5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* two-up grid for the ranked charts */
.cols{display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:26px}

/* ---- svg text ---- */
svg text{fill:var(--ink-2)}
.ax{fill:var(--muted); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.lb{font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.vl{font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; fill:var(--ink)}
.ann{fill:var(--muted); font-size:11px; font-weight:600}
.grid-l{stroke:var(--grid); stroke-width:1}
.axis-l{stroke:var(--line); stroke-width:1}
.ln{fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; stroke-linecap:round}
.ln-part{fill:none; stroke:var(--accent); stroke-width:2; stroke-dasharray:4 3; opacity:.75}
.area{fill:var(--accent); opacity:.10}
.dot{fill:var(--accent)}
.dot-hollow{fill:var(--panel); stroke:var(--accent); stroke-width:2}
.mark{stroke:var(--muted); stroke-width:1; stroke-dasharray:3 3}
.part-band{fill:var(--muted); opacity:.07}
.bar{fill:var(--bar)}
.bar-tail{fill:var(--bar-2)}

/* ---- footer ---- */
footer{margin-top:40px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:12.5px}
footer p{margin:0 0 8px}
footer a{color:var(--accent-ink)}
footer a:hover{color:var(--ink)}
a{color:var(--accent-ink)} a:hover{color:var(--ink)}`;

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PLOT = { x0: 56, x1: 876, yTop: 24, yBase: 232 };

/** Horizontal bar rows sharing the design's 26px row pitch. */
function bars(rows, { label, value, labelX, barX, valueX, anchorEnd = true, barMax = 380 }) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  return rows
    .map((r, i) => {
      const y = i * 26;
      const w = (r[value] / max) * barMax;
      const anchor = anchorEnd ? ' text-anchor="end"' : '';
      return (
        `<text class="lb" x="${labelX}" y="${y + 17}"${anchor}>${esc(r[label])}</text>` +
        `<rect class="bar" x="${barX}" y="${y + 6}" width="${w.toFixed(1)}" height="13"></rect>` +
        `<text class="vl" x="${valueX}" y="${y + 17}" text-anchor="end">${esc(r[value])}</text>`
      );
    })
    .join('\n');
}

const barSvg = (rows, opts, width, title) =>
  rows.length
    ? `<div class="scroll"><svg width="${width}" height="${rows.length * 26 + 6}" ` +
      `viewBox="0 0 ${width} ${rows.length * 26 + 6}" role="img" aria-label="${esc(title)}">` +
      `<title>${esc(title)}</title>${bars(rows, opts)}</svg></div>`
    : '<p class="foot-note">No data yet.</p>';

/** The 30-day growth chart. The final point is today and still accumulating. */
function growthChart(growth) {
  if (growth.length < 2) return '<p class="foot-note">Not enough history yet.</p>';
  const n = growth.length;
  const dx = (PLOT.x1 - PLOT.x0) / (n - 1);
  // Round the axis top up to a clean step so ticks read 0/20/40/60/70 rather
  // than raw quarters of the peak (17/34/51/68).
  const peak = Math.max(1, ...growth.map((g) => g.installs));
  const step = peak <= 10 ? 2 : peak <= 100 ? 10 : peak <= 500 ? 50 : 100;
  const max = Math.ceil(peak / step) * step;
  const x = (i) => PLOT.x0 + dx * i;
  const y = (v) => PLOT.yBase - (v / max) * (PLOT.yBase - PLOT.yTop);
  const pt = (g, i) => `${x(i).toFixed(1)},${y(g.installs).toFixed(1)}`;

  const complete = growth.slice(0, -1);
  const line = complete.map((g, i) => `${i ? 'L' : 'M'}${pt(g, i)}`).join(' ');
  const area = `${line} L${x(n - 2).toFixed(1)},${PLOT.yBase} L${PLOT.x0},${PLOT.yBase} Z`;
  const partial = `M${pt(growth[n - 2], n - 2)} L${pt(growth[n - 1], n - 1)}`;
  const dots = complete.map((g, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(g.installs).toFixed(1)}" r="2"></circle>`).join('');
  const ticks = growth
    .map((g, i) => (i % 3 === 0 || i === n - 1
      ? `<text class="ax" x="${x(i).toFixed(1)}" y="${i === n - 1 ? 266 : 250}" text-anchor="middle">${esc(g.day.slice(5))}</text>`
      : ''))
    .join('');
  const ticks_ = [];
  for (let v = 0; v <= max; v += step) ticks_.push(v);
  const grid = ticks_
    .map((v) => {
      return `<line class="${v === 0 ? 'axis-l' : 'grid-l'}" x1="56" y1="${y(v).toFixed(1)}" x2="876" y2="${y(v).toFixed(1)}"></line>` +
        `<text class="ax" x="48" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
    })
    .join('');
  const last = growth[n - 1];
  return (
    '<div class="scroll"><svg width="920" height="272" viewBox="0 0 920 272" role="img" ' +
    `aria-label="Daily active installs from ${esc(growth[0].day)} to ${esc(last.day)}. The final day is partial and still accumulating.">` +
    '<title>Daily active installs</title>' + grid +
    `<rect class="part-band" x="${(x(n - 1) - dx / 2).toFixed(1)}" y="24" width="${dx.toFixed(1)}" height="208"></rect>` +
    `<path class="area" d="${area}"></path><path class="ln" d="${line}"></path>` +
    `<path class="ln-part" d="${partial}"></path>${dots}` +
    `<circle class="dot-hollow" cx="${x(n - 1).toFixed(1)}" cy="${y(last.installs).toFixed(1)}" r="3.4"></circle>` +
    `<text class="ann" x="${(x(n - 1) - 8).toFixed(1)}" y="${(y(last.installs) - 14).toFixed(1)}" text-anchor="end">partial day &mdash; ${esc(last.installs)} so far</text>` +
    `${ticks}</svg></div>`
  );
}

const tile = (metric, label, val, note, cls = '') =>
  `<div class="tile"><div class="t-lab">${esc(label)}</div>` +
  `<div class="t-val${cls ? ' ' + cls : ''}" data-metric="${metric}">${esc(val)}</div>` +
  `<div class="t-note">${esc(note)}</div></div>`;

/** MM-DD, n days before `now` — used to state each window's start explicitly. */
const daysAgo = (now, n) =>
  new Date(now.getTime() - n * 86400_000).toISOString().slice(5, 10);

const daysBetween = (iso, now) =>
  iso ? Math.max(0, Math.round((now - new Date(iso + 'T00:00:00Z')) / 86400_000)) : 0;

/** Latest month only — country_counts and model_counts are month-partitioned. */
const latestMonth = (rows) => {
  if (!rows.length) return [];
  const m = rows[0].month;
  return rows.filter((r) => r.month === m);
};

export function renderDashboard(agg, now = new Date()) {
  const countries = latestMonth(agg.countries);
  const models = latestMonth(agg.models);
  const versions = agg.versions ?? [];
  const integ = Object.entries(
    versions.reduce((a, v) => ((a[v.integration_version] = (a[v.integration_version] ?? 0) + v.installs), a), {})
  ).map(([integration_version, installs]) => ({ integration_version, installs })).sort((a, b) => b.installs - a.installs);
  const hass = Object.entries(
    versions.reduce((a, v) => ((a[v.hass_version] = (a[v.hass_version] ?? 0) + v.installs), a), {})
  ).map(([hass_version, installs]) => ({ hass_version, installs })).sort((a, b) => b.installs - a.installs);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telemetry &mdash; HomGar / RainPoint integration</title>
<style>${CSS}</style></head><body><div class="wrap">
<header class="head"><div>
<h1>HomGar / RainPoint integration &mdash; telemetry</h1>
<p class="sub">Anonymous, opt-in usage reporting from the Home Assistant custom integration for HomGar and RainPoint irrigation and water devices.</p>
</div><div class="stamp">Last updated <b class="mono">${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC</b><br>
Cached ~15 min &middot; collecting since <b class="mono">${esc(agg.first_ping ?? 'n/a')}</b></div></header>

<div class="notice"><span class="tag">Read first</span>
<p><strong>Telemetry is opt-in &mdash; these numbers are a floor, not a user count.</strong>
Only installs that explicitly enabled reporting appear here. Country and model figures are
<strong>install-months</strong>: one install counted once per calendar month it reported in, with no
per-install identifier retained &mdash; so they are never a distinct-user figure.</p></div>

<div class="tiles">
${tile('total_installs', 'Total installs', agg.installs, 'all time, opt-in')}
${tile('active_7d', 'Active 7d', agg.active_7d, 'reported since ' + daysAgo(now, 7))}
${tile('active_30d', 'Active 30d', agg.active_30d, 'reported since ' + daysAgo(now, 30))}
${tile('new_7d', 'New this week', agg.new_7d, 'first-seen installs')}
${tile('countries', 'Countries', countries.length, 'current month')}
${tile('models', 'Models', models.length, models.reduce((a, r) => a + r.count, 0) + ' install-months')}
${tile('since', 'Since', agg.first_ping ?? 'n/a', daysBetween(agg.first_ping, now) + ' days of data', 'sm mono')}
</div>

<section><div class="sec-head"><h2>Daily active installs</h2>
<span class="meta">last 30 days &middot; installs that checked in that day</span></div>
<div class="card card-pad">${growthChart(agg.growth ?? [])}
<p class="foot-note">The right-most point is today and is still accumulating; it is drawn dashed and hollow by design.</p></div></section>

<div class="cols">
<section><div class="sec-head"><h2>Integration version</h2><span class="meta">last 3 days &middot; distinct installs</span></div>
<div class="card card-pad">${barSvg(integ, { label: 'integration_version', value: 'installs', labelX: 96, barX: 110, valueX: 556 }, 575, 'Integration version adoption')}
<p class="foot-note">An install that updated inside the window is counted under both versions.</p></div></section>

<section><div class="sec-head"><h2>Home Assistant version</h2><span class="meta">last 30 days &middot; ${esc(hass.length)} distinct</span></div>
<div class="card card-pad">${barSvg(hass, { label: 'hass_version', value: 'installs', labelX: 96, barX: 110, valueX: 556 }, 575, 'Home Assistant core versions')}
<p class="foot-note">An install that upgraded mid-window appears under both versions.</p></div></section>
</div>

<div class="cols">
<section><div class="sec-head"><h2>Countries</h2>
<span class="meta">current month &middot; ${esc(countries.length)} countries &middot; install-months, not users</span></div>
<div class="card card-pad">${barSvg(countries, { label: 'country', value: 'count', labelX: 34, barX: 48, valueX: 400, barMax: 300 }, 420, 'Install-months by country')}
<p class="foot-note"><strong>Install-months:</strong> an install is counted once for each calendar month in which it reported. The aggregate table holds no per-install identifier, so these figures cannot be reduced to distinct users.</p></div></section>

<section><div class="sec-head"><h2>Device models</h2>
<span class="meta">current month &middot; ${esc(models.length)} distinct &middot; every model, including single installs</span></div>
<div class="card card-pad">${barSvg(models, { label: 'model', value: 'count', labelX: 14, barX: 150, valueX: 520, anchorEnd: false, barMax: 300 }, 545, 'Device models by install-months')}
<p class="foot-note">Every model is listed, including those with a single install &mdash; a thin tail is the interesting part, since a model with one reporting install is one nobody would notice breaking. SKU strings are reported verbatim by the device.</p></div></section>
</div>

<footer>
<p><strong>Telemetry is opt-in &mdash; these numbers are a floor, not a user count.</strong> Reporting is off unless enabled during setup, so real deployment is larger than shown by an unknown margin.</p>
<p>Payloads carry integration version, Home Assistant version, coarse country and device model strings. No account identifiers, no device serials, no IP addresses or precise location are stored.</p>
</footer></div></body></html>`;
}
