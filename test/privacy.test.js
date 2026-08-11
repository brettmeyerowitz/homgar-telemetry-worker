import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

// Every geolocation field the edge could hand us, all populated with values
// that would be unmistakable if they leaked into storage or a response.
const FULL_CF = {
  country: 'ZA',
  city: 'LEAKED_CITY',
  region: 'LEAKED_REGION',
  regionCode: 'LEAKED_RC',
  postalCode: 'LEAKED_POSTAL',
  latitude: '-33.92500',
  longitude: '18.42410',
  timezone: 'LEAKED_TZ',
  colo: 'LEAKED_COLO',
  continent: 'LEAKED_CONTINENT',
  asn: 99999,
  asOrganization: 'LEAKED_ASORG',
};

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

async function dumpEverything() {
  const tables = ['installs', 'pings', 'country_counts', 'model_counts'];
  const out = [];
  for (const t of tables) {
    const { results } = await env.TELEMETRY_DB.prepare(`SELECT * FROM ${t}`).all();
    out.push(JSON.stringify(results));
  }
  return out.join('\n');
}

describe('no geo field but country is ever read', () => {
  it('leaks nothing when everything is opted in', async () => {
    const res = await SELF.fetch('https://example.com/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: ID,
        integration_version: '3.0.44',
        hass_version: '2026.8.1',
        share_country: true,
        share_models: true,
        models: ['HTV245FRF'],
      }),
      cf: FULL_CF,
    });
    expect(res.status).toBe(204);

    const dump = await dumpEverything();
    for (const marker of [
      'LEAKED_CITY', 'LEAKED_REGION', 'LEAKED_RC', 'LEAKED_POSTAL',
      'LEAKED_TZ', 'LEAKED_COLO', 'LEAKED_CONTINENT', 'LEAKED_ASORG',
      '-33.92500', '18.42410', '99999',
    ]) {
      expect(dump).not.toContain(marker);
    }
    expect(dump).toContain('ZA'); // country IS stored, on opt-in
  });

  it('stores no country at all when location is declined', async () => {
    await SELF.fetch('https://example.com/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: ID,
        integration_version: '3.0.44',
        hass_version: '2026.8.1',
        share_country: false,
        share_models: false,
      }),
      cf: FULL_CF,
    });
    const dump = await dumpEverything();
    expect(dump).not.toContain('ZA');
  });
});

describe('source-level guard', () => {
  it('never references a forbidden cf field', () => {
    const src = env.TEST_WORKER_SRC;
    for (const field of [
      'cf.city', 'cf.region', 'cf.regionCode', 'cf.postalCode',
      'cf.latitude', 'cf.longitude', 'cf.timezone', 'cf.colo',
      'cf.continent', 'cf.asn', 'cf.asOrganization',
      'CF-Connecting-IP',
    ]) {
      expect(src).not.toContain(field);
    }
  });
});
