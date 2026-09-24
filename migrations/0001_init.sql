-- Voice Memo: initial schema (Cloudflare D1 / SQLite)
-- Timestamps are unix epoch milliseconds. Every user-owned row carries user_id.

-- ── Identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  settings    TEXT NOT NULL DEFAULT '{}',          -- JSON: language, providers, notifications
  created_at  INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,                  -- credential id (base64url)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,                     -- base64url COSE key
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                              -- JSON array
  device_name   TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                    -- sha256(token), hex
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  challenge   TEXT NOT NULL,
  user_id     TEXT,
  expires_at  INTEGER NOT NULL
);

-- Per-device tokens for the iOS Shortcut / external capture endpoint.
CREATE TABLE capture_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

-- ── Recordings & transcripts ────────────────────────────────────────────────
CREATE TABLE recordings (
  id                TEXT PRIMARY KEY,              -- generated on the device
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key            TEXT,                          -- NULL once audio is deleted by retention
  mime              TEXT NOT NULL,
  bytes             INTEGER NOT NULL DEFAULT 0,
  duration_sec      REAL,
  recorded_at       INTEGER NOT NULL,
  source            TEXT NOT NULL DEFAULT 'pwa',   -- pwa | shortcut | upload
  part_of           TEXT,                          -- group id when a long recording was split
  part_index        INTEGER,
  status            TEXT NOT NULL DEFAULT 'queued',
    -- queued | transcribing | analyzing | organizing | completed | retrying | failed
  status_detail     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  workflow_id       TEXT,
  title             TEXT,
  title_edited      INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  summary_detailed  TEXT,
  category          TEXT,
  language          TEXT,
  keep_audio        INTEGER NOT NULL DEFAULT 0,    -- pinned: never auto-delete audio
  audio_deleted_at  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_recordings_user_time ON recordings(user_id, recorded_at DESC);
CREATE INDEX idx_recordings_status ON recordings(status, updated_at);
CREATE INDEX idx_recordings_retention ON recordings(audio_deleted_at, keep_audio, recorded_at);

CREATE TABLE transcripts (
  id              TEXT PRIMARY KEY,
  recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('raw', 'cleaned', 'edited')),
  version         INTEGER NOT NULL DEFAULT 1,
  is_current      INTEGER NOT NULL DEFAULT 1,
  text            TEXT NOT NULL,
  segments        TEXT,                            -- JSON [{start,end,text,words?}]
  language        TEXT,
  provider        TEXT,
  model           TEXT,
  prompt_version  TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_transcripts_recording ON transcripts(recording_id, kind, is_current);

CREATE TABLE analyses (
  id              TEXT PRIMARY KEY,
  recording_id    TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  is_current      INTEGER NOT NULL DEFAULT 1,
  provider        TEXT,
  model           TEXT,
  prompt_version  TEXT,
  output          TEXT NOT NULL,                   -- full validated JSON
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_analyses_recording ON analyses(recording_id, is_current);

-- ── Knowledge layer ─────────────────────────────────────────────────────────
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  aliases             TEXT NOT NULL DEFAULT '[]',  -- JSON array
  description         TEXT,
  living_summary      TEXT,                        -- JSON
  summary_updated_at  INTEGER,
  status              TEXT NOT NULL DEFAULT 'active',
  origin              TEXT NOT NULL DEFAULT 'ai',  -- ai | user
  confirmed           INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (user_id, name COLLATE NOCASE)
);

CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name COLLATE NOCASE)
);

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                       -- person | company | product | place
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, kind, name COLLATE NOCASE)
);

