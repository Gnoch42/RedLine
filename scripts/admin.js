/**
 * Administrators of a Redline instance, from the machine it runs on.
 *
 *   npm run admin                     list them
 *   npm run admin -- grant a@b.org    make someone an administrator
 *   npm run admin -- revoke a@b.org
 *   npm run admin -- reset a@b.org    issue a one-time password reset code
 *
 * Whoever can run this already has the database file, so shell access is the
 * root of trust here — which is what makes it a safe way to appoint the first
 * administrator without a bootstrap password baked into the image.
 */
import { db, dbPath, one, all, run, uniqueCode } from '../server/db.js';

const [command, email] = process.argv.slice(2);
const address = (email || '').trim().toLowerCase();

// Run on the host of a Docker deployment, this opens a fresh, empty database
// beside the code instead of the real one inside the container — and every
// lookup then fails for a reason that has nothing to do with the email.
const DOCKER_HINT =
  'If Redline runs in Docker, run this inside the container instead, from deploy/:\n' +
  '  docker compose exec app node scripts/admin.js ' + process.argv.slice(2).join(' ');

const find = () => {
  const user = one('SELECT * FROM users WHERE lower(email) = ?', address);
  if (!user) {
    const { n } = one('SELECT COUNT(*) AS n FROM users');
    console.error(`No account with the email ${address || '(none given)'} in ${dbPath}.`);
    if (n === 0) {
      console.error('\nThat database has no accounts at all, so it is almost certainly not the one');
      console.error('your site is using.\n' + DOCKER_HINT);
    }
    process.exit(1);
  }
  return user;
};

switch (command) {
  case undefined:
  case 'list': {
    const admins = all('SELECT email, delegate_name FROM users WHERE is_admin = 1 ORDER BY email');
    if (admins.length === 0) {
      console.log('No administrator yet. Appoint one with:\n  npm run admin -- grant you@example.org');
    } else {
      console.log('Administrators:');
      for (const a of admins) console.log(`  ${a.email.padEnd(34)} ${a.delegate_name}`);
    }
    break;
  }

  case 'grant': {
    const user = find();
    run('UPDATE users SET is_admin = 1 WHERE id = ?', user.id);
    console.log(`${user.email} is now an administrator.`);
    break;
  }

  case 'revoke': {
    const user = find();
    const { n } = one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
    if (user.is_admin && n <= 1) {
      console.error('That is the last administrator. Appoint another one first.');
      process.exit(1);
    }
    run('UPDATE users SET is_admin = 0 WHERE id = ?', user.id);
    console.log(`${user.email} is no longer an administrator.`);
    break;
  }

  case 'reset': {
    const user = find();
    const code = uniqueCode('users', 'reset_code');
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    run('UPDATE users SET reset_code = ?, reset_expires = ? WHERE id = ?', code, expires, user.id);
    console.log(`Reset code for ${user.email}: ${code}`);
    console.log('It is good for one hour and one use. Hand it over in person.');
    break;
  }

  default:
    console.error(`Unknown command "${command}". Use: list | grant | revoke | reset`);
    process.exit(1);
}

db.close();
