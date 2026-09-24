-- On-demand summaries for any date range (Summary tab), plus indexes for project pages.

CREATE TABLE range_summaries (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date         TEXT NOT NULL,                 -- YYYY-MM-DD in the user's timezone, inclusive
  end_date           TEXT NOT NULL,                 -- inclusive
  content            TEXT NOT NULL,                 -- JSON
  stats              TEXT NOT NULL,                 -- JSON, computed in SQL
  source_count       INTEGER NOT NULL,              -- memos covered
  source_updated_at  INTEGER NOT NULL,              -- newest memo change covered (for staleness)
  provider           TEXT,
  model              TEXT,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_range_summaries_range ON range_summaries(user_id, start_date, end_date);
CREATE INDEX idx_range_summaries_recent ON range_summaries(user_id, created_at DESC);

CREATE INDEX idx_thoughts_project ON thoughts(project_id, recorded_at DESC);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_decisions_project ON decisions(project_id, status);
CREATE INDEX idx_questions_project ON questions(project_id, status);
