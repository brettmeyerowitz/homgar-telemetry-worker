# homgar-telemetry-worker

Opt-in anonymous telemetry for the [HomGar/RainPoint Home Assistant
integration](https://github.com/brettmeyerowitz/homeassistant-homgar). This
document explains exactly what is collected, what is stored, what Cloudflare
sees regardless of anything this project does, and how to verify all of it
yourself.

If you are deciding whether to switch telemetry on, this is the document to
read. It is written to be checked, not trusted.

## 1. What this is

This is an **opt-in, off-by-default** telemetry endpoint. Unless you turn it
on in the integration's settings, nothing is ever sent. If you do turn it on,
it exists to answer one question for the maintainer: **roughly how many
people use this integration, and roughly where in the world are they**, so
that maintenance effort and testing priorities (which device models, which
Home Assistant versions) can be pointed at what people actually run. It is
not analytics, it is not crash reporting, and it does not identify you.

Each opted-in install generates a random UUID (`anon_id`) on first run and
sends a small ping — integration version, Home Assistant version, and
(only if you separately opt into each) your country and device models. That
UUID is not tied to your HomGar account, your Home Assistant instance name,
or anything else identifying. It exists purely so the worker can tell "one
install pinged 40 times" from "40 installs pinged once."

## 2. Exactly what is stored

This is the complete database schema, `schema.sql`, verbatim:

```sql
-- Identifier dimension. Holds NO country and NO device models by design:
-- those are aggregate-only so they cannot be joined back to an install.
CREATE TABLE IF NOT EXISTS installs (
  anon_id            TEXT PRIMARY KEY,
  first_seen         TEXT NOT NULL,   -- "2026-08-11"
  last_seen          TEXT NOT NULL,   -- "2026-08-11"
  last_counted_month TEXT             -- "2026-08", gates monthly aggregation
);

-- Event fact table. DATE only, never a timestamp: this records that an install
-- was active on a given day, not when or for how long. The composite primary
-- key makes writes idempotent and removes all intra-day signal.
CREATE TABLE IF NOT EXISTS pings (
  anon_id             TEXT NOT NULL,
  day                 TEXT NOT NULL,  -- "2026-08-11"
  integration_version TEXT NOT NULL,
  hass_version        TEXT NOT NULL,
  PRIMARY KEY (anon_id, day)
);

CREATE INDEX IF NOT EXISTS idx_pings_day ON pings(day);

-- Aggregate-only. No anon_id column, deliberately.
CREATE TABLE IF NOT EXISTS country_counts (
  country TEXT NOT NULL,
  month   TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (country, month)
);

CREATE TABLE IF NOT EXISTS model_counts (
  model TEXT NOT NULL,
  month TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, month)
);
```

In plain English, table by table:

- **`installs`** — one row per opted-in install: its random ID, the day it
  was first seen, the day it was last seen, and which month (if any) it has
  already been counted toward the aggregate tables below. No country, no
  device model, no version, no IP — nothing else lives here.
- **`pings`** — one row per install per day it was active, recording the
  integration and Home Assistant versions reported that day. This is the
  only table that retains a per-day activity record, and it retains a
  *date*, never a time.
- **`country_counts`** — a running monthly tally of how many opted-in pings
  came from each country, e.g. `("ZA", "2026-08", 41)`. There is no
  `anon_id` column in this table at all — once a count is incremented, the
  individual install that caused it cannot be recovered from this data.
- **`model_counts`** — the same idea for device models, e.g.
  `("HTV245FRF", "2026-08", 12)`. Also has no `anon_id` column, for the
  same reason.

**Country and device models are stored only as these monthly aggregate
counts.** Each opted-in install increments its country's and its models'
counters at most once per calendar month (the `last_counted_month` gate in
`installs`), and the increment happens in the same D1 batch that never
writes `anon_id` into `country_counts` or `model_counts`. There is no column,
join key, or index anywhere in this schema that could connect a country or
model count back to a specific install. This isn't a policy promise layered
on top of a system that could technically do otherwise — the schema makes it
structurally impossible.

## 3. What Cloudflare sees before our code runs

This worker runs behind Cloudflare, and Cloudflare's edge does things to
every request before a single line of this project's code executes. This
section is deliberately the most exhaustive one here, because it's the part
that is easiest to gloss over.

We probed the deployed worker (Workers **free plan**) directly and recorded
every field Cloudflare made available on `request.cf`. The full field list
Cloudflare populated:

| Field | Populated? | Notes |
|---|---|---|
| `country` | Yes | 2-letter code. **The only field this worker ever reads**, and only on opt-in. |
| `city` | Yes | City name. |
| `region` | Yes | Province/state name. |
| `regionCode` | Yes | 2-letter subdivision code. |
| `postalCode` | Yes | Full postal code. |
| `latitude` | Yes | **Five decimal places** — city-level precision, but far finer-grained than most people expect from "an IP address." |
| `longitude` | Yes | Five decimal places, same precision note as above. |
| `timezone` | Yes | IANA timezone name. |
| `colo` | Yes | The nearest Cloudflare datacenter — **not** your location. In our probe it named a different city than `city` did. Coarser than the geolocation fields, but still a location signal, which is exactly why it's never read. |
| `continent` | Yes | 2-letter code. |
| `asn` | Yes | Your network's autonomous system number. |
| `asOrganization` | Yes | Your ISP's name. |
| `CF-IPCountry` header | Yes | Same 2-letter country code as `cf.country`, exposed as a plain request header rather than on `request.cf`. |

A redacted copy of the raw probe result — with the maintainer's own
coordinates and postal code stripped out, since publishing them in a repo
about *not* collecting location data would rather defeat the point — lives
at [`docs/cf-probe-result.json`](docs/cf-probe-result.json).

One caveat worth knowing if you go looking yourself: `request.cf` is **not**
populated when running `wrangler dev` locally, nor in the Cloudflare
dashboard's Quick Edit / Playground preview. Anyone testing only in those
environments will see nothing but the `CF-IPCountry` header and could
reasonably (but wrongly) conclude that's the extent of what Cloudflare
exposes. It isn't — the full table above is what the live edge actually
hands every worker, on every request, on the free plan, with no
configuration required.

> Cloudflare terminates the connection and therefore sees your IP address, as
> any web server does — we never read, log, or store it. Cloudflare also
> derives geolocation at the edge automatically, before our code runs. We do
> not request this and cannot switch it off.

Of everything in the table above, **exactly one field — `country` — is ever
read by this worker's code**, and only when the ping payload explicitly sets
`share_country: true`. Every other field, including the more precise
`latitude`/`longitude` and the coarser-but-still-informative `colo`, is never
referenced anywhere in this codebase. A test (`test/privacy.test.js`) asserts
this at the source level: the test suite fails if the string `cf.city`,
`cf.colo`, `cf.latitude`, or any other forbidden field ever appears in
`src/index.js`, and separately proves that a ping sent with every field
populated stores nothing but the country code, and only when opted in.

## 4. Verify it yourself, on someone else's site

You don't have to take any of the above on faith. Cloudflare exposes the
same edge-derived data through a public debug endpoint on **its own domain**,
unaffiliated with this project or the HomGar integration in any way:

**https://www.cloudflare.com/cdn-cgi/trace**

Visiting it (or `curl`-ing it) returns plain text like:

```
fl=123abc
h=www.cloudflare.com
ip=203.0.113.42
ts=1755000000.000
visit_scheme=https
uag=Mozilla/5.0 ...
colo=CPT
sliver=none
http=http/2
loc=ZA
tls=TLSv1.3
sni=plaintext
warp=off
gateway=off
rbi=off
kex=X25519
```

`ip` is your own IP address as Cloudflare's edge sees it, `loc` is your
country code, and `colo` is the Cloudflare datacenter nearest you — the same
`country` and `colo` values described in the table above, just surfaced as
plain text instead of `request.cf`.

The important thing about this endpoint is that it is **not part of this
project**. It's a debugging feature Cloudflare ships on `cloudflare.com`
itself, and the same `/cdn-cgi/trace` path exists on almost every
Cloudflare-fronted site on the internet — try it on any large site you know
sits behind Cloudflare. That lets you confirm, on domains that have nothing
to do with this integration, that IP-based geolocation at the edge is
ordinary Cloudflare infrastructure behavior, not something this project
introduced or specially requested.

## 5. What is retained, and for how long

| Data | Retention |
|---|---|
| `pings` rows (per-install, per-day activity) | 395 days (13 months) |
| `installs` rows for installs that stop pinging | purged 90 days after their last ping |
| `country_counts` / `model_counts` (monthly aggregates) | kept indefinitely |

A daily scheduled job deletes `pings` rows older than 395 days and
`installs` rows whose `last_seen` is more than 90 days in the past. The
13-month window on `pings` is intentional — it's long enough to compare the
same month year-over-year (e.g. "were more people running the integration
this August than last August") while still being a bounded retention period,
not "forever." The aggregate count tables are never purged, because they
hold no per-install data — an aggregate like `("ZA", "2026-08", 41)` isn't
made more sensitive by keeping it, and the historical trend across months is
the point of collecting it.

To be candid about the actual privacy cost here, rather than downplay it:
for up to 395 days, this worker retains **the specific dates your installed
integration was active**, associated with your anonymous ID. That is a real
retention of behavioral data, even though it is anonymous, coarse (a date,
not a time), and not identifying on its own. It exists because knowing
whether installs come back day after day, versus install-once-and-vanish, is
what makes growth and retention analysis possible at all — a single
cumulative counter can't distinguish "500 steady users" from "50,000 people
who tried it once." If that trade-off doesn't sit right with you, the
correct response is simply not to opt in.

## 6. How to opt out

Telemetry is off by default. If you turned it on and want to stop, turn the
switch off in the integration's Home Assistant settings. No further pings
are sent from that point on. Data already recorded is deleted according to
the retention schedule in section 5 above — there is no separate "delete my
data now" endpoint, because there is no way to look up which anonymous ID is
yours to delete it on request.
