import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

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

function ping(body) {
  return SELF.fetch('https://example.com/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BASE = {
  anon_id: ID,
  integration_version: '3.0.44',
  hass_version: '2026.8.1',
  share_country: false,
  share_models: false,
};

describe('POST /ping', () => {
  it('returns 204 with no body', async () => {
    const res = await ping(BASE);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('creates one install row', async () => {
    await ping(BASE);
    const row = await env.TELEMETRY_DB
      .prepare('SELECT * FROM installs WHERE anon_id = ?1').bind(ID).first();
    expect(row.first_seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.last_seen).toBe(row.first_seen);
  });

  it('is idempotent: twenty pings the same day yield one ping row', async () => {
    for (let i = 0; i < 20; i++) await ping(BASE);
    const row = await env.TELEMETRY_DB
      .prepare('SELECT COUNT(*) AS n FROM pings WHERE anon_id = ?1').bind(ID).first();
    expect(row.n).toBe(1);
  });

  it('records the latest versions on a repeat ping', async () => {
    await ping(BASE);
    await ping({ ...BASE, integration_version: '3.0.45' });
    const row = await env.TELEMETRY_DB
      .prepare('SELECT integration_version FROM pings WHERE anon_id = ?1').bind(ID).first();
    expect(row.integration_version).toBe('3.0.45');
  });

  it('stores a date with no time component', async () => {
    await ping(BASE);
    const row = await env.TELEMETRY_DB
      .prepare('SELECT day FROM pings WHERE anon_id = ?1').bind(ID).first();
    expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('ignores a client-supplied day and uses the worker clock', async () => {
    await ping({ ...BASE, day: '1999-01-01', ts: 915148800 });
    const row = await env.TELEMETRY_DB
      .prepare('SELECT day FROM pings WHERE anon_id = ?1').bind(ID).first();
    expect(row.day).not.toBe('1999-01-01');
    expect(row.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('rejects a malformed anon_id', async () => {
    const res = await ping({ ...BASE, anon_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('rejects GET', async () => {
    const res = await SELF.fetch('https://example.com/ping', { method: 'GET' });
    expect(res.status).toBe(405);
  });
});
