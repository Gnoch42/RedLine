import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startServer, client } from './helpers.js';

let server;
let api;

// Shared fixture state, built up across the ordered tests below.
const s = {};

before(async () => {
  server = await startServer();
  api = client(server.base);
});

after(() => server.stop());

const PASSWORD = 'a settled draft';

async function register(email, name, country = 'France', extra = {}) {
  const { token } = await api('/api/auth/register', {
    method: 'POST',
    body: { email, delegate_name: name, country, password: PASSWORD, ...extra },
  });
  return token;
}

/** Ask to sponsor, and have an existing sponsor let you in. */
async function admitSponsor(propId, joinerToken, sponsorToken) {
  const asked = await api(`/api/propositions/${propId}/sponsor-request`, {
    method: 'POST', token: joinerToken,
  });
  const mine = asked.proposition.my_roles;
  assert.equal(mine.requested, true);

  const { proposition } = await api(`/api/propositions/${propId}`, { token: sponsorToken });
  const request = proposition.sponsor_requests.at(-1);
  return api(`/api/propositions/${propId}/sponsor-requests/${request.id}/accept`, {
    method: 'POST', token: sponsorToken,
  });
}

async function delegation(email, name, country) {
  const token = await register(email, name, country);
  const { user } = await api('/api/teams', {
    method: 'POST',
    token,
    body: { committee_code: s.committeeCode, country_name: country },
  });
  return { token, teamId: user.team.id, joinCode: user.team.join_code, country };
}

test('a delegate registers, founds a committee and gets both codes', async () => {
  s.france = { token: await register('camille@example.org', 'Camille', 'France') };
  await api('/api/committees', {
    method: 'POST',
    token: s.france.token,
    body: {
      name: 'UNDP',
      description: 'UN Development Programme',
      total_members: 20,
      country_name: 'France',
      projects: ['Climate finance', 'Digital divide'],
    },
  });
  const { user } = await api('/api/auth/me', { token: s.france.token });
  s.committeeId = user.committee.id;
  s.committeeCode = user.committee.committee_code;
  s.france.teamId = user.team.id;
  s.france.joinCode = user.team.join_code;

  assert.equal(user.committee.name, 'UNDP');
  assert.equal(user.committee.total_members, 20);
  assert.equal(user.team.country_name, 'France');
  assert.match(s.committeeCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const { projects } = await api(`/api/committees/${s.committeeId}/projects`, { token: s.france.token });
  assert.deepEqual(projects.map((p) => p.name), ['Climate finance', 'Digital divide']);
  s.projectId = projects[0].id;
});

test('committees are found in a directory, not by chasing a code', async () => {
  const token = await register('directory@example.org', 'Priya', 'Australia');
  const { committees } = await api('/api/committees', { token });
  const undp = committees.find((c) => c.id === s.committeeId);

  assert.equal(undp.name, 'UNDP');
  assert.equal(undp.registered_teams, 1);
  assert.deepEqual(undp.taken_countries, ['France']);
  assert.equal(undp.my_team_id, null);

  // Joining takes an id off that list; the country comes from the account.
  const { user } = await api('/api/teams', {
    method: 'POST', token, body: { committee_id: undp.id, country_name: 'Australia' },
  });
  assert.equal(user.team.country_name, 'Australia');
  assert.equal(user.committee.id, s.committeeId);

  // Coming back, the directory knows where this delegate already sits.
  const { committees: after } = await api('/api/committees', { token });
  assert.equal(after.find((c) => c.id === s.committeeId).my_team_id, user.team.id);
  assert.equal(after.find((c) => c.id === s.committeeId).registered_teams, 2);

  await api('/api/teams', {
    method: 'POST', token, body: { committee_id: 99999, country_name: 'Fiji' }, expect: 404,
  });
});

test('other countries register their own delegations in that committee', async () => {
  s.germany = await delegation('jonas@example.org', 'Jonas', 'Germany');
  s.brazil = await delegation('ana@example.org', 'Ana', 'Brazil');
  s.kenya = await delegation('wanjiru@example.org', 'Wanjiru', 'Kenya');
  s.india = await delegation('ravi@example.org', 'Ravi', 'India');
  s.japan = await delegation('aiko@example.org', 'Aiko', 'Japan');

  // The committee code still works for anyone who prefers to hand one out.
  const dup = await api('/api/teams', {
    method: 'POST',
    token: await register('lea@example.org', 'Léa', 'France'),
    body: { committee_code: s.committeeCode, country_name: 'france' },
    expect: 409,
  });
  assert.match(dup.error, /already has a delegation/);
});

test('a second delegate joins an existing delegation with its join code', async () => {
  const token = await register('theo@example.org', 'Théo', 'France');
  const { user } = await api('/api/teams/join', {
    method: 'POST', token, body: { join_code: s.france.joinCode },
  });
  assert.equal(user.team.id, s.france.teamId);
  s.franceSecondDelegate = token;
});

test('signing in is an email and a password of your own', async () => {
  const { user } = await api('/api/auth/login', {
    method: 'POST', body: { email: 'jonas@example.org', password: PASSWORD },
  });
  assert.equal(user.team.country_name, 'Germany');
  assert.equal(user.has_password, true);

  await api('/api/auth/login', {
    method: 'POST', body: { email: 'jonas@example.org', password: 'not it at all' }, expect: 401,
  });
  await api('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@example.org', password: PASSWORD }, expect: 404,
  });
  await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'jonas@example.org', delegate_name: 'Jonas again', country: 'Germany', password: PASSWORD },
    expect: 409,
  });

  // A delegation's code is an invitation to sit with it, never a way in.
  const notACredential = await api('/api/auth/login', {
    method: 'POST', body: { email: 'jonas@example.org', password: s.germany.joinCode }, expect: 401,
  });
  assert.match(notACredential.error, /does not match/);
});

test('a password has to be long enough to be worth having', async () => {
  for (const [password, why] of [
    ['short', /at least 10/],
    ['weakling@example.org', /not contain your email/],
  ]) {
    const refused = await api('/api/auth/register', {
      method: 'POST',
      body: { email: 'weakling@example.org', delegate_name: 'Pat', country: 'Chile', password },
      expect: 400,
    });
    assert.match(refused.error, why);
  }
  await api('/api/auth/register', {
    method: 'POST', body: { email: 'weakling@example.org', delegate_name: 'Pat', country: 'Chile' },
    expect: 400,
  });
});

