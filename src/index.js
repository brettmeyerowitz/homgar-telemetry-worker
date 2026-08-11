/**
 * homgar-telemetry-worker — opt-in anonymous telemetry.
 *
 * PRIVACY RULES (see spec 2026-08-11-optin-telemetry-design.md):
 *   - request.cf.country is the ONLY cf field read anywhere in this file, and
 *     only when the payload sets share_country === true.
 *   - No request body, header, or IP is ever logged. Observability is disabled
 *     in wrangler.toml.
 *   - day/month always come from the worker clock, never from client input.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAnonId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/ping':
        return handlePing(request, env);
      case '/__probe':
        return handleProbe(request);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

async function handlePing(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (!isValidAnonId(body.anon_id)) {
    return new Response('Bad Request', { status: 400 });
  }

  const anonId = body.anon_id;
  const integrationVersion = String(body.integration_version ?? 'unknown').slice(0, 32);
  const hassVersion = String(body.hass_version ?? 'unknown').slice(0, 32);

  // Worker clock only. A client-supplied day/ts is ignored so a hostile
  // payload cannot forge history.
  const day = isoDay(new Date());

  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(
      `INSERT INTO installs (anon_id, first_seen, last_seen)
       VALUES (?1, ?2, ?2)
       ON CONFLICT(anon_id) DO UPDATE SET last_seen = ?2`
    ).bind(anonId, day),
    env.TELEMETRY_DB.prepare(
      `INSERT INTO pings (anon_id, day, integration_version, hass_version)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(anon_id, day) DO UPDATE SET
         integration_version = excluded.integration_version,
         hass_version        = excluded.hass_version`
    ).bind(anonId, day, integrationVersion, hassVersion),
  ]);

  return new Response(null, { status: 204 });
}

function handleProbe(request) {
  const cf = request.cf || null;
  return Response.json({
    cf_present: cf !== null,
    keys: cf ? Object.keys(cf).sort() : [],
    values: cf
      ? {
          country: cf.country ?? null,
          city: cf.city ?? null,
          region: cf.region ?? null,
          regionCode: cf.regionCode ?? null,
          postalCode: cf.postalCode ?? null,
          latitude: cf.latitude ?? null,
          longitude: cf.longitude ?? null,
          timezone: cf.timezone ?? null,
          colo: cf.colo ?? null,
          continent: cf.continent ?? null,
          asn: cf.asn ?? null,
          asOrganization: cf.asOrganization ?? null,
        }
      : null,
    cf_ipcountry_header: request.headers.get('CF-IPCountry'),
  });
}
