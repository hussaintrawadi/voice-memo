PRAGMA foreign_keys=off;

CREATE TABLE reminders_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  remind_at     INTEGER NOT NULL,                  -- Unix ms
  status        TEXT NOT NULL DEFAULT 'suggested'
                CHECK (status IN ('suggested', 'pending', 'sent', 'done', 'cancelled')),
  origin        TEXT NOT NULL DEFAULT 'app'
                CHECK (origin IN ('voice', 'claude', 'app')),
  recording_id  TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO reminders_new SELECT * FROM reminders;
DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;

CREATE INDEX idx_reminders_due ON reminders(status, remind_at);
CREATE INDEX idx_reminders_user ON reminders(user_id, remind_at);
CREATE INDEX idx_reminders_recording ON reminders(recording_id);

PRAGMA foreign_keys=on;
