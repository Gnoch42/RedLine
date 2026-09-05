/**
 * Fills a running Redline instance with a worked example: one committee, six
 * delegations, a live proposition with sponsors, an adopted amendment and a
 * frozen rival. Handy for a demo, or for looking at the UI with real content.
 *
 *   npm start        # in one terminal — leave it running
 *   npm run seed     # in another
 *
 * Point it somewhere else with REDLINE_URL, e.g.
 *   REDLINE_URL=http://localhost:8080 npm run seed
 */
const BASE = (process.env.REDLINE_URL || 'http://localhost:3000').replace(/\/$/, '');
const stamp = Math.random().toString(36).slice(2, 6);

class SeedError extends Error {}

async function call(path, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SeedError(
      `Could not reach Redline at ${BASE} (${err.cause?.code || err.message}).\n\n` +
      'The seed script talks to a running server over HTTP; it does not start one.\n' +
      '  1. In another terminal: npm start   (or: docker compose up)\n' +
      '  2. Check the address it prints, then run this again.\n' +
      `  3. If it is not on ${BASE}, say so: REDLINE_URL=http://localhost:8080 npm run seed`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SeedError(`${method} ${path} failed (${res.status}): ${data.error || 'unknown error'}`);
  }
  return data;
}

/** Fail early and clearly if there is nothing listening. */
async function preflight() {
  const health = await call('/health');
  if (!health.ok) throw new SeedError(`${BASE} answered, but is not a healthy Redline server.`);
  console.log(`Seeding ${BASE} (database: ${health.db})`);
}

const register = async (email, name, country) =>
  (await call('/auth/register', { method: 'POST', body: { email, delegate_name: name, country } })).token;

const TEXT = `The Committee,

*Recalling* its resolution 70/1 on the 2030 Agenda for Sustainable Development,

*Noting with concern* the shortfall in climate finance pledged to developing states,

1. **Calls upon** Member States to capitalise the replenishment mechanism at no less than 100 billion USD per cycle;
2. **Requests** the Secretariat to report on disbursement annually;
3. **Decides** to remain seised of the matter.`;

const AMENDED = TEXT.replace(
  '2. **Requests** the Secretariat to report on disbursement annually;',
  '2. **Requests** the Secretariat to report on disbursement by 31 March each year, disaggregated by recipient region;'
);

const RIVAL = TEXT.replace(
  'at no less than 100 billion USD per cycle',
  'at no less than 250 billion USD per cycle'
);

const main = async () => {
  await preflight();

  const founder = await register(`camille.${stamp}@example.org`, 'Camille Fournier', 'France');
  await call('/committees', {
    method: 'POST', token: founder,
    body: {
      name: `UNDP ${stamp.toUpperCase()}`,
      description: 'UN Development Programme',
      total_members: 20,
      country_name: 'France',
      projects: ['Climate finance', 'Digital divide', 'Debt relief'],
    },
  });
  const { user: fr } = await call('/auth/me', { token: founder });
  const committeeId = fr.committee.id;

  const delegations = { France: { token: founder, user: fr } };
  for (const [country, delegate] of [
    ['Germany', 'Jonas Weber'], ['Brazil', 'Ana Ribeiro'], ['Kenya', 'Wanjiru Otieno'],
    ['India', 'Ravi Menon'], ['Japan', 'Aiko Tanaka'],
  ]) {
    const email = `${delegate.split(' ')[0].toLowerCase()}.${stamp}@example.org`;
    const token = await register(email, delegate, country);
    const { user } = await call('/teams', {
      method: 'POST', token, body: { committee_id: committeeId, country_name: country },
    });
    delegations[country] = { token, user };
  }
  const token = (country) => delegations[country].token;

  // A second delegate on the French desk, to show that a delegation shares its
  // drafts and its join code.
  const colleague = await register(`theo.${stamp}@example.org`, 'Théo Marchand', 'France');
  await call('/teams/join', {
    method: 'POST', token: colleague, body: { join_code: fr.team.join_code },
  });

  const { projects } = await call(`/committees/${fr.committee.id}/projects`, { token: founder });
  const project = projects[0];

  const { proposition } = await call(`/projects/${project.id}/propositions`, {
    method: 'POST', token: founder,
    body: { name: 'Resolution on climate finance replenishment', content: TEXT },
  });
  await call(`/propositions/${proposition.id}/submit`, { method: 'PATCH', token: founder });

  await call(`/propositions/${proposition.id}/sponsor`, { method: 'POST', token: founder });
  await call(`/propositions/${proposition.id}/sponsor`, { method: 'POST', token: token('Brazil') });
  for (const country of ['Germany', 'Kenya', 'Japan']) {
    await call(`/propositions/${proposition.id}/sign`, { method: 'POST', token: token(country) });
  }

  // One amendment goes all the way through...
  const { amendment: adopted } = await call(`/propositions/${proposition.id}/amendments`, {
    method: 'POST', token: token('Germany'),
    body: {
      name: 'Tighten the reporting duty in operative clause 2',
      content: AMENDED,
      cosponsor_team_ids: [delegations.Japan.user.team.id],
    },
  });
  await call(`/amendments/${adopted.id}/submit`, { method: 'PATCH', token: token('Germany') });

  // ...while a rival written against the same version is left behind by it.
  const { amendment: rival } = await call(`/propositions/${proposition.id}/amendments`, {
    method: 'POST', token: token('Kenya'),
    body: { name: 'Raise the replenishment floor to 250 billion', content: RIVAL },
  });
  await call(`/amendments/${rival.id}/submit`, { method: 'PATCH', token: token('Kenya') });

  await call(`/amendments/${adopted.id}/approve`, { method: 'POST', token: founder });
  await call(`/amendments/${adopted.id}/approve`, { method: 'POST', token: token('Brazil') });

  // And one more still waiting on the sponsors.
  const { proposition: current } = await call(`/propositions/${proposition.id}`, { token: founder });
  const { amendment: pending } = await call(`/propositions/${proposition.id}/amendments`, {
    method: 'POST', token: token('India'),
    body: {
      name: 'Convene a review conference in 2028',
      content: `${current.current_version.markdown_content}\n4. **Convenes** a review conference in 2028.`,
    },
  });
  await call(`/amendments/${pending.id}/submit`, { method: 'PATCH', token: token('India') });
  await call(`/amendments/${pending.id}/approve`, { method: 'POST', token: founder });

  const line = (email, code, note) => `  ${email.padEnd(30)} ${code}   ${note}`;
  console.log(`\n${fr.committee.name} is ready. Sign in with an email and that delegation's code:\n`);
  console.log(line(fr.email, fr.team.join_code, 'France — sponsor, one approval pending'));
  console.log(line(`theo.${stamp}@example.org`, fr.team.join_code, 'France — second delegate, same drafts'));
  for (const [country, { user }] of Object.entries(delegations)) {
    if (country === 'France') continue;
    console.log(line(user.email, user.team.join_code, country));
  }
  console.log('\nMore countries need no code: they pick the committee from the list after');
  console.log('creating an account.');
  console.log(`\nOpen ${BASE}\n`);
};

main().catch((err) => {
  console.error(`\n${err instanceof SeedError ? err.message : err.stack}\n`);
  process.exit(1);
});
