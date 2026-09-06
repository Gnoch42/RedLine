-- Redline schema. Applied idempotently at boot (see db.js).
-- One SQLite file, no migrations framework: the expected scale is a single
-- simulation with a few hundred delegates.

CREATE TABLE IF NOT EXISTS committees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  -- Threshold denominator (§5.4). Set once at creation; deliberately NOT the
  -- number of currently registered teams.
  total_members  INTEGER NOT NULL,
  -- Shared out so other delegations can register their own team in this committee.
  committee_code TEXT    NOT NULL UNIQUE,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A country's delegation within a committee. Login happens at this level (§6).
CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  country_name TEXT    NOT NULL,
  join_code    TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (committee_id, country_name)
);

-- One person, one account, however many committees they sit on. The credential
-- is still the delegation's join code, not a per-user password (spec §6); the
-- email is only how we recognise a returning delegate.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  delegate_name TEXT    NOT NULL,
  -- Optional second way to reach someone during the conference.
  phone         TEXT    NOT NULL DEFAULT '',
  -- delegate | faculty | secretariat
  --   delegate    a country's representative, full rights
  --   faculty     an accompanying teacher, seated with their delegation
  --   secretariat the people running the event: no country, no delegation, and
  --               read-only on the drafting floor
  role          TEXT    NOT NULL DEFAULT 'delegate',
  -- The country this delegate represents, chosen from a list at sign-up. It is
  -- the default when they register a delegation, so nobody files one under a
  -- mistyped name; a delegate on several committees can still override it.
  -- Empty for the secretariat, who speak for no one.
  country       TEXT    NOT NULL DEFAULT '',
  -- The secretariat has no delegation, so no join code to sign in with. They
  -- get one of their own instead.
  personal_code TEXT    UNIQUE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A delegate's seat in one delegation. A delegate may hold several — the same
-- person often represents different countries on different committees.
CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, team_id)
);

-- Where the session is currently sitting. A delegate sits in a delegation, and
-- active_committee_id follows from it; the secretariat sits in a committee with
-- no delegation at all. The two are always written together.
CREATE TABLE IF NOT EXISTS sessions (
  token               TEXT PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  active_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- An agenda item within a committee.
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A proposition belongs to its sponsors, jointly and equally. There is no
-- author-owner: the delegation that types it is simply its first sponsor.
CREATE TABLE IF NOT EXISTS propositions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  -- draft      private to its sponsors
  -- active     public, open to amendment and to new sponsors
  -- collecting every sponsor has declared the text settled; signatures are open
  -- ready      enough of the committee is behind it to present it
  -- withdrawn  taken off the table by its last remaining sponsor
  status             TEXT    NOT NULL DEFAULT 'draft',
  -- Kept for attribution only; it confers nothing.
  author_user_id     INTEGER NOT NULL REFERENCES users(id),
  current_version_id INTEGER REFERENCES versions(id),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Sponsorship is by admission: a delegation asks, and a delegation already
-- sponsoring lets them in. Nobody joins the sponsors unilaterally.
CREATE TABLE IF NOT EXISTS sponsor_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  proposition_id     INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  team_id            INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message            TEXT    NOT NULL DEFAULT '',
  -- pending | accepted | declined
  status             TEXT    NOT NULL DEFAULT 'pending',
  decided_by_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at         TEXT,
  UNIQUE (proposition_id, team_id)
);

-- Immutable content snapshot. parent_version_id chains backwards to version 1.
CREATE TABLE IF NOT EXISTS versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  proposition_id    INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  markdown_content  TEXT    NOT NULL,
  note              TEXT    NOT NULL DEFAULT '',
  author_team_id    INTEGER NOT NULL REFERENCES teams(id),
  parent_version_id INTEGER REFERENCES versions(id),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS amendments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  proposition_id    INTEGER NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  -- The version this amendment was written against. If the proposition moves past
  -- it, the amendment freezes (§5.3).
  base_version_id   INTEGER NOT NULL REFERENCES versions(id),
  name              TEXT    NOT NULL,
  markdown_content  TEXT    NOT NULL,
  proposing_team_id INTEGER NOT NULL REFERENCES teams(id),
  author_user_id    INTEGER NOT NULL REFERENCES users(id),
  -- draft | pending | adopted | frozen | detached | withdrawn
  status            TEXT    NOT NULL DEFAULT 'draft',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Co-authors of an amendment. Distinct from the sponsors of the target
-- proposition, who are the ones whose approval is required (§5.2.4).
CREATE TABLE IF NOT EXISTS amendment_cosponsors (
  amendment_id INTEGER NOT NULL REFERENCES amendments(id) ON DELETE CASCADE,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (amendment_id, team_id)
);

-- A team's standing on a proposition or an amendment.
--   sponsor            jointly responsible for the text
--   ready              this sponsor considers the text settled (§5.4a)
--   signatory          undertakes to sign it as it stands
--   amendment_approval this sponsor accepts an amendment to it
CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_type TEXT    NOT NULL,  -- 'proposition' | 'amendment'
  target_id   INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- The version a signature was given against, so a signature can be shown for
  -- what it is if the sponsors later reopen the text.
  version_id  INTEGER REFERENCES versions(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (team_id, target_type, target_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_versions_prop     ON versions (proposition_id, id);
CREATE INDEX IF NOT EXISTS idx_amendments_prop   ON amendments (proposition_id);
CREATE INDEX IF NOT EXISTS idx_approvals_target  ON approvals (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_propositions_proj ON propositions (project_id);
CREATE INDEX IF NOT EXISTS idx_sponsor_requests   ON sponsor_requests (proposition_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_cttee    ON projects (committee_id);
CREATE INDEX IF NOT EXISTS idx_teams_cttee       ON teams (committee_id);
-- Also constrains databases migrated from a build without the column.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_personal_code
  ON users (personal_code) WHERE personal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memberships_user  ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_team  ON memberships (team_id);
