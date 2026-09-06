import { readFileSync, readdirSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// The Workers runtime sandbox has no access to the real project filesystem
// (its `node:fs` only sees files already in the Worker's module bundle), so
// schema.sql is read here on the Node side, outside the sandbox, and handed
// to the test worker as a binding.
const schemaSql = readFileSync('./schema.sql', 'utf8');

// Likewise, the privacy regression guard needs to inspect the worker's own
// source for forbidden cf field references, but the sandbox's node:fs can't
// reach the project tree either — so the source is read here and handed in
// as a binding too. EVERY file under src/ is concatenated, not just the entry
// point: a guard that only sees index.js silently stops covering the codebase
// the moment a second module is added.
const workerSrc = readdirSync('./src')
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => readFileSync(`./src/${f}`, 'utf8'))
  .join('\n');

// Same story for wrangler.toml: a config test asserts observability stays
// disabled, so the raw file is handed in as a binding rather than trusting
// the sandbox to read it off disk.
const wranglerToml = readFileSync('./wrangler.toml', 'utf8');

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['TELEMETRY_DB'],
          bindings: {
            TEST_SCHEMA_SQL: schemaSql,
            TEST_WORKER_SRC: workerSrc,
            TEST_WRANGLER_TOML: wranglerToml,
            // Mutating env.STATS_TOKEN inside a test's beforeAll does not
            // propagate to the isolated Worker runtime with the installed
            // vitest-pool-workers version, so the test token is injected
            // here as a real miniflare binding instead.
            STATS_TOKEN: 'test-stats-token',
            // Render fresh in tests: the dashboard memo is per-isolate, so a
            // non-zero TTL would leak one test's page into the next.
            DASHBOARD_CACHE_TTL_MS: '0',
          },
        },
      },
    },
  },
});
