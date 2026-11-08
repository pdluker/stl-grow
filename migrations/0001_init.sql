-- stl-grow schema v1

CREATE TABLE areas (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  roast TEXT NOT NULL DEFAULT '',
  sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE habits (
  id         TEXT PRIMARY KEY,
  area_id    TEXT NOT NULL REFERENCES areas(id),
  text       TEXT NOT NULL,
  cadence    TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly')),
  sort       INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- One row per habit per period. period_key: YYYY-MM | YYYY-Www | YYYY-Qn.
-- status: 0 not yet, 1 partial, 2 done, 3 not applicable.
CREATE TABLE statuses (
  habit_id   TEXT NOT NULL REFERENCES habits(id),
  period_key TEXT NOT NULL,
  status     INTEGER NOT NULL CHECK (status BETWEEN 0 AND 3),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (habit_id, period_key)
);
CREATE INDEX statuses_period ON statuses (period_key);

CREATE TABLE reflections (
  month_key  TEXT PRIMARY KEY,
  win        TEXT NOT NULL DEFAULT '',
  miss       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
