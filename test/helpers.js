import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'redline-test-'));
  const port = 3000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    env: { ...process.env, REDLINE_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
  }

  const stop = () => {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
  // The server runs in its own process with its own file; a test that needs to
  // act as an operator would (appointing the first administrator) opens it the
  // same way the CLI does.
  return { base, stop, dbPath: join(dataDir, 'redline.db'), stderr: () => stderr };
}

/** Thin fetch wrapper that throws on non-2xx, carrying the server's message. */
export function client(base) {
  return async function api(path, { method = 'GET', body, token, expect } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (expect !== undefined) {
      if (res.status !== expect) {
        throw new Error(`${method} ${path}: expected ${expect}, got ${res.status} ${JSON.stringify(data)}`);
      }
      return data;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || ''}`);
    return data;
  };
}
