import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, client, unzipDocument } from './helpers.js';

// The generator reads the configuration, which writes itself into the data
// directory on first use — give it one of its own rather than the repository's.
let dataDir;
let nmunWorkingPaper;
let paperFilename;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'redline-export-'));
  process.env.REDLINE_DATA_DIR = dataDir;
  ({ nmunWorkingPaper, paperFilename } = await import('../server/export-nmun.js'));
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

const paper = (markdown, extra = {}) => nmunWorkingPaper({
  proposition: {
    name: 'Resolution on climate finance',
    sponsors: [{ country_name: 'France' }, { country_name: 'Brazil' }],
    signatories: [{ country_name: 'Kenya' }, { country_name: 'Germany' }],
    current_version: { markdown_content: markdown },
    ...extra,
  },
  committeeName: 'UNDP',
  topic: 'Climate finance',
});

test('operative clauses keep their three levels of numbering', async () => {
  const xml = await unzipDocument(await paper(`The Committee,

*Recalling* its resolution 70/1,

1. **Calls upon** Member States to capitalise the mechanism:
   1. at no less than 100 billion per cycle;
   2. reviewed every five years:
      1. by an independent panel;
      2. reporting publicly;
2. **Requests** the Secretariat to report annually;
3. **Decides** to remain seised of the matter.`));

  // 1. / a. / i. in the template, which is three depths in the document.
  const levels = [...xml.matchAll(/<w:ilvl w:val="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(levels, [0, 1, 1, 2, 2, 0, 0]);

  // The emphasis delegates wrote survives the trip.
  assert.match(xml, /<w:i\/>/, 'preambular lead-ins stay italic');
  assert.match(xml, /<w:b\/>/, 'operative verbs stay bold');
  assert.match(xml, /Calls upon/);
});

test('the header block follows the template, alphabetically', async () => {
  const xml = await unzipDocument(await paper('A single clause.'));
  const field = (label) =>
    xml.match(new RegExp(`${label}:\\s*</w:t>[\\s\\S]*?<w:t[^>]*>([^<]*)<`))?.[1];

  assert.equal(field('Code'), '[Leave blank for Dais]');
  assert.equal(field('Committee'), 'UNDP');
  assert.equal(field('Topic'), 'Climate finance');
  assert.equal(field('Sponsors'), 'Brazil, France');
  assert.equal(field('Signatories'), 'Germany, Kenya');
  assert.match(xml, /The UNDP,/);
});

test('a filename survives accents, punctuation and path separators', () => {
  assert.equal(
    paperFilename({ committeeName: 'UNDP • NY', topic: 'Climate/finance', name: 'Résolution: 1' }),
    'UNDP NY - Climate finance - Résolution 1.docx'
  );
  assert.doesNotMatch(paperFilename({ committeeName: '../../etc', name: 'x' }), /\.\.|\//);
});

test('the configuration moves the bar for presenting, and who may draft', async () => {
  const server = await startServer({
    config: `{
      supportThreshold: 0.5,
      permissions: { draft: ['delegate', 'faculty'] },
    }`,
  });
  const api = client(server.base);
  const password = 'a settled draft';

  try {
    const register = async (email, name, country, extra = {}) => (await api('/api/auth/register', {
      method: 'POST', body: { email, delegate_name: name, country, password, ...extra },
    })).token;

    const france = await register('c@example.org', 'Camille', 'France');
    await api('/api/committees', {
      method: 'POST', token: france,
      body: { name: 'UNDP', description: '', total_members: 4, projects: ['Climate finance'] },
    });
    const { user } = await api('/api/auth/me', { token: france });
    const { projects } = await api(`/api/committees/${user.committee.id}/projects`, { token: france });

    const { proposition } = await api(`/api/projects/${projects[0].id}/propositions`, {
      method: 'POST', token: france, body: { name: 'A paper', content: 'Text.' },
    });
    // Half of four seats, not a fifth: one sponsor is not enough.
    assert.equal(proposition.support.threshold, 0.5);
    assert.equal(proposition.support.eligible, false);

    await api(`/api/propositions/${proposition.id}/submit`, { method: 'PATCH', token: france });
    await api(`/api/teams`, {
      method: 'POST',
      token: await register('j@example.org', 'Jonas', 'Germany'),
      body: { committee_id: user.committee.id },
    });

    // Faculty may draft here, which they may not by default.
    const advisor = await register('r@example.org', 'Roy', 'France', { role: 'faculty' });
    const { token: seated } = await api('/api/auth/login', {
      method: 'POST', body: { email: 'r@example.org', password },
    });
    await api('/api/teams/join', {
      method: 'POST', token: advisor, body: { join_code: user.team.join_code },
    });
    const { token: afterJoin } = await api('/api/auth/login', {
      method: 'POST', body: { email: 'r@example.org', password },
    });
    const written = await api(`/api/projects/${projects[0].id}/propositions`, {
      method: 'POST', token: afterJoin, body: { name: 'From the advisor', content: 'x' },
    });
    assert.equal(written.proposition.sponsors[0].country_name, 'France');
    assert.ok(seated);
  } finally {
    server.stop();
  }
});
