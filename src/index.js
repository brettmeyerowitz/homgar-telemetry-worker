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
      case '/stats':
        return handleStats(request, env);
      case '/health':
        return Response.json({ status: 'ok' });
      case '/__probe':
        return handleProbe(request);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(purge(env));
  },
};

const PING_RETENTION_DAYS = 395;    // 13 months, keeps year-on-year comparison
const INSTALL_RETENTION_DAYS = 90;

/**
 * Delete aged rows. Aggregate tables are deliberately never purged — they hold
 * no per-install data, and the historical series is the point.
 */
export async function purge(env, now = new Date()) {
  const pingCutoff    = isoDay(new Date(now.getTime() - PING_RETENTION_DAYS * 86400_000));
  const installCutoff = isoDay(new Date(now.getTime() - INSTALL_RETENTION_DAYS * 86400_000));

  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(`DELETE FROM pings WHERE day < ?1`).bind(pingCutoff),
    env.TELEMETRY_DB.prepare(`DELETE FROM installs WHERE last_seen < ?1`).bind(installCutoff),
  ]);
}

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

  const month = day.slice(0, 7);

  // Atomically claim this month for this install. The UPDATE only matches when
  // the month has not been claimed, so meta.changes === 1 means we won and are
  // the one caller allowed to increment the aggregates. This avoids the
  // read-then-write race a SELECT-based check would have.
  const claim = await env.TELEMETRY_DB.prepare(
    `UPDATE installs SET last_counted_month = ?2
      WHERE anon_id = ?1
        AND (last_counted_month IS NULL OR last_counted_month <> ?2)`
  ).bind(anonId, month).run();

  if (claim.meta.changes === 1) {
    const aggregates = [];

    if (body.share_country === true) {
      // The ONLY read of request.cf in this file.
      const country = request.cf?.country ?? null;
      if (country) {
        aggregates.push(
          env.TELEMETRY_DB.prepare(
            `INSERT INTO country_counts (country, month, count) VALUES (?1, ?2, 1)
             ON CONFLICT(country, month) DO UPDATE SET count = count + 1`
          ).bind(String(country).slice(0, 2), month)
        );
      }
    }

    if (body.share_models === true && Array.isArray(body.models)) {
      const models = [...new Set(body.models.filter(m => typeof m === 'string'))]
        .slice(0, 50)                       // bound a hostile payload
        .map(m => m.slice(0, 64));
      for (const model of models) {
        aggregates.push(
          env.TELEMETRY_DB.prepare(
            `INSERT INTO model_counts (model, month, count) VALUES (?1, ?2, 1)
             ON CONFLICT(model, month) DO UPDATE SET count = count + 1`
          ).bind(model, month)
        );
      }
    }

    if (aggregates.length) await env.TELEMETRY_DB.batch(aggregates);
  }

  return new Response(null, { status: 204 });
}

/** Constant-time string compare, so token checking does not leak length/prefix. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleStats(request, env) {
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!env.STATS_TOKEN || !safeEqual(provided, env.STATS_TOKEN)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const since = isoDay(new Date(Date.now() - 30 * 86400_000));

  const [active, growth, versions, countries, models] = await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(
      `SELECT COUNT(DISTINCT anon_id) AS n FROM pings WHERE day >= ?1`
    ).bind(since),
    env.TELEMETRY_DB.prepare(
      `SELECT day, COUNT(DISTINCT anon_id) AS installs
         FROM pings WHERE day >= ?1 GROUP BY day ORDER BY day`
    ).bind(since),
    env.TELEMETRY_DB.prepare(
      `SELECT integration_version, hass_version, COUNT(*) AS installs
         FROM pings WHERE day >= ?1
        GROUP BY integration_version, hass_version
        ORDER BY installs DESC`
    ).bind(since),
    env.TELEMETRY_DB.prepare(
      `SELECT country, month, count FROM country_counts ORDER BY month DESC, count DESC`
    ),
    env.TELEMETRY_DB.prepare(
      `SELECT model, month, count FROM model_counts ORDER BY month DESC, count DESC`
    ),
  ]);

  // Note: no query here selects anon_id. Aggregates only.
  return Response.json({
    active_installs: active.results[0]?.n ?? 0,
    growth: growth.results,
    versions: versions.results,
    countries: countries.results,
    models: models.results,
  });
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
