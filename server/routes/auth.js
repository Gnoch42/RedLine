import { Router } from 'express';
import { one, all, run, uniqueCode } from '../db.js';
import { bad, conflict, denied, missing, str, HttpError } from '../http.js';
import {
  createSession, destroySession, requireUser, requireAdmin, serializeUser, userFromToken,
  joinTeam, isMember, sit, ROLES, mayEnterCommittee, seatIn,
} from '../auth.js';
import { assertUsable, hashPassword, verifyPassword } from '../passwords.js';

export const authRoutes = Router();

// Deliberately permissive: enough to catch a typo, not enough to argue with a
// school address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(body) {
  const email = str(body, 'email', { max: 200 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('That does not look like an email address.');
  return email;
}

function normalizeRole(body) {
  const role = (body?.role || 'delegate').trim();
  if (!ROLES.includes(role)) throw bad(`"role" must be one of: ${ROLES.join(', ')}.`);
  return role;
}

/*
 * A slow, in-memory brake on guessing. It forgets everything on restart, which
 * is the right trade at this scale: the point is to make a script tedious, not
 * to keep a ledger.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 60_000;

function throttle(key) {
  const record = attempts.get(key);
  if (record && record.until > Date.now()) {
    const seconds = Math.ceil((record.until - Date.now()) / 1000);
    throw new HttpError(429, `Too many attempts. Try again in ${seconds} seconds.`);
  }
}

function recordFailure(key) {
  const record = attempts.get(key) || { fails: 0, until: 0 };
  record.fails += 1;
  if (record.fails >= MAX_ATTEMPTS) {
    record.until = Date.now() + LOCKOUT_MS;
    record.fails = 0;
  }
  attempts.set(key, record);
}

const clearFailures = (key) => attempts.delete(key);

/**
 * A password says who you are, not where you sit. With exactly one seat there
 * is nothing to choose, so sit down; with several, the lobby asks.
 */
function seatIfObvious(userId, token) {
  const seats = all('SELECT team_id FROM memberships WHERE user_id = ?', userId);
  if (seats.length === 1) sit(token, { teamId: seats[0].team_id });
}

/* --------------------------------------------------------------- accounts */

/**
 * An account is a person: how to reach them, what they are at the conference,
 * and — for anyone speaking for a country — which one. The password is theirs
 * alone; a delegation's join code is an invitation to sit with it, not proof of
 * who you are.
 */
authRoutes.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body);
  const delegateName = str(req.body, 'delegate_name', { max: 120 });
  const phone = str(req.body, 'phone', { required: false, max: 60 });
  const role = normalizeRole(req.body);
  const country = role === 'secretariat' ? '' : str(req.body, 'country', { max: 120 });
  assertUsable(req.body?.password, { email });

  if (one('SELECT id FROM users WHERE email = ?', email)) {
    throw conflict('There is already an account with that email — sign in with it instead.');
  }
  const passwordHash = await hashPassword(req.body.password);
  const info = run(
    `INSERT INTO users (email, delegate_name, phone, role, country, password_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    email, delegateName, phone, role, country, passwordHash
  );
  const token = createSession(Number(info.lastInsertRowid));
  res.status(201).json({ token, user: serializeUser(userFromToken(token)) });
});

authRoutes.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  throttle(email);

  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user) {
    recordFailure(email);
    throw missing('No account with that email. Create one first.');
  }
  if (!user.password_hash) {
    // Made before passwords existed. Their old code sets one, once.
    throw new HttpError(409, 'This account has no password yet. Set one to carry on.', {
      needs_password: true,
    });
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    recordFailure(email);
    throw new HttpError(401, 'That password does not match.');
  }

  clearFailures(email);
  const token = createSession(user.id);
  seatIfObvious(user.id, token);
  res.json({ token, user: serializeUser(userFromToken(token)) });
});

/**
 * Set a password without having one: either an account that predates them,
 * presenting the code it used to sign in with, or someone locked out with a
 * reset code from an administrator. An account that already has a password can
 * only get here with a reset code — otherwise a delegation's shared invitation
 * would be a permanent way in.
 */
authRoutes.post('/set-password', async (req, res) => {
  const email = normalizeEmail(req.body);
  const code = str(req.body, 'code', { max: 40 }).toUpperCase();
  throttle(`set:${email}`);

  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user) {
    recordFailure(`set:${email}`);
    throw missing('No account with that email.');
  }
  assertUsable(req.body?.password, { email });

  const resetValid = !!user.reset_code
    && code === user.reset_code
    && (!user.reset_expires || user.reset_expires > new Date().toISOString());

  let allowed = resetValid;
  let teamToJoin = null;

  if (!allowed && !user.password_hash) {
    if (user.personal_code && code === user.personal_code) {
      allowed = true;
    } else {
      const team = one('SELECT * FROM teams WHERE join_code = ?', code);
      if (team && user.role !== 'secretariat') {
        allowed = true;
        teamToJoin = team;
      }
    }
  }

  if (!allowed) {
    recordFailure(`set:${email}`);
    throw new HttpError(403, user.password_hash
      ? 'That reset code is not valid or has expired. Ask an organiser for a new one.'
      : 'That code is not valid for this account.');
  }

  const passwordHash = await hashPassword(req.body.password);
  run(
    'UPDATE users SET password_hash = ?, reset_code = NULL, reset_expires = NULL WHERE id = ?',
    passwordHash, user.id
  );
  clearFailures(`set:${email}`);

  const token = createSession(user.id);
  if (teamToJoin) joinTeam(user.id, teamToJoin.id, token);
  else seatIfObvious(user.id, token);
  res.json({ token, user: serializeUser(userFromToken(token)) });
});

/** Change your own, which needs the current one. */
authRoutes.post('/password', requireUser, async (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (user.password_hash && !(await verifyPassword(req.body?.current_password || '', user.password_hash))) {
    throw new HttpError(401, 'Your current password does not match.');
  }
  assertUsable(req.body?.password, { email: user.email });
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(req.body.password), user.id);
  res.json({ ok: true });
});

authRoutes.post('/logout', requireUser, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

authRoutes.get('/me', requireUser, (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

/** Correct your own details. Role and email are fixed once chosen. */
authRoutes.patch('/me', requireUser, (req, res) => {
  const delegateName = str(req.body, 'delegate_name', { max: 120 });
  const phone = str(req.body, 'phone', { required: false, max: 60 });
  const country = req.user.role === 'secretariat'
    ? ''
    : str(req.body, 'country', { max: 120 });
  run('UPDATE users SET delegate_name = ?, phone = ?, country = ? WHERE id = ?',
    delegateName, phone, country, req.user.id);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/**
 * Move to a committee. Naming one by id sits you in your seat there if you hold
 * one, and otherwise lets you look in without taking one — not every country is
 * seated on every committee, and watching a room you are not on is ordinary.
 */
authRoutes.post('/switch', requireUser, (req, res) => {
  if (req.body?.committee_id !== undefined) {
    const committeeId = Number(req.body.committee_id);
    if (!one('SELECT id FROM committees WHERE id = ?', committeeId)) {
      throw missing('No such committee.');
    }
    if (!mayEnterCommittee(req.user, committeeId)) {
      throw denied('This committee seats only the countries on its list, and yours is not one of them.');
    }
    const teamId = seatIn(req.user.id, committeeId);
    sit(req.token, teamId ? { teamId } : { committeeId });
    return res.json({ user: serializeUser(userFromToken(req.token)) });
  }

  const teamId = Number(req.body?.team_id);
  if (!isMember(req.user.id, teamId)) throw missing('You do not have a seat in that delegation.');
  sit(req.token, { teamId });
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/** Mark a seat as one you actually work on, or stop. */
authRoutes.patch('/seats/:teamId', requireUser, (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!isMember(req.user.id, teamId)) throw missing('You do not have a seat in that delegation.');
  run('UPDATE memberships SET is_primary = ? WHERE user_id = ? AND team_id = ?',
    req.body?.is_primary ? 1 : 0, req.user.id, teamId);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/* ------------------------------------------------------------------ admin */

const RESET_MINUTES = 60;

/** Everyone with an account, for an administrator looking for one of them. */
authRoutes.get('/admin/users', requireAdmin, (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  res.json({
    users: all(
      `SELECT id, email, delegate_name, role, country, is_admin,
              password_hash IS NOT NULL AS has_password,
              reset_code IS NOT NULL AS has_reset,
              (SELECT COUNT(*) FROM memberships m WHERE m.user_id = users.id) AS seats
         FROM users
        WHERE lower(email) LIKE ? OR lower(delegate_name) LIKE ? OR lower(country) LIKE ?
        ORDER BY delegate_name COLLATE NOCASE
        LIMIT 200`,
      q, q, q
    ).map((u) => ({
      ...u,
      is_admin: !!u.is_admin,
      has_password: !!u.has_password,
      has_reset: !!u.has_reset,
    })),
  });
});

/**
 * Hand someone a way back in. The code is shown to the administrator once, to
 * be passed on in person — there is no mail server in this design, and at a
 * conference the organisers are in the room anyway.
 */
authRoutes.post('/admin/users/:id/reset', requireAdmin, (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!user) throw missing('No such account.');

  const code = uniqueCode('users', 'reset_code');
  const expires = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  run('UPDATE users SET reset_code = ?, reset_expires = ? WHERE id = ?', code, expires, user.id);
  res.json({ reset_code: code, expires_at: expires, minutes: RESET_MINUTES, email: user.email });
});

/** Appoint or stand down another administrator. Never the last one. */
authRoutes.post('/admin/users/:id/admin', requireAdmin, (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!user) throw missing('No such account.');
  const wanted = !!req.body?.is_admin;

  if (!wanted) {
    const { n } = one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
    if (n <= 1 && user.is_admin) {
      throw conflict('That is the last administrator. Appoint another one first.');
    }
  }
  run('UPDATE users SET is_admin = ? WHERE id = ?', wanted ? 1 : 0, user.id);
  res.json({ ok: true });
});
