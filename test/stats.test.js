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
