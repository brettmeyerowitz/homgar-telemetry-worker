import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { purge } from '../src/index.js';
import worker from '../src/index.js';

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

describe('scheduled() error propagation', () => {
  afterEach(async () => {
    // Restore the table dropped below so later tests' beforeEach (which
    // deletes from `pings`) still has a table to operate on.
    const createPings = env.TEST_SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .find(s => /CREATE TABLE.*\bpings\b/i.test(s));
    await env.TELEMETRY_DB.prepare(createPings).run();
  });

  it('rejects when purge() fails, instead of silently swallowing the error', async () => {
    // A genuine D1 failure (missing table), not a mock, so the cron
    // scheduled() handler must actually await purge() rather than fire it
    // under ctx.waitUntil() and return success regardless.
    await env.TELEMETRY_DB.prepare('DROP TABLE pings').run();

    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };

    await expect(worker.scheduled({}, env, ctx)).rejects.toThrow();
    // The same failing promise must also have been handed to waitUntil, so
    // the runtime doesn't tear the worker down before it settles.
    expect(waited).toHaveLength(1);
    await expect(waited[0]).rejects.toThrow();
  });
});
