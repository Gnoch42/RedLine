import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

async function register(email, name, country = 'France', extra = {}) {
  const { token } = await api('/api/auth/register', {
    method: 'POST',
    body: { email, delegate_name: name, country, ...extra },
  });
  return token;
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

test('login is an email plus the delegation\'s shared join code', async () => {
  const { user } = await api('/api/auth/login', {
    method: 'POST', body: { email: 'jonas@example.org', join_code: s.germany.joinCode },
  });
  assert.equal(user.team.country_name, 'Germany');
  await api('/api/auth/login', {
    method: 'POST', body: { email: 'jonas@example.org', join_code: 'WRON-GXXX' }, expect: 400,
  });
  await api('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@example.org', join_code: s.germany.joinCode }, expect: 404,
  });
  await api('/api/auth/register', {
    method: 'POST',
    body: { email: 'jonas@example.org', delegate_name: 'Jonas again', country: 'Germany' },
    expect: 409,
  });
});

test('an account carries the country its delegate represents', async () => {
  const token = await register('nadia@example.org', 'Nadia', 'Holy See');
  const { user } = await api('/api/auth/me', { token });
  assert.equal(user.country, 'Holy See');

  // It is a default, not a cage: the same delegate can speak for someone else
  // on another committee.
  const { user: seated } = await api('/api/teams', {
    method: 'POST', token,
    body: { committee_code: s.committeeCode, country_name: 'Sovereign Order of Malta' },
  });
  assert.equal(seated.team.country_name, 'Sovereign Order of Malta');
  assert.equal(seated.country, 'Holy See');

  // And it can be corrected afterwards without touching the seats already held.
  const { user: fixed } = await api('/api/auth/me', {
    method: 'PATCH', token, body: { delegate_name: 'Nadia Haddad', country: 'State of Palestine' },
  });
  assert.equal(fixed.country, 'State of Palestine');
  assert.equal(fixed.delegate_name, 'Nadia Haddad');
  assert.equal(fixed.seats[0].country_name, 'Sovereign Order of Malta');

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

test('the 20% threshold counts distinct delegations, not roles', async () => {
  const sponsor = (token) => api(`/api/propositions/${s.propId}/sponsor`, { method: 'POST', token });
  const sign = (token) => api(`/api/propositions/${s.propId}/sign`, { method: 'POST', token });

  let r = await sponsor(s.france.token);
  assert.equal(r.proposition.support.teams, 1);

  // Brazil takes both roles — one delegation, counted once.
  await sponsor(s.brazil.token);
  r = await sign(s.brazil.token);
  assert.equal(r.proposition.support.teams, 2);
  assert.equal(r.proposition.sponsors.length, 2);
  assert.equal(r.proposition.signatories.length, 1);
  assert.equal(r.proposition.support.eligible, false);

  r = await sign(s.germany.token);
  assert.equal(r.proposition.support.teams, 3);
  assert.equal(r.proposition.support.percent, 0.15);
  assert.equal(r.proposition.support.eligible, false);

  // 4 of 20 delegations = 20% exactly, which is enough.
  r = await sign(s.kenya.token);
  assert.equal(r.proposition.support.teams, 4);
  assert.equal(r.proposition.support.percent, 0.2);
  assert.equal(r.proposition.support.eligible, true);
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
  assert.equal(r.proposition.initiating_team.country_name, 'Kenya');
  assert.equal(r.proposition.current_version.number, 1);
  assert.match(r.proposition.current_version.markdown_content, /Kenya addition/);

  const after = await api(`/api/projects/${s.projectId}/propositions`, { token: s.kenya.token });
  assert.equal(after.propositions.length, before.propositions.length + 1);
});

test('amendments to a proposition with no sponsors cannot be approved into existence', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.india.token,
    body: { name: 'Unsponsored text', content: 'body' },
  });
  await api(`/api/propositions/${proposition.id}/submit`, { method: 'PATCH', token: s.india.token });
  const { amendment } = await api(`/api/propositions/${proposition.id}/amendments`, {
    method: 'POST', token: s.germany.token, body: { name: 'Tweak', content: 'body 2' },
  });
  await api(`/api/amendments/${amendment.id}/submit`, { method: 'PATCH', token: s.germany.token });

  const refused = await api(`/api/amendments/${amendment.id}/approve`, {
    method: 'POST', token: s.germany.token, expect: 409,
  });
  assert.match(refused.error, /no sponsors/);

  // With one sponsor in place, that sponsor alone is enough.
  await api(`/api/propositions/${proposition.id}/sponsor`, { method: 'POST', token: s.india.token });
  const ok = await api(`/api/amendments/${amendment.id}/approve`, { method: 'POST', token: s.india.token });
  assert.equal(ok.adopted, true);
});

test('standing down as a sponsor can release an amendment that was waiting on you', async () => {
  const { proposition } = await api(`/api/projects/${s.projectId}/propositions`, {
    method: 'POST', token: s.india.token,
    body: { name: 'Release test', content: 'alpha' },
  });
  const propId = proposition.id;
  await api(`/api/propositions/${propId}/submit`, { method: 'PATCH', token: s.india.token });
  await api(`/api/propositions/${propId}/sponsor`, { method: 'POST', token: s.india.token });
  await api(`/api/propositions/${propId}/sponsor`, { method: 'POST', token: s.germany.token });

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
      phone: '+1 514 555 0101', role: 'secretariat',
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
    ['POST', `/api/propositions/${s.propId}/sponsor`, undefined],
    ['POST', `/api/propositions/${s.propId}/sign`, undefined],
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

test('the secretariat signs back in with a code of its own', async () => {
  const { user } = await api('/api/auth/me', { token: s.secretariatToken });
  // The code is theirs, not a delegation's, and it is never in the seat list.
  const { committee } = await api(`/api/committees/${s.committeeId}`, { token: s.secretariatToken });
  assert.equal(committee.id, s.committeeId);

  const bad = await api('/api/auth/login', {
    method: 'POST', body: { email: user.email, join_code: s.france.joinCode }, expect: 400,
  });
  assert.match(bad.error, /own code/);
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

test('faculty sit with their delegation and keep a delegate\'s hands', async () => {
  await register('prof@example.org', 'Mme Roy', 'France', { role: 'faculty' });
  // The delegation's join code seats them beside its delegates.
  const { token, user } = await api('/api/auth/login', {
    method: 'POST', body: { email: 'prof@example.org', join_code: s.france.joinCode },
  });
  assert.equal(user.role, 'faculty');
  assert.equal(user.team.country_name, 'France');

  const { propositions } = await api(`/api/projects/${s.projectId}/propositions`, { token });
  assert.ok(propositions.length > 0);
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

  await api(`/api/committees/${s.committeeId}`, {
    method: 'PATCH', token: s.kenya.token,
    body: { name: 'UNDP', description: 'UN Development Programme', total_members: 20 },
  });
  ({ proposition } = await api(`/api/propositions/${s.propId}`, { token: s.kenya.token }));
  assert.equal(proposition.support.eligible, true);

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
