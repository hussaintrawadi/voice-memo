-- Single-user email + password sign-in replaces passkeys.

DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS auth_challenges;

ALTER TABLE users ADD COLUMN password_hash TEXT;          -- pbkdf2-sha256$<iterations>$<salt>$<hash>
ALTER TABLE users ADD COLUMN password_updated_at INTEGER;
CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE);

ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;

-- Failed sign-in counters, per client IP and one global row, for lockouts.
CREATE TABLE login_attempts (
  key           TEXT PRIMARY KEY,                          -- "ip:<address>" or "global"
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
