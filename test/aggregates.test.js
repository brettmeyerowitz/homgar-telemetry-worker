import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const ID  = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MONTH = new Date().toISOString().slice(0, 7);

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

function ping(body, cf = { country: 'ZA' }) {
  return SELF.fetch('https://example.com/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cf,
  });
}

const BASE = {
  anon_id: ID,
  integration_version: '3.0.44',
  hass_version: '2026.8.1',
  share_country: false,
  share_models: false,
};

async function countryCount(cc) {
  const row = await env.TELEMETRY_DB
    .prepare('SELECT count FROM country_counts WHERE country = ?1 AND month = ?2')
    .bind(cc, MONTH).first();
  return row ? row.count : 0;
}

describe('country aggregation', () => {
  it('does not record country when share_country is false', async () => {
    await ping(BASE);
    expect(await countryCount('ZA')).toBe(0);
  });

  it('records country once when share_country is true', async () => {
    await ping({ ...BASE, share_country: true });
    expect(await countryCount('ZA')).toBe(1);
  });

  it('does not double-count the same install within a month', async () => {
    await ping({ ...BASE, share_country: true });
    await ping({ ...BASE, share_country: true });
    await ping({ ...BASE, share_country: true });
    expect(await countryCount('ZA')).toBe(1);
  });

  it('counts two distinct installs separately', async () => {
    await ping({ ...BASE, share_country: true });
    await ping({ ...BASE, anon_id: ID2, share_country: true });
    expect(await countryCount('ZA')).toBe(2);
  });
});

describe('model aggregation', () => {
  it('ignores models when share_models is false', async () => {
    await ping({ ...BASE, models: ['HTV245FRF'] });
    const row = await env.TELEMETRY_DB
      .prepare('SELECT COUNT(*) AS n FROM model_counts').first();
    expect(row.n).toBe(0);
  });

  it('records each distinct model once when share_models is true', async () => {
    await ping({ ...BASE, share_models: true, models: ['HTV245FRF', 'HTV245FRF', 'HWG023WBRF-V2'] });
    const { results } = await env.TELEMETRY_DB
      .prepare('SELECT model, count FROM model_counts ORDER BY model').all();
    expect(results).toEqual([
      { model: 'HTV245FRF', count: 1 },
      { model: 'HWG023WBRF-V2', count: 1 },
    ]);
  });
});