test('an administrator can hand back a way in, and nobody else can', async () => {
  const lockedOut = 'forgetful@example.org';
  await register(lockedOut, 'Ida', 'Iceland');
  const { user: ida } = await api('/api/auth/login', {
    method: 'POST', body: { email: lockedOut, password: PASSWORD },
  });
  assert.equal(ida.is_admin, false);

  // Not for delegates, not for the secretariat: administration is its own key.
  await api('/api/auth/admin/users', { token: s.france.token, expect: 403 });

  // The first administrator is appointed from the machine that runs the server,
  // exactly as `npm run admin -- grant` does.
  const disk = new DatabaseSync(server.dbPath);
  disk.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run('camille@example.org');
  disk.close();

  const { users } = await api('/api/auth/admin/users?q=forgetful', { token: s.france.token });
  assert.equal(users.length, 1);
  assert.equal(users[0].email, lockedOut);
  assert.equal(users[0].has_password, true);

  const { reset_code: code } = await api(`/api/auth/admin/users/${users[0].id}/reset`, {
    method: 'POST', token: s.france.token,
  });
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // The code sets a new password, and only that code will do.
  await api('/api/auth/set-password', {
    method: 'POST', body: { email: lockedOut, code: 'WRON-GXXX', password: 'a whole new phrase' },
    expect: 403,
  });
  const { user: back } = await api('/api/auth/set-password', {
    method: 'POST', body: { email: lockedOut, code, password: 'a whole new phrase' },
  });
  assert.equal(back.email, lockedOut);
  await api('/api/auth/login', {
    method: 'POST', body: { email: lockedOut, password: 'a whole new phrase' },
  });

  // One use only.
  await api('/api/auth/set-password', {
    method: 'POST', body: { email: lockedOut, code, password: 'yet another phrase' }, expect: 403,
  });

  // The last administrator cannot stand down and leave nobody holding the keys.
  const me = (await api('/api/auth/admin/users?q=camille', { token: s.france.token })).users[0];
  const stuck = await api(`/api/auth/admin/users/${me.id}/admin`, {
    method: 'POST', token: s.france.token, body: { is_admin: false }, expect: 409,
  });
  assert.match(stuck.error, /last administrator/);
});

test('an account made before passwords sets one with its old code', async () => {
  // Simulate one: an account with no password, as every account was before.
  const disk = new DatabaseSync(server.dbPath);
  disk.prepare(`INSERT INTO users (email, delegate_name, country, role) VALUES (?, ?, ?, 'delegate')`)
    .run('legacy@example.org', 'Old Hand', 'Peru');
  disk.close();

  await api('/api/auth/login', {
    method: 'POST', body: { email: 'legacy@example.org', password: PASSWORD }, expect: 409,
  });

  const { user } = await api('/api/auth/set-password', {
    method: 'POST',
    body: { email: 'legacy@example.org', code: s.japan.joinCode, password: 'the old ways' },
  });
  // The code was an invitation, so it also seated them.
  assert.equal(user.team.country_name, 'Japan');

  // And now that they have one, that invitation is no longer a way in.
  await api('/api/auth/set-password', {
    method: 'POST',
    body: { email: 'legacy@example.org', code: s.japan.joinCode, password: 'trying again' },
    expect: 403,
  });
});

test('an account carries the country its delegate represents', async () => {
  const token = await register('nadia@example.org', 'Nadia', 'Holy See');
  const { user } = await api('/api/auth/me', { token });
  assert.equal(user.country, 'Holy See');

  // A delegate represents one country: the delegation is registered under the
  // account's, whatever the request says.
  const { user: seated } = await api('/api/teams', {
    method: 'POST', token,
    body: { committee_code: s.committeeCode, country_name: 'Sovereign Order of Malta' },
  });
  assert.equal(seated.team.country_name, 'Holy See');

  // Changing it is done on the account, and leaves seats already held alone.
  const { user: fixed } = await api('/api/auth/me', {
    method: 'PATCH', token, body: { delegate_name: 'Nadia Haddad', country: 'State of Palestine' },
  });
  assert.equal(fixed.country, 'State of Palestine');
  assert.equal(fixed.delegate_name, 'Nadia Haddad');
  assert.equal(fixed.seats[0].country_name, 'Holy See');

  await api('/api/auth/register', {
    method: 'POST', body: { email: 'nocountry@example.org', delegate_name: 'Pat' }, expect: 400,
  });
});

test('one delegate can hold seats on several committees and move between them', async () => {
  // Camille founded UNDP for France; here she also takes a seat on UNEP.
  const { user: founded } = await api('/api/committees', {
    method: 'POST', token: s.france.token,
    body: { name: 'UNEP', description: '', total_members: 10, country_name: 'France' },
  });
  assert.equal(founded.committee.name, 'UNEP');
  assert.equal(founded.seats.length, 2);
  const unepTeamId = founded.team.id;

  // The board she sees is the one she is sitting at.
  const unep = await api(`/api/committees/${founded.committee.id}/board`, { token: s.france.token });
  assert.equal(unep.projects.length, 0);

  const { user: back } = await api('/api/auth/switch', {
    method: 'POST', token: s.france.token, body: { team_id: s.france.teamId },
  });
  assert.equal(back.committee.name, 'UNDP');

  const outsiderSeat = await api('/api/auth/switch', {
    method: 'POST', token: s.germany.token, body: { team_id: unepTeamId }, expect: 404,
  });
  assert.match(outsiderSeat.error, /do not have a seat/);
});

