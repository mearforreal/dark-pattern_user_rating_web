-- Idempotent: safe to run on every deploy.

CREATE TABLE IF NOT EXISTS images (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,            -- file name, e.g. app_T3_2_A.png
  group_stem  TEXT NOT NULL,                   -- shared by the original and its variants
  variant     TEXT NOT NULL CHECK (variant IN ('original', 'A', 'B', 'C')),
  is_ai       BOOLEAN NOT NULL,                -- false only for files in images/original
  path        TEXT NOT NULL,                   -- path under public/, e.g. images/variants/x_A.png
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS images_group_stem_idx ON images (group_stem);

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  user_agent      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_started_at_idx ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS selections (
  id             SERIAL PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  group_stem     TEXT NOT NULL,
  image_id       INTEGER NOT NULL REFERENCES images (id),
  is_ai          BOOLEAN NOT NULL,             -- copied from images for easy querying
  tile_position  SMALLINT,                     -- 1-4: where the chosen tile was shown
  response_ms    INTEGER,                      -- time from group shown to pick
  changes        INTEGER NOT NULL DEFAULT 0,   -- times the participant changed their pick
  selected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, group_stem)
);

CREATE TABLE IF NOT EXISTS feedback (
  id           SERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  after_count  INTEGER NOT NULL,               -- number of rated groups when asked
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_session_idx ON feedback (session_id);
