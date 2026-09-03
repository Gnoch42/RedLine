import { randomBytes } from 'node:crypto';
import { one, all, run } from './db.js';
import { HttpError } from './http.js';

export function createSession(userId, activeTeamId = null) {
  const token = randomBytes(24).toString('base64url');
  run('INSERT INTO sessions (token, user_id, active_team_id) VALUES (?, ?, ?)',
    token, userId, activeTeamId);
  return token;
}

export function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

/** Move this session to another of the delegate's seats. */
export function setActiveTeam(token, teamId) {
  run('UPDATE sessions SET active_team_id = ? WHERE token = ?', teamId, token);
}

/** Give a delegate a seat in a delegation, and sit them in it. */
export function joinTeam(userId, teamId, token) {
  run('INSERT OR IGNORE INTO memberships (user_id, team_id) VALUES (?, ?)', userId, teamId);
  if (token) setActiveTeam(token, teamId);
}

export function isMember(userId, teamId) {
  return !!one('SELECT 1 AS x FROM memberships WHERE user_id = ? AND team_id = ?', userId, teamId);
}

/**
 * The identity behind a request: the delegate, and the delegation they are
 * currently sitting in. team_id / committee_id are null until they have taken a
 * seat somewhere.
 */
export function userFromToken(token) {
  if (!token) return null;
  return one(
    `SELECT u.id, u.email, u.delegate_name,
            s.active_team_id AS team_id,
            t.country_name, t.join_code, t.committee_id,
            c.name AS committee_name, c.description AS committee_description,
            c.total_members, c.committee_code
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN teams t ON t.id = s.active_team_id
       LEFT JOIN committees c ON c.id = t.committee_id
      WHERE s.token = ?`,
    token
  );
}

/** Every seat this delegate holds, across every committee. */
export function seatsOf(userId) {
  return all(
    `SELECT m.team_id, t.country_name, t.join_code,
            c.id AS committee_id, c.name AS committee_name, c.total_members
       FROM memberships m
       JOIN teams t      ON t.id = m.team_id
       JOIN committees c ON c.id = t.committee_id
      WHERE m.user_id = ?
      ORDER BY c.name, t.country_name`,
    userId
  );
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Signed in, but possibly not sitting on any committee yet. */
export function requireUser(req, _res, next) {
  const token = tokenFrom(req);
  const user = userFromToken(token);
  if (!user) return next(new HttpError(401, 'Sign in to continue.'));
  req.token = token;
  req.user = user;
  next();
}

/** Signed in AND in a delegation — everything past the lobby. */
export function requireTeam(req, res, next) {
  requireUser(req, res, (err) => {
    if (err) return next(err);
    if (!req.user.team_id) {
      return next(new HttpError(403, 'Join or create a delegation first.'));
    }
    next();
  });
}

export function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    delegate_name: user.delegate_name,
    seats: seatsOf(user.id),
    team: user.team_id
      ? {
          id: user.team_id,
          country_name: user.country_name,
          join_code: user.join_code,
          committee_id: user.committee_id,
        }
      : null,
    committee: user.team_id
      ? {
          id: user.committee_id,
          name: user.committee_name,
          description: user.committee_description,
          total_members: user.total_members,
          committee_code: user.committee_code,
        }
      : null,
  };
}