test('a draft proposition is the delegation\'s alone, then public once submitted', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST',
    token: s.france.token,
    body: {
      name: 'Resolution on climate finance',
      content: '1. Calls upon Member States to fund the mechanism.\n2. Requests annual reporting.',
    },
  });
  s.propId = proposition.id;
  assert.equal(proposition.status, 'draft');
  assert.equal(proposition.current_version.number, 1);
  // Writing it makes you its first sponsor, not its owner.
  assert.deepEqual(proposition.sponsors.map((x) => x.country_name), ['France']);
  assert.equal(proposition.my_roles.sponsor, true);

  // Invisible to another delegation...
  const others = await api(`/api/projects/${s.projectId}/propositions`, { token: s.germany.token });
  assert.equal(others.propositions.length, 0);
  await api(`/api/propositions/${s.propId}`, { token: s.germany.token, expect: 404 });

  // ...but the author's fellow delegates see it, and can revise it.
  const mate = await api(`/api/projects/${s.projectId}/propositions`, { token: s.franceSecondDelegate });
  assert.equal(mate.propositions.length, 1);
  const mateEdit = await api(`/api/propositions/${s.propId}/versions`, {
    method: 'POST', token: s.franceSecondDelegate,
    body: { content: '1. Calls upon Member States to fund the mechanism.\n2. Requests annual reporting.\n3. Added by a team-mate.' },
  });
  assert.equal(mateEdit.proposition.current_version.number, 2);

  await api(`/api/propositions/${s.propId}/submit`, { method: 'PATCH', token: s.france.token });
  const now = await api(`/api/projects/${s.projectId}/propositions`, { token: s.germany.token });
  assert.equal(now.propositions.length, 1);
  assert.equal(now.propositions[0].status, 'active');
});

test('drafts can be revised in place; live propositions cannot', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.kenya.token,
    body: { name: 'Scratch', content: 'first' },
  });
  const revised = await api(`/api/propositions/${proposition.id}/versions`, {
    method: 'POST', token: s.kenya.token, body: { content: 'second', note: 'reworded' },
  });
  assert.equal(revised.proposition.current_version.number, 2);
  assert.equal(revised.proposition.current_version.markdown_content, 'second');

  const refused = await api(`/api/propositions/${s.propId}/versions`, {
    method: 'POST', token: s.france.token, body: { content: 'nope' }, expect: 409,
  });
  assert.match(refused.error, /amendment/);
  s.kenyaDraftId = proposition.id;
});

test('sponsorship is by admission, and the sponsors carry it jointly', async () => {
  // Nobody joins the sponsors unilaterally.
  const asked = await api(`/api/propositions/${s.propId}/sponsor-request`, {
    method: 'POST', token: s.brazil.token, body: { message: 'We drafted clause 2 with you.' },
  });
  assert.equal(asked.proposition.sponsors.length, 1);
  assert.equal(asked.proposition.sponsor_requests.length, 1);
  assert.equal(asked.proposition.sponsor_requests[0].country_name, 'Brazil');

  // Only a sponsor can decide on it.
  const outsider = await api(
    `/api/propositions/${s.propId}/sponsor-requests/${asked.proposition.sponsor_requests[0].id}/accept`,
    { method: 'POST', token: s.kenya.token, expect: 403 }
  );
  assert.match(outsider.error, /sponsor of this proposition/);

  const admitted = await api(
    `/api/propositions/${s.propId}/sponsor-requests/${asked.proposition.sponsor_requests[0].id}/accept`,
    { method: 'POST', token: s.france.token }
  );
  assert.deepEqual(admitted.proposition.sponsors.map((x) => x.country_name), ['France', 'Brazil']);
  assert.equal(admitted.proposition.sponsor_requests.length, 0);
  assert.equal(admitted.proposition.support.teams, 2);

  // A request can be turned down.
  await api(`/api/propositions/${s.propId}/sponsor-request`, { method: 'POST', token: s.india.token });
  const { proposition } = await api(`/api/propositions/${s.propId}`, { token: s.brazil.token });
  const indias = proposition.sponsor_requests[0];
  const declined = await api(
    `/api/propositions/${s.propId}/sponsor-requests/${indias.id}/decline`,
    { method: 'POST', token: s.brazil.token }
  );
  assert.equal(declined.proposition.sponsors.length, 2);
  assert.equal(declined.proposition.sponsor_requests.length, 0);
});

test('no sponsor can withdraw a proposition over the others’ heads', async () => {
  const refused = await api(`/api/propositions/${s.propId}/withdraw`, {
    method: 'POST', token: s.france.token, expect: 409,
  });
  assert.match(refused.error, /jointly with Brazil/);

  // Standing down is the way out — unless you are the last one holding it.
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.japan.token, body: { name: 'Solo text', content: 'alone' },
  }).then((r) => r);
  await api(`/api/propositions/${proposition.id}/submit`, { method: 'PATCH', token: s.japan.token });

  const stuck = await api(`/api/propositions/${proposition.id}/support/sponsor`, {
    method: 'DELETE', token: s.japan.token, expect: 409,
  });
  assert.match(stuck.error, /only sponsor left/);

  const gone = await api(`/api/propositions/${proposition.id}/withdraw`, {
    method: 'POST', token: s.japan.token,
  });
  assert.equal(gone.proposition.status, 'withdrawn');
});

test('an amendment is adopted only when every sponsor has approved', async () => {
  const { amendment } = await api(`/api/propositions/${s.propId}/amendments`, {
    method: 'POST', token: s.germany.token,
    body: {
      name: 'Add a reporting deadline',
      content: '1. Calls upon Member States to fund the mechanism.\n2. Requests reporting by 31 March each year.\n3. Added by a team-mate.',
      cosponsor_team_ids: [s.kenya.teamId],
    },
  });
  s.amendmentId = amendment.id;
  assert.equal(amendment.status, 'draft');
  assert.deepEqual(amendment.cosponsors.map((c) => c.country_name), ['Kenya']);

  // Private until submitted.
  const hidden = await api(`/api/propositions/${s.propId}/amendments`, { token: s.france.token });
  assert.equal(hidden.amendments.length, 0);

  await api(`/api/amendments/${s.amendmentId}/submit`, { method: 'PATCH', token: s.germany.token });
  const seen = await api(`/api/propositions/${s.propId}/amendments`, { token: s.france.token });
  assert.equal(seen.amendments.length, 1);
  assert.equal(seen.amendments[0].status, 'pending');
  // France and Brazil sponsor the proposition; Kenya only co-authored the amendment.
  assert.equal(seen.amendments[0].approval.required_count, 2);

  await api(`/api/amendments/${s.amendmentId}/approve`, {
    method: 'POST', token: s.kenya.token, expect: 409,
  });

  // Version 2 is the team-mate's revision of the draft; nothing moves on a
  // partial approval.
  let r = await api(`/api/amendments/${s.amendmentId}/approve`, { method: 'POST', token: s.france.token });
  assert.equal(r.adopted, false);
  assert.equal(r.amendment.approval.approved_count, 1);
  assert.equal(r.proposition.current_version.number, 2);

  r = await api(`/api/amendments/${s.amendmentId}/approve`, { method: 'POST', token: s.brazil.token });
  assert.equal(r.adopted, true);
  assert.equal(r.amendment.status, 'adopted');
  assert.equal(r.proposition.current_version.number, 3);
  assert.match(r.proposition.current_version.markdown_content, /31 March/);
  assert.equal(r.proposition.current_version.note, 'Amendment adopted: Add a reporting deadline');

  const { versions } = await api(`/api/propositions/${s.propId}/versions`, { token: s.france.token });
  assert.deepEqual(versions.map((v) => v.number), [1, 2, 3]);
  assert.equal(versions[2].parent_version_id, versions[1].id);
  s.v1 = versions[0].id;
  s.v2 = versions[2].id;
});

