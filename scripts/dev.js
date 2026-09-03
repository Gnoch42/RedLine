// Runs the API and the Vite dev server side by side, so `npm run dev` is one
// command. Vite proxies /api to the API process (see client/vite.config.js).
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'client', 'run', 'dev'], {
    stdio: 'inherit',
  }),
];

const stopAll = () => children.forEach((child) => child.kill());
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
children.forEach((child) => child.on('exit', (code) => {
  if (code) { stopAll(); process.exit(code); }
}));
