import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

// schema.sql is read on the Node side in vitest.config.js and passed in as
// the TEST_SCHEMA_SQL binding: the Workers runtime sandbox's node:fs cannot
// read arbitrary project files, only files already in the Worker bundle.
beforeAll(async () => {
  const sql = env.TEST_SCHEMA_SQL;
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    await env.TELEMETRY_DB.prepare(stmt).run();
  }
});

describe('schema', () => {
  it('creates all four tables', async () => {
    const { results } = await env.TELEMETRY_DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all();
    const names = results.map(r => r.name);
    expect(names).toContain('installs');
    expect(names).toContain('pings');
    expect(names).toContain('country_counts');
    expect(names).toContain('model_counts');
  });

  it('never links country to an install', async () => {
    const { results } = await env.TELEMETRY_DB.prepare(
      `PRAGMA table_info(installs)`
    ).all();
    const cols = results.map(r => r.name);
    expect(cols).not.toContain('country');
    expect(cols).not.toContain('models');
  });

  it('never links an install to the country aggregate', async () => {
    const { results } = await env.TELEMETRY_DB.prepare(
      `PRAGMA table_info(country_counts)`
    ).all();
    expect(results.map(r => r.name)).not.toContain('anon_id');
  });

  it('stores dates, not timestamps, on pings', async () => {
    const { results } = await env.TELEMETRY_DB.prepare(
      `PRAGMA table_info(pings)`
    ).all();
    const cols = results.map(r => r.name);
    expect(cols).toContain('day');
    expect(cols).not.toContain('ts');
    expect(cols).not.toContain('timestamp');
  });
});