test('a rival amendment on the superseded version is frozen, not merged', async () => {
  // Both are written against version 3.
  const mk = async (token, name, content) => {
    const { amendment } = await api(`/api/propositions/${s.propId}/amendments`, {
      method: 'POST', token, body: { name, content },
    });
    await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token });
    return amendment.id;
  };
  const winner = await mk(s.france.token, 'Strengthen clause 1', 'STRONG 1.\n2. Requests reporting by 31 March each year.');
  s.frozenId = await mk(s.kenya.token, 'Soften clause 1', 'SOFT 1.\n2. Requests reporting by 31 March each year.');

  await api(`/api/amendments/${winner}/approve`, { method: 'POST', token: s.france.token });
  const r = await api(`/api/amendments/${winner}/approve`, { method: 'POST', token: s.brazil.token });
  assert.equal(r.adopted, true);

  const { amendment } = await api(`/api/amendments/${s.frozenId}`, { token: s.kenya.token });
  assert.equal(amendment.status, 'frozen');
  assert.equal(amendment.base_version.number, 3);
  assert.equal(amendment.is_stale, true);

  await api(`/api/amendments/${s.frozenId}/approve`, {
    method: 'POST', token: s.france.token, expect: 409,
  });
});

test('an amendment can itself be amended, once, by the delegation it belongs to', async () => {
  const base = 'STRONG 1.\n2. Requests reporting by 31 March each year.\n3. Added by a team-mate.';
  const { amendment } = await api(`/api/propositions/${s.propId}/amendments`, {
    method: 'POST', token: s.germany.token,
    body: { name: 'Name a review venue', content: `${base}\n4. Convenes in Geneva.` },
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.germany.token });

  // Kenya would rather it said Nairobi, so it rewords Germany's amendment.
  const { amendment: sub } = await api(`/api/amendments/${amendment.id}/sub-amendments`, {
    method: 'POST', token: s.kenya.token,
    body: { name: 'Nairobi rather than Geneva', content: `${base}\n4. Convenes in Nairobi.` },
  });
  assert.equal(sub.is_sub, true);
  assert.equal(sub.parent.id, amendment.id);
  assert.equal(sub.parent.country_name, 'Germany');
  // Its base is the parent's: the two go stale together.
  assert.equal(sub.base_version.number, amendment.base_version.number);

  await api(`/api/amendments/${sub.id}/submit`, { method: 'PATCH', token: s.kenya.token });
  const { amendment: pending } = await api(`/api/amendments/${sub.id}`, { token: s.france.token });
  // Not the proposition's sponsors — only the delegation whose text it rewords.
  assert.equal(pending.approval.required_count, 1);
  assert.deepEqual(pending.approval.required.map((r) => r.country_name), ['Germany']);

  const wrongHands = await api(`/api/amendments/${sub.id}/approve`, {
    method: 'POST', token: s.france.token, expect: 409,
  });
  assert.match(wrongHands.error, /whose amendment this rewords/);

  // Germany accepts, and its own amendment takes on Kenya's wording.
  const r = await api(`/api/amendments/${sub.id}/approve`, { method: 'POST', token: s.germany.token });
  assert.equal(r.adopted, true);
  assert.equal(r.amendment.status, 'adopted');
  const { amendment: reworded } = await api(`/api/amendments/${amendment.id}`, {
    token: s.germany.token,
  });
  assert.match(reworded.markdown_content, /Nairobi/);
  assert.equal(reworded.status, 'pending');
  // The sponsors had been asked about different words, so their approvals go.
  assert.equal(reworded.approval.approved_count, 0);

  s.parentAmendmentId = amendment.id;
});

test('a sub-amendment cannot itself be sub-amended', async () => {
  const { amendment } = await api(`/api/amendments/${s.parentAmendmentId}/sub-amendments`, {
    method: 'POST', token: s.india.token,
    body: { name: 'Third thoughts', content: 'something else entirely' },
  });
  // A draft is India's own business, so it has to be on the table before
  // anyone else can even see it, let alone answer it.
  await api(`/api/amendments/${amendment.id}/sub-amendments`, {
    method: 'POST', token: s.brazil.token,
    body: { name: 'Fourth thoughts', content: 'no' }, expect: 404,
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.india.token });

  const refused = await api(`/api/amendments/${amendment.id}/sub-amendments`, {
    method: 'POST', token: s.brazil.token,
    body: { name: 'Fourth thoughts', content: 'no' }, expect: 409,
  });
  assert.match(refused.error, /already a sub-amendment/);
  s.indiaSubId = amendment.id;
});

test('a sub-amendment can be detached to stand as an amendment of its own', async () => {
  const r = await api(`/api/amendments/${s.indiaSubId}/detach`, {
    method: 'POST', token: s.india.token,
  });
  assert.equal(r.amendment.status, 'detached');

  const standalone = r.detached_amendment;
  assert.equal(standalone.is_sub, false);
  assert.equal(standalone.parent, null);
  assert.equal(standalone.status, 'pending');
  assert.equal(standalone.proposing_team.country_name, 'India');
  // Put to the sponsors now, rather than to the delegation it was answering.
  assert.equal(standalone.approval.required_count, 2);
  assert.equal(standalone.markdown_content, 'something else entirely');

  await api(`/api/amendments/${standalone.id}/withdraw`, { method: 'POST', token: s.india.token });
});

