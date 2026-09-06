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

import { renderDashboard } from './dashboard.js';

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
      case '/':
        return handleDashboard(request, env, ctx);
      case '/ping':
        return handlePing(request, env);
      case '/stats':
        return handleStats(request, env);
      case '/health':
        return Response.json({ status: 'ok' });
      default:
        return new Response('Not Found', { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    // Await directly so a purge failure rejects the scheduled() invocation
    // itself and the cron run is marked failed (observability is off, so
    // this is the only signal we get). ctx.waitUntil is kept on the same
    // promise so the runtime doesn't tear down the worker before it settles.
    const task = purge(env);
    ctx.waitUntil(task);
    await task;
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

const MAX_PING_BODY_BYTES = 8192;

async function handlePing(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Reject oversized bodies before request.json() ever parses them, so a
  // hostile payload (e.g. a 200,000-element models array) can't burn CPU
  // parsing/allocating before the later slice(0, 50) bounds it.
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PING_BODY_BYTES) {
    return new Response('Payload Too Large', { status: 413 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
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

  // Only claim the month when this ping actually opts into sharing something
  // aggregatable. If we claimed unconditionally, an install that pings with
  // sharing off would burn its one claim per month and could never be
  // counted once it later turns sharing on within that same month.
  if (body.share_country === true || body.share_models === true) {
    // Read the pre-claim value so a failed aggregate write below can restore
    // it, rather than leaving this install permanently unable to be counted
    // for this month.
    const previous = await env.TELEMETRY_DB
      .prepare(`SELECT last_counted_month FROM installs WHERE anon_id = ?1`)
      .bind(anonId)
      .first();
    const previousMonth = previous ? previous.last_counted_month : null;

    // Atomically claim this month for this install. The UPDATE only matches
    // when the month has not been claimed, so meta.changes === 1 means we
    // won and are the one caller allowed to increment the aggregates. This
    // avoids the read-then-write race a SELECT-based check would have.
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
        const models = [...new Set(
          body.models
            .slice(0, 50)                       // bound a hostile payload before any processing
            .filter(m => typeof m === 'string')
            .map(m => m.slice(0, 64))
            .filter(m => m.length > 0)
        )];
        for (const model of models) {
          aggregates.push(
            env.TELEMETRY_DB.prepare(
              `INSERT INTO model_counts (model, month, count) VALUES (?1, ?2, 1)
               ON CONFLICT(model, month) DO UPDATE SET count = count + 1`
            ).bind(model, month)
          );
        }
      }

      if (aggregates.length) {
        try {
          await env.TELEMETRY_DB.batch(aggregates);
        } catch {
          // The claim already committed but the aggregate writes did not.
          // Restore the pre-claim value so this install is not permanently
          // locked out of being counted for this month.
          await env.TELEMETRY_DB
            .prepare(`UPDATE installs SET last_counted_month = ?2 WHERE anon_id = ?1`)
            .bind(anonId, previousMonth)
            .run();
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    }
  }

  return new Response(null, { status: 204 });
}

/**
 * Constant-time string compare. Comparing SHA-256 digests (rather than the
 * raw strings) means the comparison always walks a fixed 32-byte buffer, so
 * there's no early-return-on-length-mismatch to leak the token's length via
 * timing, the way a direct char-by-char compare would.
 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(b ?? '')),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

// Rendered dashboard, memoised per isolate. A public URL must not hit D1 once
// per view, and Cache-Control alone does not achieve that on Workers. The
// Cache API would be shared across requests in a colo, but it is unusable
// under vitest-pool-workers (caches.default hangs the runner), so this uses a
// module-level memo: same effect within an isolate, and actually testable.
const DASHBOARD_TTL_MS = 900_000;
let dashboardCache = null;

async function handleDashboard(request, env, ctx) {
  // Configurable so a deployment can shorten or disable it; 0 renders fresh.
  const ttl = Number(env.DASHBOARD_CACHE_TTL_MS ?? DASHBOARD_TTL_MS);
  const now = Date.now();
  if (!dashboardCache || now - dashboardCache.at >= ttl) {
    dashboardCache = { at: now, html: renderDashboard(await loadAggregates(env)) };
  }
  return new Response(dashboardCache.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Aggregates move daily, so 15 minutes is generous.
      'cache-control': 'public, max-age=900',
      // Public and linkable, but not accumulating search presence on its own.
      'x-robots-tag': 'noindex',
    },
  });
}


async function handleStats(request, env) {
  // Match the "Bearer" scheme case-insensitively (RFC 7235 scheme tokens are
  // case-insensitive); only the token itself is compared with safeEqual.
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.STATS_TOKEN || !(await safeEqual(provided, env.STATS_TOKEN))) {
    return new Response('Unauthorized', { status: 401 });
  }

  return Response.json(await loadAggregates(env));
}


/**
 * The aggregate queries behind both /stats and the public dashboard.
 * Shared so the two cannot drift: model counts are install-months (the
 * aggregate tables carry no anon_id), and no query here selects one.
 */
export async function loadAggregates(env) {
  const since = isoDay(new Date(Date.now() - 30 * 86400_000));

  const [active, growth, versions, countries, models, headline] = await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(
      `SELECT COUNT(DISTINCT anon_id) AS n FROM pings WHERE day >= ?1`
    ).bind(since),
    env.TELEMETRY_DB.prepare(
      `SELECT day, COUNT(DISTINCT anon_id) AS installs
         FROM pings WHERE day >= ?1 GROUP BY day ORDER BY day`
    ).bind(since),
    env.TELEMETRY_DB.prepare(
      `SELECT integration_version, hass_version, COUNT(DISTINCT anon_id) AS installs
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
    // Headline counts. installs.last_seen / first_seen are DATES, not timestamps.
    env.TELEMETRY_DB.prepare(
      `SELECT COUNT(*) AS installs,
              SUM(CASE WHEN last_seen  >= date('now','-7 day')  THEN 1 ELSE 0 END) AS active_7d,
              SUM(CASE WHEN last_seen  >= date('now','-30 day') THEN 1 ELSE 0 END) AS active_30d,
              SUM(CASE WHEN first_seen >= date('now','-7 day')  THEN 1 ELSE 0 END) AS new_7d,
              MIN(first_seen) AS first_ping,
              MAX(last_seen)  AS latest_ping
         FROM installs`
    ),
  ]);

  const h = headline.results[0] ?? {};
  return {
    active_installs: active.results[0]?.n ?? 0,
    growth: growth.results,
    versions: versions.results,
    countries: countries.results,
    models: models.results,
    installs: h.installs ?? 0,
    active_7d: h.active_7d ?? 0,
    active_30d: h.active_30d ?? 0,
    new_7d: h.new_7d ?? 0,
    first_ping: h.first_ping ?? null,
    latest_ping: h.latest_ping ?? null,
  };
}
