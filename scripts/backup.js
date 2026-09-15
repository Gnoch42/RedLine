/**
 * A consistent snapshot of the database, safe to take while the server runs.
 *
 *   npm run backup                 into <data dir>/backups
 *   npm run backup -- /some/dir    somewhere else
 *   npm run backup -- --keep 14    and prune all but the 14 most recent
 *
 * Copying redline.db by hand is not a backup: in WAL mode the latest writes can
 * still be sitting in redline.db-wal. VACUUM INTO asks SQLite itself for a
 * self-contained copy of everything committed, and does not stop the server.
 *
 * A backup kept on the same disk as the database protects against mistakes,
 * not against losing the disk. Copy these somewhere else too.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { db, dbPath } from '../server/db.js';

const args = process.argv.slice(2);
const keepAt = args.indexOf('--keep');
const keep = keepAt >= 0 ? Number(args[keepAt + 1]) : null;
const target = resolve(
  args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--keep')
    || join(dirname(dbPath), 'backups')
);

mkdirSync(target, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(target, `redline-${stamp}.db`);

// A single quote in the path would end the SQL string; refuse rather than guess.
if (file.includes("'")) {
  console.error(`Refusing a backup path containing a quote: ${file}`);
  process.exit(1);
}
db.exec(`VACUUM INTO '${file}'`);
console.log(`Backed up to ${file}`);

if (Number.isInteger(keep) && keep > 0) {
  const old = readdirSync(target)
    .filter((name) => /^redline-.*\.db$/.test(name))
    .sort()
    .slice(0, -keep);
  for (const name of old) rmSync(join(target, name));
  if (old.length) console.log(`Pruned ${old.length} older backup(s), keeping ${keep}.`);
}

db.close();