test('sub-amendments are left behind when the amendment above them moves', async () => {
  const parentId = s.parentAmendmentId;
  const { amendment: sub } = await api(`/api/amendments/${parentId}/sub-amendments`, {
    method: 'POST', token: s.japan.token,
    body: { name: 'A quieter clause 4', content: 'quiet' },
  });
  await api(`/api/amendments/${sub.id}/submit`, { method: 'PATCH', token: s.japan.token });

  // Germany withdraws the amendment its sub-amendments were answering.
  await api(`/api/amendments/${parentId}/withdraw`, { method: 'POST', token: s.germany.token });

  const { amendment: stranded } = await api(`/api/amendments/${sub.id}`, { token: s.japan.token });
  assert.equal(stranded.status, 'frozen');

  // There is nothing left to reword, so reapplying is refused and detaching is
  // the way out.
  const refused = await api(`/api/amendments/${sub.id}/reapply`, {
    method: 'POST', token: s.japan.token, body: { content: 'quieter' }, expect: 409,
  });
  assert.match(refused.error, /Detach this/);

  const detached = await api(`/api/amendments/${sub.id}/detach`, {
    method: 'POST', token: s.japan.token,
  });
  assert.equal(detached.detached_amendment.is_sub, false);
  await api(`/api/amendments/${detached.detached_amendment.id}/withdraw`, {
    method: 'POST', token: s.japan.token,
  });
});

test('a frozen amendment is reapplied by hand, and loses its old approvals', async () => {
  const { proposition } = await api(`/api/propositions/${s.propId}`, { token: s.kenya.token });
  const rebased = await api(`/api/amendments/${s.frozenId}/reapply`, {
    method: 'POST', token: s.kenya.token,
    body: { content: proposition.current_version.markdown_content + '\n3. Kenya addition.' },
  });
  assert.equal(rebased.amendment.status, 'pending');
  assert.equal(rebased.amendment.is_stale, false);
  assert.equal(rebased.amendment.base_version.number, 4);
  assert.equal(rebased.amendment.approval.approved_count, 0);

  await api(`/api/amendments/${s.frozenId}/reapply`, {
    method: 'POST', token: s.germany.token, body: { content: 'x' }, expect: 403,
  });
});

test('an amendment can be detached into a standalone rival proposition', async () => {
  const before = await api(`/api/projects/${s.projectId}/propositions`, { token: s.kenya.token });
  const r = await api(`/api/amendments/${s.frozenId}/detach`, { method: 'POST', token: s.kenya.token });

  assert.equal(r.amendment.status, 'detached');
  assert.equal(r.proposition.status, 'active');
  // The delegation that wrote it carries it: its first and only sponsor.
  assert.deepEqual(r.proposition.sponsors.map((x) => x.country_name), ['Kenya']);
  assert.equal(r.proposition.current_version.number, 1);
  assert.match(r.proposition.current_version.markdown_content, /Kenya addition/);

  const after = await api(`/api/projects/${s.projectId}/propositions`, { token: s.kenya.token });
  assert.equal(after.propositions.length, before.propositions.length + 1);
});

test('a single sponsor is enough to carry an amendment through', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.india.token,
    body: { name: 'Unsponsored text', content: 'body' },
  });
  // Writing it already made India its sponsor, so the amendment has someone to
  // answer to from the start.
  assert.deepEqual(proposition.sponsors.map((x) => x.country_name), ['India']);
  await api(`/api/propositions/${proposition.id}/submit`, { method: 'PATCH', token: s.india.token });

  const { amendment } = await api(`/api/propositions/${proposition.id}/amendments`, {
    method: 'POST', token: s.germany.token, body: { name: 'Tweak', content: 'body 2' },
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.germany.token });

  const notSponsor = await api(`/api/amendments/${amendment.id}/approve`, {
    method: 'POST', token: s.germany.token, expect: 409,
  });
  assert.match(notSponsor.error, /Only sponsors/);

  const ok = await api(`/api/amendments/${amendment.id}/approve`, {
    method: 'POST', token: s.india.token,
  });
  assert.equal(ok.adopted, true);
});

test('standing down as a sponsor can release an amendment that was waiting on you', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.india.token,
    body: { name: 'Release test', content: 'alpha' },
  });
  const propId = proposition.id;
  await api(`/api/propositions/${propId}/submit`, { method: 'PATCH', token: s.india.token });
  await admitSponsor(propId, s.germany.token, s.india.token);

  const { amendment } = await api(`/api/propositions/${propId}/amendments`, {
    method: 'POST', token: s.brazil.token, body: { name: 'Beta', content: 'beta' },
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.brazil.token });
  const partial = await api(`/api/amendments/${amendment.id}/approve`, { method: 'POST', token: s.india.token });
  assert.equal(partial.adopted, false);

  await api(`/api/propositions/${propId}/support/sponsor`, { method: 'DELETE', token: s.germany.token });
  const { amendment: after } = await api(`/api/amendments/${amendment.id}`, { token: s.brazil.token });
  assert.equal(after.status, 'adopted');
  const { proposition: updated } = await api(`/api/propositions/${propId}`, { token: s.brazil.token });
  assert.equal(updated.current_version.markdown_content, 'beta');
});

test('any two versions can be fetched for comparison', async () => {
  const diff = await api(`/api/propositions/${s.propId}/versions/diff?from=${s.v1}&to=${s.v2}`, {
    token: s.germany.token,
  });
  assert.equal(diff.from.number, 1);
  assert.equal(diff.to.number, 3);
  assert.notEqual(diff.from.markdown_content, diff.to.markdown_content);
});

test('committee membership is a wall: outsiders see nothing', async () => {
  const outsiderToken = await register('sam@example.org', 'Sam', 'Norway');
  await api('/api/committees', {
    method: 'POST', token: outsiderToken,
    body: { name: 'UNESCO', description: '', total_members: 10, country_name: 'Norway' },
  });
  await api(`/api/propositions/${s.propId}`, { token: outsiderToken, expect: 404 });
  await api(`/api/projects/${s.projectId}/propositions`, { token: outsiderToken, expect: 404 });
  await api(`/api/committees/${s.committeeId}/projects`, { token: outsiderToken, expect: 403 });
});

test('unauthenticated and seatless requests are turned away', async () => {
  await api(`/api/propositions/${s.propId}`, { expect: 401 });
  const lonely = await register('kim@example.org', 'Kim', 'Japan');
  await api(`/api/propositions/${s.propId}`, { token: lonely, expect: 403 });
});

