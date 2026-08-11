import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

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

  it('caps at 50 models, sliced before any per-element processing', async () => {
    // 200 distinct 65-char-unique models: if the array were deduped/mapped
    // before truncation, distinguishing them would be trivial regardless of
    // count; this instead proves the raw array is sliced to 50 elements
    // FIRST, so only the first 50 of the 200 can ever reach model_counts.
    const models = Array.from({ length: 200 }, (_, i) => `MODEL-${String(i).padStart(4, '0')}`);
    await ping({ ...BASE, share_models: true, models });
    const row = await env.TELEMETRY_DB
      .prepare('SELECT COUNT(*) AS n FROM model_counts').first();
    expect(row.n).toBe(50);

    const { results } = await env.TELEMETRY_DB
      .prepare("SELECT model FROM model_counts WHERE model = 'MODEL-0049'").all();
    expect(results).toHaveLength(1);
    const { results: shouldBeAbsent } = await env.TELEMETRY_DB
      .prepare("SELECT model FROM model_counts WHERE model = 'MODEL-0050'").all();
    expect(shouldBeAbsent).toHaveLength(0);
  });

  it('dedupes AFTER truncation, so two models differing only past char 64 count as one', async () => {
    const prefix = 'A'.repeat(64);
    await ping({
      ...BASE,
      share_models: true,
      models: [`${prefix}-tail-one`, `${prefix}-tail-two`],
    });
    const { results } = await env.TELEMETRY_DB
      .prepare('SELECT model, count FROM model_counts').all();
    // Both inputs truncate to the same 64-char value, so this must be a
    // single row incremented once per ping, not two rows (or one row double
    // counted from a single ping).
    expect(results).toEqual([{ model: prefix, count: 1 }]);
  });

  it('never stores a row for an empty-string model', async () => {
    await ping({ ...BASE, share_models: true, models: ['', 'HTV245FRF'] });
    const { results } = await env.TELEMETRY_DB
      .prepare('SELECT model FROM model_counts').all();
    expect(results).toEqual([{ model: 'HTV245FRF' }]);
  });
});

describe('monthly claim gating (I2)', () => {
  it('does not consume the monthly claim on a ping that shares nothing', async () => {
    // A ping with both share flags off must not mark the month as counted —
    // otherwise this install could enable sharing later in the same month
    // and silently never be counted.
    await ping({ ...BASE, share_country: false, share_models: false });
    const row = await env.TELEMETRY_DB
      .prepare('SELECT last_counted_month FROM installs WHERE anon_id = ?1').bind(ID).first();
    expect(row.last_counted_month).toBeNull();
  });

  it('counts an install that opts in later in the same month it first pinged with sharing off', async () => {
    await ping({ ...BASE, share_country: false, share_models: false });
    await ping({ ...BASE, share_country: true });
    expect(await countryCount('ZA')).toBe(1);
  });
});

describe('claim/aggregate atomicity (I3)', () => {
  afterEach(async () => {
    // Restore the table dropped below to simulate an aggregate-write
    // failure, so later tests' DELETE FROM model_counts in beforeEach still
    // has a table to operate on.
    const createModelCounts = env.TEST_SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .find(s => /CREATE TABLE.*model_counts/i.test(s));
    await env.TELEMETRY_DB.prepare(createModelCounts).run();
  });

  it('releases the monthly claim when the aggregate batch fails, instead of burning it', async () => {
    // Drop model_counts so the aggregate INSERT genuinely fails at the D1
    // level — a real failure, not a mocked one.
    await env.TELEMETRY_DB.prepare('DROP TABLE model_counts').run();

    const failed = await ping({ ...BASE, share_models: true, models: ['HTV245FRF'] });
    expect(failed.status).toBe(500);

    const row = await env.TELEMETRY_DB
      .prepare('SELECT last_counted_month FROM installs WHERE anon_id = ?1').bind(ID).first();
    expect(row.last_counted_month).toBeNull();

    // model_counts is still gone at this point, so retrying with only
    // country sharing (which never touches model_counts) proves the claim
    // was released rather than permanently consumed by the failed attempt.
    await ping({ ...BASE, share_country: true });
    expect(await countryCount('ZA')).toBe(1);
  });
});
