import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { bad } from './http.js';

const scryptAsync = promisify(scrypt);

// Deliberately node:crypto and nothing else: the whole point of this project is
// that `docker compose up` needs no compiler and no service. Parameters are
// stored with the hash so they can be raised later without invalidating what is
// already on disk.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_LENGTH = 10;

/** Length over composition rules, as NIST has recommended for years. */
export function assertUsable(password, { email = '' } = {}) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    throw bad(`A password needs at least ${MIN_LENGTH} characters. Length is what matters — a short phrase beats a mangled word.`);
  }
  if (password.length > 200) throw bad('That password is longer than 200 characters.');

  const local = email.split('@')[0]?.toLowerCase();
  const lowered = password.toLowerCase();
  if (local && local.length > 2 && lowered.includes(local)) {
    throw bad('Your password should not contain your email address.');
  }
  if (['password12', 'motdepasse', '1234567890', 'redlineredline'].includes(lowered)) {
    throw bad('Pick something less guessable than that.');
  }
  return password;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PARAMS.keylen, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Constant-time, and false rather than throwing on anything malformed. */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, N, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  try {
    const derived = await scryptAsync(password, Buffer.from(salt, 'base64'), PARAMS.keylen, {
      N: Number(N), r: Number(r), p: Number(p), keylen: PARAMS.keylen,
    });
    const want = Buffer.from(expected, 'base64');
    return derived.length === want.length && timingSafeEqual(derived, want);
  } catch {
    return false;
  }
}