test('a phone number rides along with the account', async () => {
  const token = await register('reach@example.org', 'Lin', 'Singapore', { phone: '+65 8123 4567' });
  const { user } = await api('/api/auth/me', { token });
  assert.equal(user.phone, '+65 8123 4567');

  const { user: updated } = await api('/api/auth/me', {
    method: 'PATCH', token,
    body: { delegate_name: 'Lin Wei', phone: '+65 9000 0000', country: 'Singapore' },
  });
  assert.equal(updated.phone, '+65 9000 0000');
});

test('the secretariat observes every committee and writes to none', async () => {
  const { token, user } = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'sg@example.org', delegate_name: 'Marc Aubry',
      phone: '+1 514 555 0101', role: 'secretariat', password: PASSWORD,
    },
  });
  assert.equal(user.role, 'secretariat');
  assert.equal(user.country, '');
  assert.equal(user.seats.length, 0);

  // They can open any committee without holding a seat in it.
  const { user: seated } = await api('/api/auth/switch', {
    method: 'POST', token, body: { committee_id: s.committeeId },
  });
  assert.equal(seated.committee.id, s.committeeId);
  assert.equal(seated.team, null);

  // Reading the room is fine.
  const board = await api(`/api/committees/${s.committeeId}/board`, { token });
  assert.ok(board.projects.length > 0);
  const { proposition } = await api(`/api/propositions/${s.propId}`, { token });
  assert.equal(proposition.my_roles.sponsor, false);

  // Drafts belong to delegations, and the secretariat is in none.
  const visible = board.projects.flatMap((p) => p.propositions);
  assert.equal(visible.some((p) => p.status === 'draft'), false);

  // Everything that would put them on the floor is refused.
  for (const [method, path, body] of [
    ['POST', `/api/projects/${s.projectId}/propositions`, { name: 'No', content: 'x' }],
    ['POST', `/api/propositions/${s.propId}/sponsor-request`, undefined],
    ['POST', `/api/propositions/${s.propId}/sign`, { undertaking: true }],
    ['POST', `/api/propositions/${s.propId}/ready`, undefined],
    ['POST', `/api/propositions/${s.propId}/amendments`, { name: 'No', content: 'x' }],
    ['POST', `/api/amendments/${s.amendmentId}/approve`, undefined],
  ]) {
    const refused = await api(path, { method, token, body, expect: 403 });
    assert.match(refused.error, /secretariat/i);
  }

  // And they never take a delegation, so they never occupy a seat.
  await api('/api/teams', {
    method: 'POST', token, body: { committee_id: s.committeeId, country_name: 'Chad' }, expect: 403,
  });
  const { committees } = await api('/api/committees', { token });
  const undp = committees.find((c) => c.id === s.committeeId);
  assert.equal(undp.taken_countries.includes('Chad'), false);
  assert.equal(undp.my_team_id, null);

  s.secretariatToken = token;
});

test('the secretariat signs in like anyone else, holding no delegation', async () => {
  const { user } = await api('/api/auth/me', { token: s.secretariatToken });
  assert.equal(user.seats.length, 0);
  const { committee } = await api(`/api/committees/${s.committeeId}`, { token: s.secretariatToken });
  assert.equal(committee.id, s.committeeId);

  const { user: back } = await api('/api/auth/login', {
    method: 'POST', body: { email: user.email, password: PASSWORD },
  });
  assert.equal(back.role, 'secretariat');
});

test('a country card gathers its delegates across every committee', async () => {
  const { delegations } = await api('/api/countries/France', { token: s.germany.token });
  const undp = delegations.find((d) => d.committee_id === s.committeeId);

  assert.equal(undp.country_name, 'France');
  // Camille and Théo both sit on the French desk.
  assert.ok(undp.delegates.length >= 2);
  assert.ok(undp.delegates.every((d) => d.email));
  assert.ok(undp.propositions.some((p) => p.id === s.propId));

  // Case does not matter, and unknown countries say so.
  const lower = await api('/api/countries/france', { token: s.germany.token });
  assert.equal(lower.country, 'France');
  await api('/api/countries/Atlantis', { token: s.germany.token, expect: 404 });
});

test('faculty sit with their delegation, and read without writing', async () => {
  s.facultyToken = await register('prof@example.org', 'Mme Roy', 'France', { role: 'faculty' });
  // The delegation's join code seats them beside its delegates.
  await api('/api/teams/join', {
    method: 'POST', token: s.facultyToken, body: { join_code: s.france.joinCode },
  });
  const { token, user } = await api('/api/auth/login', {
    method: 'POST', body: { email: 'prof@example.org', password: PASSWORD },
  });
  assert.equal(user.role, 'faculty');
  assert.equal(user.team.country_name, 'France');
  assert.equal(user.can_draft, false);

  // They see everything their delegation sees, drafts included.
  const { propositions } = await api(`/api/projects/${s.projectId}/propositions`, { token });
  assert.ok(propositions.length > 0);

  const refused = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token, body: { name: 'From the teacher', content: 'x' }, expect: 403,
  });
  assert.match(refused.error, /Faculty observes/);
});

test('a delegation can look in on a committee it holds no seat on', async () => {
  // Japan sits on UNDP; UNEP is another room entirely.
  const { committees } = await api('/api/committees', { token: s.japan.token });
  const unep = committees.find((c) => c.name === 'UNEP');
  assert.equal(unep.may_enter, true);
  assert.equal(unep.my_team_id, null);

  const { user } = await api('/api/auth/switch', {
    method: 'POST', token: s.japan.token, body: { committee_id: unep.id },
  });
  assert.equal(user.committee.id, unep.id);
  assert.equal(user.team, null);
  assert.equal(user.observing, true);
  assert.equal(user.can_draft, false);

  // Looking in does not take a seat: the room's registration is unchanged.
  const { committees: after } = await api('/api/committees', { token: s.japan.token });
  assert.equal(after.find((c) => c.id === unep.id).registered_teams, unep.registered_teams);

  const { projects } = await api(`/api/committees/${unep.id}/board`, { token: s.japan.token });
  const refused = await api(`/api/committees/${unep.id}/projects`, {
    method: 'POST', token: s.japan.token, body: { name: 'Nope' },
  }).then(() => null).catch((err) => err);
  assert.ok(Array.isArray(projects));
  assert.equal(refused, null, 'agenda edits are open to anyone in the room');

  // Back to its own seat.
  await api('/api/auth/switch', {
    method: 'POST', token: s.japan.token, body: { committee_id: s.committeeId },
  });
  const { user: home } = await api('/api/auth/me', { token: s.japan.token });
  assert.equal(home.team.country_name, 'Japan');
});

