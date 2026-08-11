import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { purge } from '../src/index.js';

const OLD_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOW = new Date('2026-08-11T00:00:00Z');

beforeAll(async () => {
  for (const stmt of env.TEST_SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await env.TELEMETRY_DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM installs'),
    env.TELEMETRY_DB.prepare('DELETE FROM pings'),
  ]);
});

describe('retention', () => {
  it('deletes pings older than 395 days and keeps newer ones', async () => {
    await env.TELEMETRY_DB.batch([
      env.TELEMETRY_DB.prepare(
        `INSERT INTO pings VALUES (?1, '2025-01-01', '3.0.44', '2026.1.0')`
      ).bind(OLD_ID),
      env.TELEMETRY_DB.prepare(
        `INSERT INTO pings VALUES (?1, '2026-08-10', '3.0.44', '2026.8.1')`
      ).bind(NEW_ID),
    ]);

    await purge(env, NOW);

    const { results } = await env.TELEMETRY_DB.prepare('SELECT day FROM pings').all();
    expect(results.map(r => r.day)).toEqual(['2026-08-10']);
  });

  it('deletes installs unseen for over 90 days and keeps active ones', async () => {
    await env.TELEMETRY_DB.batch([
      env.TELEMETRY_DB.prepare(
        `INSERT INTO installs (anon_id, first_seen, last_seen) VALUES (?1, '2025-01-01', '2025-01-01')`
      ).bind(OLD_ID),
      env.TELEMETRY_DB.prepare(
        `INSERT INTO installs (anon_id, first_seen, last_seen) VALUES (?1, '2026-08-01', '2026-08-10')`
      ).bind(NEW_ID),
    ]);

    await purge(env, NOW);

    const { results } = await env.TELEMETRY_DB.prepare('SELECT anon_id FROM installs').all();
    expect(results.map(r => r.anon_id)).toEqual([NEW_ID]);
  });

  it('never touches the aggregate tables', async () => {
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO country_counts VALUES ('ZA', '2024-01', 5)`
    ).run();

    await purge(env, NOW);

    const row = await env.TELEMETRY_DB
      .prepare(`SELECT count FROM country_counts WHERE country='ZA' AND month='2024-01'`)
      .first();
    expect(row.count).toBe(5);
  });
});
