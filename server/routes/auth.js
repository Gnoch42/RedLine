import { Router } from 'express';
import { one, run, uniqueCode } from '../db.js';
import { bad, conflict, denied, missing, str } from '../http.js';
import {
  createSession, destroySession, requireUser, serializeUser, userFromToken,
  joinTeam, isMember, sit, ROLES, mayEnterCommittee, seatIn,
} from '../auth.js';

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

/**
 * An account is a person: how to reach them, what they are at the conference,
 * and — for anyone speaking for a country — which one. The secretariat speaks
 * for no one, so they pick no country and get a code of their own to sign in
 * with, having no delegation whose code they could share.
 */
authRoutes.post('/register', (req, res) => {
  const email = normalizeEmail(req.body);
  const delegateName = str(req.body, 'delegate_name', { max: 120 });
  const phone = str(req.body, 'phone', { required: false, max: 60 });
  const role = normalizeRole(req.body);
  const country = role === 'secretariat'
    ? ''
    : str(req.body, 'country', { max: 120 });

  if (one('SELECT id FROM users WHERE email = ?', email)) {
    throw conflict('There is already an account with that email — sign in with it instead.');
  }
  const personalCode = role === 'secretariat' ? uniqueCode('users', 'personal_code') : null;
  const info = run(
    `INSERT INTO users (email, delegate_name, phone, role, country, personal_code)
     VALUES (?, ?, ?, ?, ?, ?)`,
    email, delegateName, phone, role, country, personalCode
  );
  const token = createSession(Number(info.lastInsertRowid));
  res.status(201).json({ token, user: serializeUser(userFromToken(token)) });
});

/**
 * §6 — the delegation's join code is the credential, and presenting one also
 * seats the delegate in that delegation: an invitation and a login are the same
 * gesture. The secretariat presents their own code instead.
 */
authRoutes.post('/login', (req, res) => {
  const email = normalizeEmail(req.body);
  const code = str(req.body, 'join_code', { max: 40 }).toUpperCase();

  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user) throw missing('No account with that email. Create one first.');

  if (user.personal_code && code === user.personal_code) {
    const token = createSession(user.id);
    return res.json({ token, user: serializeUser(userFromToken(token)) });
  }

  const team = one('SELECT * FROM teams WHERE join_code = ?', code);
  if (!team) throw bad('That code is not valid.');
  if (user.role === 'secretariat') {
    throw bad('Secretariat accounts sign in with their own code, not a delegation’s.');
  }

  const token = createSession(user.id);
  joinTeam(user.id, team.id, token);
  res.json({ token, user: serializeUser(userFromToken(token)) });
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
