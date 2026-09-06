import { randomBytes } from 'node:crypto';
import { one, all, run } from './db.js';
import { HttpError } from './http.js';

export const ROLES = ['delegate', 'faculty', 'secretariat'];

/** The event's organisers: present everywhere, speaking for no one. */
export const isSecretariat = (user) => user?.role === 'secretariat';

export function createSession(userId) {
  const token = randomBytes(24).toString('base64url');
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
  return token;
}

export function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

/**
 * Seat a session. A delegate sits in a delegation and the committee follows;
 * the secretariat sits in a committee with no delegation. Both columns are only
 * ever written here, so they cannot drift apart.
 */
export function sit(token, { teamId = null, committeeId = null }) {
  const committee = teamId
    ? one('SELECT committee_id FROM teams WHERE id = ?', teamId)?.committee_id
    : committeeId;
  run('UPDATE sessions SET active_team_id = ?, active_committee_id = ? WHERE token = ?',
    teamId, committee ?? null, token);
}

/** Give a delegate a seat in a delegation, and sit them in it. */
export function joinTeam(userId, teamId, token) {
  run('INSERT OR IGNORE INTO memberships (user_id, team_id) VALUES (?, ?)', userId, teamId);
  if (token) sit(token, { teamId });
}

export function isMember(userId, teamId) {
  return !!one('SELECT 1 AS x FROM memberships WHERE user_id = ? AND team_id = ?', userId, teamId);
}

/**
 * The identity behind a request: the person, and where they are sitting.
 * team_id is null for the secretariat, and for anyone who has not taken a seat.
 */
export function userFromToken(token) {
  if (!token) return null;
  return one(
    `SELECT u.id, u.email, u.delegate_name, u.phone, u.role, u.country, u.personal_code,
            s.active_team_id AS team_id,
            s.active_committee_id AS committee_id,
            t.country_name, t.join_code,
            c.name AS committee_name, c.description AS committee_description,
            c.total_members, c.committee_code
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN teams t ON t.id = s.active_team_id
       LEFT JOIN committees c ON c.id = s.active_committee_id
      WHERE s.token = ?`,
    token
  );
}

/** Every seat this person holds. The secretariat holds none, and needs none. */
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

/** Signed in, but possibly not sitting anywhere yet. */
export function requireUser(req, _res, next) {
  const token = tokenFrom(req);
  const user = userFromToken(token);
  if (!user) return next(new HttpError(401, 'Sign in to continue.'));
  req.token = token;
  req.user = user;
  next();
}

/** Signed in and looking at a committee: enough to read it. */
export function requireCommittee(req, res, next) {
  requireUser(req, res, (err) => {
    if (err) return next(err);
    if (!req.user.committee_id) {
      return next(new HttpError(403, 'Open a committee first.'));
    }
    next();
  });
}

/**
 * Enough to act on the drafting floor. The secretariat observes it and never
 * writes to it: they propose nothing, sponsor nothing and approve nothing.
 */
export function requireDelegation(req, res, next) {
  requireCommittee(req, res, (err) => {
    if (err) return next(err);
    if (isSecretariat(req.user)) {
      return next(new HttpError(403,
        'The secretariat observes the drafting floor — proposing, sponsoring and approving are for delegations.'));
    }
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
    phone: user.phone,
    role: user.role,
    country: user.country,
    // Only ever serialised for the account making the request.
    personal_code: user.personal_code || null,
    seats: seatsOf(user.id),
    team: user.team_id
      ? {
          id: user.team_id,
          country_name: user.country_name,
          join_code: user.join_code,
          committee_id: user.committee_id,
        }
      : null,
    committee: user.committee_id
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
