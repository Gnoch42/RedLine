import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

const dataDir = resolve(process.env.REDLINE_DATA_DIR || join(here, '..', 'data'));
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, 'redline.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/**
 * Brings a database created by an earlier build up to the current schema.
 * CREATE TABLE IF NOT EXISTS leaves existing tables alone, so anything that
 * reshapes one has to be spelled out here. Every step is guarded, so this is a
 * no-op on a database that is already current.
 */
function migrate() {
  const users = columnsOf('users');

  // Delegates used to be identified by a "country-committee" username and to
  // belong to exactly one delegation. Both are now wrong: several delegates
  // share a country, and one delegate can sit on several committees.
  if (users.includes('username')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL UNIQUE,
        delegate_name TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
      // Their contact address becomes the account identifier where they gave
      // one and it is unique; otherwise the old username stands in for it.
      db.exec(`INSERT INTO users_new (id, email, delegate_name, created_at)
        SELECT u.id,
               CASE
                 WHEN u.delegate_contact <> ''
                  AND NOT EXISTS (SELECT 1 FROM users o
                                   WHERE o.delegate_contact = u.delegate_contact AND o.id < u.id)
                 THEN lower(u.delegate_contact)
                 ELSE lower(u.username) || '@redline.local'
               END,
               u.delegate_name, u.created_at
          FROM users u`);
      if (users.includes('team_id')) {
        db.exec(`INSERT OR IGNORE INTO memberships (user_id, team_id)
                 SELECT id, team_id FROM users WHERE team_id IS NOT NULL`);
      }
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `Could not migrate the existing database at ${dbPath}: ${err.message}\n` +
        'If it holds nothing you need, delete that file and start again.'
      );
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (!columnsOf('sessions').includes('active_team_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_team_id INTEGER REFERENCES teams(id)');
    // Best effort: put each open session back in the delegation it was in.
    db.exec(`UPDATE sessions SET active_team_id = (
               SELECT m.team_id FROM memberships m WHERE m.user_id = sessions.user_id
                ORDER BY m.id LIMIT 1)`);
  }

  // Propositions and amendments are titled, not described.
  for (const table of ['propositions', 'amendments']) {
    if (columnsOf(table).includes('short_description')) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN short_description`);
    }
  }
}

migrate();

/** Run fn inside a transaction; roll back on throw. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

// Codes people read off a screen and type on a phone: no O/0, I/1, etc.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function code(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** A short unique code for `table`.`column`, formatted XXXX-XXXX. */
export function uniqueCode(table, column) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${code(4)}-${code(4)}`;
    const clash = one(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`, candidate);
    if (!clash) return candidate;
  }
  throw new Error(`could not generate a unique ${table}.${column}`);
}
