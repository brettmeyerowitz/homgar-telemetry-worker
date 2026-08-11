import { readFileSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// The Workers runtime sandbox has no access to the real project filesystem
// (its `node:fs` only sees files already in the Worker's module bundle), so
// schema.sql is read here on the Node side, outside the sandbox, and handed
// to the test worker as a binding.
const schemaSql = readFileSync('./schema.sql', 'utf8');

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['TELEMETRY_DB'],
          bindings: { TEST_SCHEMA_SQL: schemaSql },
        },
      },
    },
  },
});
