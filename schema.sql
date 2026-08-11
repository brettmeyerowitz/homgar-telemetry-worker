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