test('a whitelist decides who may sit, and separately who may look in', async () => {
  const listed = ['France', 'Brazil', 'Germany', 'Kenya', 'India', 'Japan', 'Australia',
    'Holy See'];
  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.france.token,
    body: {
      name: 'UNDP', description: 'UN Development Programme', total_members: 20,
      whitelist_enabled: true, whitelist: listed,
    },
  });

  const { committee, whitelist } = await api(`/api/committees/${s.committeeId}`, {
    token: s.france.token,
  });
  assert.equal(committee.whitelist_enabled, true);
  assert.equal(committee.block_observers, false);
  assert.deepEqual(whitelist, [...listed].sort((a, b) => a.localeCompare(b)));

  // On its own, the list governs seats and nothing else.
  const outsider = await register('outsider2@example.org', 'Tomas', 'Czechia');
  await api('/api/teams', {
    method: 'POST', token: outsider,
    body: { committee_id: s.committeeId, country_name: 'Czechia' }, expect: 403,
  });
  const { user: watching } = await api('/api/auth/switch', {
    method: 'POST', token: outsider, body: { committee_id: s.committeeId },
  });
  assert.equal(watching.committee.id, s.committeeId);
  assert.equal(watching.observing, true);

  // Shutting observers out is a separate switch.
  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.france.token,
    body: {
      name: 'UNDP', description: 'UN Development Programme', total_members: 20,
      whitelist_enabled: true, block_observers: true, whitelist: listed,
    },
  });
  const blocked = await api('/api/auth/switch', {
    method: 'POST', token: outsider, body: { committee_id: s.committeeId }, expect: 403,
  });
  assert.match(blocked.error, /only the countries on its list/);

  // The secretariat is never shut out.
  const { user: staff } = await api('/api/auth/switch', {
    method: 'POST', token: s.secretariatToken, body: { committee_id: s.committeeId },
  });
  assert.equal(staff.committee.id, s.committeeId);

  // And a delegation already seated stays seated.
  const { user: seated } = await api('/api/auth/switch', {
    method: 'POST', token: s.germany.token, body: { committee_id: s.committeeId },
  });
  assert.equal(seated.team.country_name, 'Germany');

  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.france.token,
    body: {
      name: 'UNDP', description: 'UN Development Programme', total_members: 20,
      whitelist_enabled: false, whitelist: listed,
    },
  });
});

test('a committee can be founded with its roster already closed', async () => {
  const token = await register('closed@example.org', 'Ingrid', 'Sweden');
  const { user } = await api('/api/committees', {
    method: 'POST', token,
    body: {
      name: 'ECOSOC', description: '', total_members: 12,
      whitelist_enabled: true, block_observers: true, whitelist: ['Sweden', 'Norway'],
    },
  });
  assert.equal(user.team.country_name, 'Sweden');
  assert.equal(user.committee.whitelist_enabled, true);
  assert.equal(user.committee.block_observers, true);

  const { whitelist } = await api(`/api/committees/${user.committee.id}`, { token });
  assert.deepEqual(whitelist, ['Norway', 'Sweden']);

  const outsider = await register('outsider3@example.org', 'Hugo', 'Peru');
  await api('/api/auth/switch', {
    method: 'POST', token: outsider, body: { committee_id: user.committee.id }, expect: 403,
  });
});

test('a delegate marks which committees they actually work on', async () => {
  const { user } = await api(`/api/auth/seats/${s.france.teamId}`, {
    method: 'PATCH', token: s.france.token, body: { is_primary: true },
  });
  const seat = user.seats.find((x) => x.team_id === s.france.teamId);
  assert.equal(seat.is_primary, 1);

  const { delegations } = await api('/api/countries/France', { token: s.germany.token });
  const undp = delegations.find((d) => d.committee_id === s.committeeId);
  const camille = undp.delegates.find((d) => d.delegate_name === 'Camille');
  assert.equal(camille.is_primary, true);
  // Her fellow delegate has not marked it, so the card shows who works where.
  assert.equal(undp.delegates.some((d) => d.is_primary === false), true);
});

