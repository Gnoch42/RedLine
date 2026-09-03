import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbPath } from './db.js';
import { HttpError } from './http.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { propositionRoutes } from './routes/propositions.js';
import { amendmentRoutes } from './routes/amendments.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(join(here, '..', 'client', 'dist'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: dbPath }));
app.use('/api/auth', authRoutes);
app.use('/api', orgRoutes);
app.use('/api', propositionRoutes);
app.use('/api', amendmentRoutes);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'No such endpoint.')));

// The built frontend is served from this same process — one service, one port.
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('The frontend has not been built yet. Run: npm run build');
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server.' : err.message,
    ...(err.extra || {}),
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Redline listening on http://localhost:${port}`);
  console.log(`Database: ${dbPath}`);
});
