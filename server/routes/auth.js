import { Router } from 'express';
import { one, run } from '../db.js';
import { bad, conflict, missing, str } from '../http.js';
import {
  createSession, destroySession, requireUser, serializeUser, userFromToken,
  joinTeam, isMember, setActiveTeam,
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

/**
 * An account is a person: name, email, and the country they represent. The
 * country is picked from a list rather than typed, and carries over as the
 * default whenever they register a delegation — a delegate who sits on several
 * committees can still speak for someone else on one of them.
 */
authRoutes.post('/register', (req, res) => {
  const email = normalizeEmail(req.body);
  const delegateName = str(req.body, 'delegate_name', { max: 120 });
  const country = str(req.body, 'country', { max: 120 });

  if (one('SELECT id FROM users WHERE email = ?', email)) {
    throw conflict('There is already an account with that email — sign in with it instead.');
  }
  const info = run(
    'INSERT INTO users (email, delegate_name, country) VALUES (?, ?, ?)',
    email, delegateName, country
  );
  const token = createSession(Number(info.lastInsertRowid));
  res.status(201).json({ token, user: serializeUser(userFromToken(token)) });
});

/**
 * §6 — the delegation's join code is the credential. Presenting one also seats
 * the delegate in that delegation, so an invitation and a login are the same
 * gesture. A delegate keeps every seat they have been given.
 */
authRoutes.post('/login', (req, res) => {
  const email = normalizeEmail(req.body);
  const joinCode = str(req.body, 'join_code', { max: 40 }).toUpperCase();

  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user) throw missing('No account with that email. Create one first.');

  const team = one('SELECT * FROM teams WHERE join_code = ?', joinCode);
  if (!team) throw bad('That delegation code is not valid.');

  const token = createSession(user.id, team.id);
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

/** Correct your own name or country — the country picked at sign-up sticks. */
authRoutes.patch('/me', requireUser, (req, res) => {
  const delegateName = str(req.body, 'delegate_name', { max: 120 });
  const country = str(req.body, 'country', { max: 120 });
  run('UPDATE users SET delegate_name = ?, country = ? WHERE id = ?',
    delegateName, country, req.user.id);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/** Move to another committee this delegate already has a seat on. */
authRoutes.post('/switch', requireUser, (req, res) => {
  const teamId = Number(req.body?.team_id);
  if (!isMember(req.user.id, teamId)) throw missing('You do not have a seat in that delegation.');
  setActiveTeam(req.token, teamId);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});
