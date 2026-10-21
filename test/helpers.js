import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer({ config } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'redline-test-'));
  // Written before the server starts, so it is read like a deployment's own.
  if (config) writeFileSync(join(dataDir, 'redline.config.js'), `export default ${config};\n`);
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

/**
 * The main document out of a .docx, which is a zip. Node ships the inflate, so
 * this reads the central directory rather than pulling in a zip library for
 * one file in one test.
 */
export async function unzipDocument(buffer, wanted = 'word/document.xml') {
  const { inflateRawSync } = await import('node:zlib');
  // End of central directory: the last 22+ bytes, with a comment after it.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');

  let offset = buffer.readUInt32LE(eocd + 16);
  const count = buffer.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
    const localOffset = buffer.readUInt32LE(offset + 42);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);

    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      return (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} not found in the document`);
}
