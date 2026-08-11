import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
// Matches the STATS_TOKEN miniflare binding in vitest.config.js. Assigning
// env.STATS_TOKEN here does not propagate into the isolated Worker runtime
// with the installed vitest-pool-workers version, so the token is injected
// as a real binding instead and referenced here by its known value.
const TOKEN = 'test-stats-token';

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

const stats = (headers = {}) =>
  SELF.fetch('https://example.com/stats', { headers });

describe('GET /stats', () => {
  it('rejects with no token', async () => {
    expect((await stats()).status).toBe(401);
  });

  it('rejects with a wrong token', async () => {
    expect((await stats({ Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    const res = await stats({ Authorization: `bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('returns aggregates with a valid token', async () => {
    await SELF.fetch('https://example.com/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: ID, integration_version: '3.0.44', hass_version: '2026.8.1',
        share_country: true, share_models: false,
      }),
      cf: { country: 'ZA' },
    });

    const res = await stats({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active_installs).toBe(1);
    expect(body.countries).toEqual(expect.arrayContaining([
      expect.objectContaining({ country: 'ZA', count: 1 }),
    ]));
  });

  it('counts distinct installs per version, not ping rows (I6)', async () => {
    // Same install pings on two different days within the 30-day window:
    // one install, two ping rows for it. `versions[].installs` must report
    // 1, not 2, or a long-lived install would be weighted like many
    // short-lived ones.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400_000);
    const todayStr = today.toISOString().slice(0, 10);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    await env.TELEMETRY_DB.batch([
      env.TELEMETRY_DB.prepare(
        `INSERT INTO installs (anon_id, first_seen, last_seen) VALUES (?1, ?2, ?3)`
      ).bind(ID, yesterdayStr, todayStr),
      env.TELEMETRY_DB.prepare(
        `INSERT INTO pings (anon_id, day, integration_version, hass_version) VALUES (?1, ?2, '3.0.44', '2026.8.1')`
      ).bind(ID, yesterdayStr),
      env.TELEMETRY_DB.prepare(
        `INSERT INTO pings (anon_id, day, integration_version, hass_version) VALUES (?1, ?2, '3.0.44', '2026.8.1')`
      ).bind(ID, todayStr),
    ]);

    const res = await stats({ Authorization: `Bearer ${TOKEN}` });
    const body = await res.json();
    expect(body.versions).toEqual([
      { integration_version: '3.0.44', hass_version: '2026.8.1', installs: 1 },
    ]);
  });

  it('never exposes an anon_id', async () => {
    await SELF.fetch('https://example.com/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: ID, integration_version: '3.0.44', hass_version: '2026.8.1',
        share_country: false, share_models: false,
      }),
    });
    const res = await stats({ Authorization: `Bearer ${TOKEN}` });
    expect(await res.text()).not.toContain(ID);
  });
});

describe('GET /health', () => {
  it('is public and returns ok', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});