test('the sponsors close the text, then the committee signs it', async () => {
  // Nothing is settled while an amendment is still in front of the sponsors.
  const { amendment } = await api(`/api/propositions/${s.propId}/amendments`, {
    method: 'POST', token: s.india.token, body: { name: 'One more clause', content: 'x' },
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.india.token });
  const blocked = await api(`/api/propositions/${s.propId}/ready`, {
    method: 'POST', token: s.france.token, expect: 409,
  });
  assert.match(blocked.error, /in front of the sponsors/);
  await api(`/api/amendments/${amendment.id}/withdraw`, { method: 'POST', token: s.india.token });

  // Signatures are not open until the sponsors say the text is final.
  const early = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.germany.token, body: { undertaking: true }, expect: 409,
  });
  assert.match(early.error, /not collecting signatures yet/);

  // One sponsor is not all of them.
  let r = await api(`/api/propositions/${s.propId}/ready`, { method: 'POST', token: s.france.token });
  assert.equal(r.proposition.status, 'active');
  assert.equal(r.proposition.readiness.ready_count, 1);
  assert.equal(r.proposition.readiness.sponsor_count, 2);

  r = await api(`/api/propositions/${s.propId}/ready`, { method: 'POST', token: s.brazil.token });
  assert.equal(r.proposition.status, 'collecting');
  assert.equal(r.proposition.readiness.all_ready, true);

  // A settled text cannot be amended behind the signatories' backs.
  const shut = await api(`/api/propositions/${s.propId}/amendments`, {
    method: 'POST', token: s.kenya.token, body: { name: 'Sneak', content: 'y' }, expect: 409,
  });
  assert.match(shut.error, /reopened/);

  // Signing is deliberate, and recorded against the version signed.
  const unconfirmed = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.germany.token, body: {}, expect: 400,
  });
  assert.match(unconfirmed.error, /knowingly/);

  const sponsorSigning = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.brazil.token, body: { undertaking: true }, expect: 409,
  });
  assert.match(sponsorSigning.error, /sponsors carry it/);

  r = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.germany.token, body: { undertaking: true },
  });
  assert.equal(r.proposition.status, 'collecting');
  assert.equal(r.proposition.support.teams, 3);
  const signature = r.proposition.signatories[0];
  assert.equal(signature.country_name, 'Germany');
  assert.equal(signature.version_number, r.proposition.current_version.number);
  assert.equal(signature.stale, false);

  // 4 of 20 delegations is the 20% that makes it presentable.
  r = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.kenya.token, body: { undertaking: true },
  });
  assert.equal(r.proposition.support.teams, 4);
  assert.equal(r.proposition.status, 'ready');

  // Signatories keep coming after the threshold.
  r = await api(`/api/propositions/${s.propId}/sign`, {
    method: 'POST', token: s.india.token, body: { undertaking: true },
  });
  assert.equal(r.proposition.status, 'ready');
  assert.equal(r.proposition.signatories.length, 3);

  // A sponsor taking their word back reopens the text for everyone.
  r = await api(`/api/propositions/${s.propId}/ready`, { method: 'DELETE', token: s.brazil.token });
  assert.equal(r.proposition.status, 'active');
  assert.equal(r.proposition.signatories.length, 3);

  // And an amendment adopted now leaves those signatures visibly behind.
  const { amendment: change } = await api(`/api/propositions/${s.propId}/amendments`, {
    method: 'POST', token: s.kenya.token,
    body: { name: 'Add a final clause', content: 'Wholly rewritten text.' },
  });
  await api(`/api/amendments/${change.id}/submit`, { method: 'PATCH', token: s.kenya.token });
  await api(`/api/amendments/${change.id}/approve`, { method: 'POST', token: s.france.token });
  r = await api(`/api/amendments/${change.id}/approve`, { method: 'POST', token: s.brazil.token });
  assert.equal(r.adopted, true);
  assert.equal(r.proposition.status, 'active');
  assert.equal(r.proposition.readiness.ready_count, 0);
  assert.ok(r.proposition.signatories.every((x) => x.stale));

  // Put it back together for the tests that follow.
  await api(`/api/propositions/${s.propId}/ready`, { method: 'POST', token: s.france.token });
  r = await api(`/api/propositions/${s.propId}/ready`, { method: 'POST', token: s.brazil.token });
  assert.equal(r.proposition.status, 'ready');
});

test('the committee and its agenda can be corrected after the fact', async () => {
  // The seat count is the threshold denominator, so changing it moves every
  // eligibility figure at once: 4 of 20 was enough, 4 of 40 is not.
  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.kenya.token,
    body: { name: 'UNDP', description: 'UN Development Programme', total_members: 40 },
  });
  let { proposition } = await api(`/api/propositions/${s.propId}`, { token: s.kenya.token });
  assert.equal(proposition.support.total_members, 40);
  assert.equal(proposition.support.eligible, false);
  // 5 of 40 is no longer enough, so it falls back to collecting signatures.
  assert.equal(proposition.status, 'collecting');

  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.kenya.token,
    body: { name: 'UNDP', description: 'UN Development Programme', total_members: 20 },
  });
  ({ proposition } = await api(`/api/propositions/${s.propId}`, { token: s.kenya.token }));
  assert.equal(proposition.support.eligible, true);
  assert.equal(proposition.status, 'ready');

  // An agenda item can be renamed, and removed only while it is empty.
  const { project } = await api(`/api/committees/${s.committeeId}/projects`, {
    method: 'POST', token: s.kenya.token, body: { name: 'Typo here' },
  });
  const renamed = await api(`/api/projects/${project.id}`, {
    method: 'PATCH', token: s.germany.token, body: { name: 'Debt relief' },
  });
  assert.equal(renamed.project.name, 'Debt relief');

  const busy = await api(`/api/projects/${s.projectId}`, {
    method: 'DELETE', token: s.kenya.token, expect: 409,
  });
  assert.match(busy.error, /still holds/);

  // Moving an item renumbers the list around it rather than colliding with the
  // position already taken.
  const before = await api(`/api/committees/${s.committeeId}/projects`, { token: s.kenya.token });
  const last = before.projects[before.projects.length - 1];
  await api(`/api/projects/${last.id}`, {
    method: 'PATCH', token: s.kenya.token, body: { name: last.name, position: 0 },
  });
  const moved = await api(`/api/committees/${s.committeeId}/projects`, { token: s.kenya.token });
  assert.equal(moved.projects[0].id, last.id);
  assert.deepEqual(moved.projects.map((p) => p.position), moved.projects.map((_, i) => i));

  await api(`/api/projects/${project.id}`, { method: 'DELETE', token: s.kenya.token });
  const { projects } = await api(`/api/committees/${s.committeeId}/projects`, { token: s.kenya.token });
  assert.equal(projects.some((p) => p.id === project.id), false);
});

test('a delegate can give up a seat, and the country gets it back', async () => {
  // A delegation that has done nothing releases the country when its last
  // delegate stands up.
  const token = await register('passing@example.org', 'Mei', 'China');
  const { user } = await api('/api/teams', {
    method: 'POST', token, body: { committee_id: s.committeeId },
  });
  const teamId = user.team.id;

  const { committees: taken } = await api('/api/committees', { token });
  assert.ok(taken.find((c) => c.id === s.committeeId).taken_countries.includes('China'));

  const gone = await api(`/api/teams/${teamId}/seat`, { method: 'DELETE', token });
  assert.equal(gone.outcome, 'released');
  assert.equal(gone.user.seats.length, 0);
  assert.equal(gone.user.committee, null);

  const { committees: freed } = await api('/api/committees', { token });
  assert.equal(freed.find((c) => c.id === s.committeeId).taken_countries.includes('China'), false);

  // A delegation that has committed itself stays on the record.
  const standing = await api(`/api/teams/${s.germany.teamId}/seat`, {
    method: 'DELETE', token: s.germany.token,
  });
  assert.equal(standing.outcome, 'left_standing');
  const { committees: still } = await api('/api/committees', { token });
  assert.ok(still.find((c) => c.id === s.committeeId).taken_countries.includes('Germany'));

  // And a seat with someone else still in it simply loses one delegate.
  const left = await api(`/api/teams/${s.france.teamId}/seat`, {
    method: 'DELETE', token: s.franceSecondDelegate,
  });
  assert.equal(left.outcome, 'left');
});
