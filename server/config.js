import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from './db.js';
import defaults from './config.default.js';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, 'config.default.js');
export const configPath = join(dataDir, 'redline.config.js');

// The configuration lives on the data volume rather than in the image, so a
// Docker deployment can change it without rebuilding. First boot leaves a
// fully commented copy there to edit.
if (!existsSync(configPath)) {
  copyFileSync(templatePath, configPath);
  console.log(`Wrote a commented configuration file to ${configPath}`);
}

let loaded = {};
try {
  loaded = (await import(pathToFileURL(configPath).href)).default ?? {};
} catch (err) {
  console.error(`\nCould not read ${configPath}:\n  ${err.message}`);
  console.error('Falling back to the defaults. Fix the file and restart.\n');
}

/** Values the file leaves out fall back to the defaults, section by section. */
const merge = (base, override) => {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
};

export const config = merge(defaults, loaded);

/* ------------------------------------------------------------- validation */

const problems = [];
const { supportThreshold, contacts, password } = config;

if (!(typeof supportThreshold === 'number' && supportThreshold > 0 && supportThreshold <= 1)) {
  problems.push(`supportThreshold must be a fraction between 0 and 1 (got ${supportThreshold})`);
  config.supportThreshold = defaults.supportThreshold;
}
if (!['conference', 'committee', 'delegation'].includes(contacts?.visibility)) {
  problems.push(`contacts.visibility must be 'conference', 'committee' or 'delegation'`);
  config.contacts = { ...defaults.contacts };
}
if (!(Number.isInteger(password?.minLength) && password.minLength >= 8)) {
  problems.push('password.minLength must be a whole number of at least 8');
  config.password.minLength = defaults.password.minLength;
}

const KNOWN_WHO = ['delegate', 'faculty', 'secretariat', 'admin'];
for (const [capability, allowed] of Object.entries(config.permissions)) {
  if (!Array.isArray(allowed)) {
    problems.push(`permissions.${capability} must be a list`);
    config.permissions[capability] = defaults.permissions[capability] ?? [];
    continue;
  }
  const unknown = allowed.filter((who) => !KNOWN_WHO.includes(who));
  if (unknown.length) {
    problems.push(`permissions.${capability} does not understand: ${unknown.join(', ')}`);
  }
}

if (problems.length) {
  console.error(`\nProblems in ${configPath} — using the default for each:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
}

/**
 * May this person do that? 'admin' matches anyone flagged as an administrator
 * whatever their role; the other words match the role on their account.
 */
export function may(user, capability) {
  if (!user) return false;
  const allowed = config.permissions[capability];
  if (!Array.isArray(allowed)) return false;
  if (allowed.includes('admin') && user.is_admin) return true;
  return allowed.includes(user.role);
}

/**
 * Whether `viewer` may see the contact details of someone sitting in `teamId`
 * on `committeeId`. Staff always may: somebody has to be able to reach people.
 */
export function maySeeContacts(viewer, { committeeId = null, teamId = null } = {}) {
  if (!viewer) return false;
  if (viewer.is_admin || viewer.role === 'secretariat') return true;
  switch (config.contacts.visibility) {
    case 'conference': return true;
    case 'committee': return !!committeeId && viewer.committee_id === committeeId;
    case 'delegation': return !!teamId && viewer.team_id === teamId;
    default: return false;
  }
}
