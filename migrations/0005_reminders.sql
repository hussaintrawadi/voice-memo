-- Reminders ("remind me to…" in a memo, from Claude, or set in the app) and the devices that receive them.

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  remind_at     INTEGER NOT NULL,                  -- Unix ms
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'done', 'cancelled')),
  origin        TEXT NOT NULL DEFAULT 'app'
                CHECK (origin IN ('voice', 'claude', 'app')),
  recording_id  TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(status, remind_at);
CREATE INDEX idx_reminders_user ON reminders(user_id, remind_at);
CREATE INDEX idx_reminders_recording ON reminders(recording_id);

-- Push targets. Android registers its Firebase Cloud Messaging token here.
CREATE TABLE push_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('android')),
  token         TEXT NOT NULL UNIQUE,
  label         TEXT,
  failures      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX idx_push_devices_user ON push_devices(user_id);
