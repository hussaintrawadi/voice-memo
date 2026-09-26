-- Context awareness: each new memo is compared with what is already open (tasks, decisions,
-- reminders, questions) and updates them when you change your mind. Every change is logged
-- here with the values it replaced, so it can be shown and undone.

CREATE TABLE context_changes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The memo that caused the change.
  recording_id  TEXT REFERENCES recordings(id) ON DELETE SET NULL,
  item_type     TEXT NOT NULL CHECK (item_type IN ('task', 'decision', 'reminder', 'question')),
  item_id       TEXT NOT NULL,
  action        TEXT NOT NULL,
  -- One readable line, e.g. Replaced "Use orange" with "Use yellow".
  summary       TEXT NOT NULL,
  -- The changed columns before and after, as JSON, so undo can restore them exactly.
  before        TEXT NOT NULL,
  after         TEXT NOT NULL,
  -- The words from the memo that justified the change.
  evidence      TEXT,
  created_at    INTEGER NOT NULL,
  undone_at     INTEGER
);
CREATE INDEX idx_context_changes_user ON context_changes(user_id, created_at DESC);
CREATE INDEX idx_context_changes_recording ON context_changes(recording_id);

-- Set once a memo has been compared with open items; the pipeline resumes from here if not.
ALTER TABLE recordings ADD COLUMN reconciled_at INTEGER;

-- Email digests were planned and never built; summaries live in the app.
DROP TABLE IF EXISTS email_log;
DROP TABLE IF EXISTS digest_settings;