CREATE TABLE ideas (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  current_understanding  TEXT,
  status                 TEXT NOT NULL DEFAULT 'new',
    -- new | exploring | developing | actionable | implemented | completed | abandoned | revisited
  suggested_status       TEXT,
  project_id             TEXT REFERENCES projects(id) ON DELETE SET NULL,
  first_seen_at          INTEGER NOT NULL,
  last_seen_at           INTEGER NOT NULL,
  mention_count          INTEGER NOT NULL DEFAULT 1,
  vector_id              TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_ideas_user ON ideas(user_id, last_seen_at DESC);

CREATE TABLE thoughts (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  analysis_id   TEXT,
  idx           INTEGER NOT NULL,                  -- order within the recording
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',          -- key sentences from the transcript
  start_sec     REAL,
  end_sec       REAL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  recorded_at   INTEGER NOT NULL,
  embedded_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_thoughts_recording ON thoughts(recording_id, idx);
CREATE INDEX idx_thoughts_user_time ON thoughts(user_id, recorded_at DESC);
CREATE INDEX idx_thoughts_unembedded ON thoughts(embedded_at) WHERE embedded_at IS NULL;

CREATE VIRTUAL TABLE thoughts_fts USING fts5(
  title, summary, content,
  content = 'thoughts', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mc Mn'"
);
CREATE TRIGGER thoughts_fts_ai AFTER INSERT ON thoughts BEGIN
  INSERT INTO thoughts_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;
CREATE TRIGGER thoughts_fts_ad AFTER DELETE ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
END;
CREATE TRIGGER thoughts_fts_au AFTER UPDATE OF title, summary, content ON thoughts BEGIN
  INSERT INTO thoughts_fts(thoughts_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  INSERT INTO thoughts_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;

-- Whole-recording keyword search (title + summary + current transcript), maintained by the app.
CREATE VIRTUAL TABLE recordings_fts USING fts5(
  recording_id UNINDEXED, user_id UNINDEXED, title, summary, transcript,
  tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mc Mn'"
);

CREATE TABLE thought_topics (
  thought_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (thought_id, topic_id)
);
CREATE INDEX idx_thought_topics_topic ON thought_topics(topic_id);

CREATE TABLE thought_entities (
  thought_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (thought_id, entity_id)
);
CREATE INDEX idx_thought_entities_entity ON thought_entities(entity_id);

CREATE TABLE idea_thoughts (
  idea_id     TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  thought_id  TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'extends',
    -- origin | extends | refines | contradicts | revisits | resolves
  origin      TEXT NOT NULL DEFAULT 'ai',
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (idea_id, thought_id)
);
CREATE INDEX idx_idea_thoughts_thought ON idea_thoughts(thought_id);

CREATE TABLE tasks (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id             TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  thought_id               TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  notes                    TEXT,
  due_date                 TEXT,                   -- YYYY-MM-DD in the user's timezone
  due_text                 TEXT,                   -- what was said, e.g. "tomorrow"
  status                   TEXT NOT NULL DEFAULT 'suggested',
    -- suggested | accepted | dismissed | done
  project_id               TEXT REFERENCES projects(id) ON DELETE SET NULL,
  origin                   TEXT NOT NULL DEFAULT 'ai',
  completed_at             INTEGER,
  completed_by_thought_id  TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status, due_date);
CREATE INDEX idx_tasks_recording ON tasks(recording_id);

CREATE TABLE decisions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id   TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  thought_id     TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  statement      TEXT NOT NULL,
  rationale      TEXT,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  decided_at     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | superseded | reversed | dismissed
  superseded_by  TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  origin         TEXT NOT NULL DEFAULT 'ai',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_decisions_user ON decisions(user_id, status, decided_at DESC);
CREATE INDEX idx_decisions_recording ON decisions(recording_id);

CREATE TABLE questions (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id            TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  thought_id              TEXT REFERENCES thoughts(id) ON DELETE SET NULL,
  question                TEXT NOT NULL,
  project_id              TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
  resolution              TEXT,
  resolved_by_thought_id  TEXT,
  resolved_at             INTEGER,
  origin                  TEXT NOT NULL DEFAULT 'ai',
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_questions_user ON questions(user_id, status, created_at DESC);
CREATE INDEX idx_questions_recording ON questions(recording_id);

-- Generic edges between any two objects (the personal knowledge graph).
CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  from_type   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  relation    TEXT NOT NULL,
  score       REAL,
  origin      TEXT NOT NULL DEFAULT 'ai',
  created_at  INTEGER NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id, relation)
);
CREATE INDEX idx_links_from ON links(from_type, from_id);
CREATE INDEX idx_links_to ON links(to_type, to_id);

CREATE TABLE vocabulary (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  kind        TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT 'learned',     -- learned | user | blocked (removed by the user)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, term COLLATE NOCASE)
);

-- ── Reflection ──────────────────────────────────────────────────────────────
CREATE TABLE summaries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period        TEXT NOT NULL CHECK (period IN ('day', 'week', 'fortnight', 'month')),
  period_start  TEXT NOT NULL,                     -- YYYY-MM-DD (user timezone)
  period_end    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  is_current    INTEGER NOT NULL DEFAULT 1,
  headline      TEXT,
  content       TEXT NOT NULL,                     -- JSON
  stats         TEXT NOT NULL DEFAULT '{}',        -- JSON, computed in SQL
  provider      TEXT,
  model         TEXT,
  emailed_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_summaries_period ON summaries(user_id, period, period_start, version);

CREATE TABLE insights (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                       -- recurring | forgotten | no_action | shift
  text        TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '[]',          -- JSON ids
  dismissed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_insights_user ON insights(user_id, dismissed, created_at DESC);

CREATE TABLE chat_threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  citations   TEXT NOT NULL DEFAULT '[]',
  provider    TEXT,
  model       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, created_at);

-- ── Delivery ────────────────────────────────────────────────────────────────
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE digest_settings (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email                 TEXT,
  daily_enabled         INTEGER NOT NULL DEFAULT 0,
  weekly_enabled        INTEGER NOT NULL DEFAULT 1,
  fortnightly_enabled   INTEGER NOT NULL DEFAULT 0,
  monthly_enabled       INTEGER NOT NULL DEFAULT 1,
  send_hour             INTEGER NOT NULL DEFAULT 8,     -- local hour
  send_weekday          INTEGER NOT NULL DEFAULT 1,     -- 0 = Sunday
  updated_at            INTEGER NOT NULL
);

CREATE TABLE email_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,                -- e.g. week:2026-09-14
  provider_id TEXT,
  sent_at     INTEGER NOT NULL
);

-- ── Provider router ─────────────────────────────────────────────────────────
CREATE TABLE provider_usage (
  day            TEXT NOT NULL,                    -- UTC YYYY-MM-DD
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  requests       INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  audio_seconds  REAL NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0,
  cost_units     INTEGER NOT NULL DEFAULT 0,       -- provider-specific: Workers AI neurons, or micro-USD for credit-based providers
  PRIMARY KEY (day, provider, model)
);

CREATE TABLE provider_state (
  provider        TEXT PRIMARY KEY,
  cooldown_until  INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

-- Key/value config the router reads at runtime (provider order, on/off switches).
CREATE TABLE app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
