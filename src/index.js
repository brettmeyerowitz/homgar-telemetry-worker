/**
 * homgar-telemetry-worker — opt-in anonymous telemetry.
 *
 * TEMPORARY probe build. The only route is /__probe, which exists to answer a
 * single factual question: which request.cf fields does the deployed edge
 * actually populate? This cannot be answered locally — wrangler dev does not
 * populate request.cf at all. Task 7 removes this route.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__probe') {
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
    return new Response('Not Found', { status: 404 });
  },
};
