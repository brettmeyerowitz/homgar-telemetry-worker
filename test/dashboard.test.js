import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { renderDashboard } from '../src/dashboard.js';

beforeAll(async () => {
  for (const stmt of env.TEST_SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await env.TELEMETRY_DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM installs'),
    env.TELEMETRY_DB.prepare('DELETE FROM pings'),
    env.TELEMETRY_DB.prepare('DELETE FROM country_counts'),
    env.TELEMETRY_DB.prepare('DELETE FROM model_counts'),
  ]);
});

const dashboard = () => SELF.fetch('https://example.com/');

const ping = (anon_id, extra = {}) =>
  SELF.fetch('https://example.com/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anon_id, integration_version: '3.0.50', hass_version: '2026.9.0',
      share_country: true, share_models: true, models: ['HWG023WBRF-V2'],
      ...extra,
    }),
    cf: { country: 'ZA' },
  });

describe('GET /', () => {
  it('serves an HTML page without a token', async () => {
    const res = await dashboard();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('is cacheable for 15 minutes and excluded from search indexes', async () => {
    const res = await dashboard();
    expect(res.headers.get('cache-control')).toMatch(/max-age=900/);
    expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
  });

  it('renders the real install count from D1, not a placeholder', async () => {
    await ping('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    await ping('9f8b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d');
    const html = await (await dashboard()).text();
    expect(html).toMatch(/\b2\b/);
    expect(html).toContain('ZA');
    expect(html).toContain('HWG023WBRF-V2');
  });

  it('distinguishes total installs from those still active', async () => {
    // One install that has not been seen for 40 days, one fresh.
    await env.TELEMETRY_DB.prepare(
      "INSERT INTO installs (anon_id, first_seen, last_seen) VALUES (?1, date('now','-90 day'), date('now','-40 day'))"
    ).bind('11111111-2222-4333-8444-555555555555').run();
    await ping('3f2504e0-4f89-41d3-9a0c-0305e82c3301');

    const html = await (await dashboard()).text();
    const metric = (name) =>
      html.match(new RegExp('data-metric="' + name + '"[^>]*>([^<]*)<'))?.[1]?.trim();

    expect(metric('total_installs')).toBe('2');
    expect(metric('active_30d')).toBe('1');
  });
});

describe('growth chart axis', () => {
  const agg = (peak) => ({
    installs: peak, active_7d: peak, active_30d: peak, new_7d: 0,
    first_ping: '2026-08-12', growth: [
      { day: '2026-08-12', installs: 2 },
      { day: '2026-08-13', installs: peak },
      { day: '2026-08-14', installs: 6 },
    ],
    versions: [], countries: [], models: [],
  });

  it('labels the y axis with round numbers, not raw fractions of the max', () => {
    // A peak of 68 must not produce ticks of 17 / 34 / 51.
    const svg = renderDashboard(agg(68));
    expect(svg).toContain('>70</text>');
    expect(svg).not.toContain('>17</text>');
    expect(svg).not.toContain('>51</text>');
  });
});
