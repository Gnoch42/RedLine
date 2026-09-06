import { Router } from 'express';
import { one, all, run, tx, uniqueCode } from '../db.js';
import { bad, conflict, denied, missing, int, str } from '../http.js';
import {
  requireUser, requireCommittee, serializeUser, userFromToken, joinTeam, isSecretariat,
  mayEnterCommittee, sit,
} from '../auth.js';

/**
 * A delegate represents one country, chosen on their account. A delegation is
 * always registered under it, so there is nothing to get wrong here.
 */
function ownCountry(user) {
  const country = (user.country || '').trim();
  if (!country) {
    throw bad('Your account has no country on it. Set one before registering a delegation.');
  }
  return country;
}
import { serializeProposition, refreshStatus } from '../model.js';

export const orgRoutes = Router();

/** Write a committee's roster rules: who may sit, and who may look in. */
function setRoster(committeeId, body) {
  run('UPDATE committees SET whitelist_enabled = ?, block_observers = ? WHERE id = ?',
    body?.whitelist_enabled ? 1 : 0,
    body?.whitelist_enabled && body?.block_observers ? 1 : 0,
    committeeId);

  if (!Array.isArray(body?.whitelist)) return;
  const wanted = [...new Set(
    body.whitelist.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
  )].slice(0, 400);
  run('DELETE FROM committee_countries WHERE committee_id = ?', committeeId);
  for (const country of wanted) {
    run('INSERT OR IGNORE INTO committee_countries (committee_id, country_name) VALUES (?, ?)',
      committeeId, country.slice(0, 120));
  }
}

function assertMember(user, committeeId) {
  if (user.committee_id !== Number(committeeId)) {
    throw denied('That committee belongs to another simulation.');
  }
}

/**
 * Create a committee and, with it, the founding delegation. Returns two codes:
 * the committee code (hand to other countries so they can register their own
 * delegation) and this delegation's join code (hand to your fellow delegates).
 */
orgRoutes.post('/committees', requireUser, (req, res) => {
  const name = str(req.body, 'name', { max: 120 });
  const description = str(req.body, 'description', { required: false, max: 2000 });
  const totalMembers = int(req.body, 'total_members', { min: 1, max: 2000 });
  const countryName = ownCountry(req.user);
  const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];

  const token = req.token;
  const result = tx(() => {
    const committeeCode = uniqueCode('committees', 'committee_code');
    const cttee = run(
      `INSERT INTO committees (name, description, total_members, committee_code)
       VALUES (?, ?, ?, ?)`,
      name, description, totalMembers, committeeCode
    );
    const committeeId = Number(cttee.lastInsertRowid);

    const joinCode = uniqueCode('teams', 'join_code');
    const team = run(
      `INSERT INTO teams (committee_id, country_name, join_code) VALUES (?, ?, ?)`,
      committeeId, countryName, joinCode
    );
    joinTeam(req.user.id, Number(team.lastInsertRowid), token);
    setRoster(committeeId, req.body);

    projects
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean)
      .slice(0, 50)
      .forEach((projectName, i) => {
        run(
          `INSERT INTO projects (committee_id, name, position) VALUES (?, ?, ?)`,
          committeeId, projectName.slice(0, 200), i
        );
      });

    return { committeeId };
  });

  res.status(201).json({ user: serializeUser(userFromToken(token)), committee_id: result.committeeId });
});

/**
 * Every committee on this instance, so a delegate can find the one they have
 * been assigned to instead of chasing a code for it. A Redline instance hosts
 * one conference and has no moderator, so there is nothing here to hide from
 * the people taking part.
 */
orgRoutes.get('/committees', requireUser, (req, res) => {
  const committees = all(
    `SELECT c.id, c.name, c.description, c.total_members, c.created_at,
            c.whitelist_enabled, c.block_observers,
            (SELECT COUNT(*) FROM teams t WHERE t.committee_id = c.id) AS registered_teams,
            (SELECT m.team_id FROM memberships m
               JOIN teams t2 ON t2.id = m.team_id
              WHERE m.user_id = ? AND t2.committee_id = c.id LIMIT 1) AS my_team_id
       FROM committees c
      ORDER BY c.name COLLATE NOCASE ASC`,
    req.user.id
  );
  const taken = all(
    'SELECT committee_id, country_name FROM teams ORDER BY country_name COLLATE NOCASE ASC'
  );
  res.json({
    committees: committees.map((c) => ({
      ...c,
      whitelist_enabled: !!c.whitelist_enabled,
      block_observers: !!c.block_observers,
      may_enter: mayEnterCommittee(req.user, c.id),
      // Whether this delegate's country could take the seat, as opposed to just
      // looking in.
      may_take_seat: !c.whitelist_enabled || !!one(
        `SELECT 1 AS x FROM committee_countries
          WHERE committee_id = ? AND lower(country_name) = lower(?)`,
        c.id, req.user.country || ''
      ),
      // What is already spoken for, so the country picker can rule it out.
      taken_countries: taken.filter((t) => t.committee_id === c.id).map((t) => t.country_name),
      seats_countries: c.whitelist_enabled
        ? all('SELECT country_name FROM committee_countries WHERE committee_id = ? ORDER BY country_name',
            c.id).map((r) => r.country_name)
        : null,
    })),
  });
});

/**
 * Register a new delegation inside an existing committee, named either by id
 * (picked from the directory above) or by its shared code.
 */
orgRoutes.post('/teams', requireUser, (req, res) => {
  if (isSecretariat(req.user)) {
    throw denied('The secretariat does not sit in a delegation — open any committee instead.');
  }
  const countryName = ownCountry(req.user);

  const cttee = req.body?.committee_id !== undefined
    ? one('SELECT * FROM committees WHERE id = ?', int(req.body, 'committee_id', { max: 1e9 }))
    : one('SELECT * FROM committees WHERE committee_code = ?',
        str(req.body, 'committee_code', { max: 40 }).toUpperCase());
  if (!cttee) throw missing('That committee no longer exists.');

  if (cttee.whitelist_enabled) {
    const listed = one(
      `SELECT 1 AS x FROM committee_countries
        WHERE committee_id = ? AND lower(country_name) = lower(?)`,
      cttee.id, countryName
    );
    if (!listed) {
      throw denied(`${cttee.name} seats only the countries on its list, and ${countryName} is not one of them.`);
    }
  }

  const clash = one(
    'SELECT id FROM teams WHERE committee_id = ? AND lower(country_name) = lower(?)',
    cttee.id, countryName
  );
  if (clash) {
    throw conflict(`${countryName} already has a delegation here — ask them for its join code.`);
  }

  const token = req.token;
  tx(() => {
    const joinCode = uniqueCode('teams', 'join_code');
    const team = run(
      'INSERT INTO teams (committee_id, country_name, join_code) VALUES (?, ?, ?)',
      cttee.id, countryName, joinCode
    );
    joinTeam(req.user.id, Number(team.lastInsertRowid), token);
  });

  res.status(201).json({ user: serializeUser(userFromToken(token)) });
});

/** Join an existing delegation with its join code (or QR link). */
orgRoutes.post('/teams/join', requireUser, (req, res) => {
  if (isSecretariat(req.user)) {
    throw denied('The secretariat does not sit in a delegation — open any committee instead.');
  }
  const joinCode = str(req.body, 'join_code', { max: 40 }).toUpperCase();
  const team = one('SELECT * FROM teams WHERE join_code = ?', joinCode);
  if (!team) throw missing('That delegation code is not valid.');
  joinTeam(req.user.id, team.id, req.token);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/** The committee the caller sits in: delegations, delegates, codes. */
orgRoutes.get('/committees/:id', requireCommittee, (req, res) => {
  assertMember(req.user, req.params.id);
  const cttee = one('SELECT * FROM committees WHERE id = ?', req.user.committee_id);
  const teams = all(
    `SELECT t.id, t.country_name,
            (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id) AS delegate_count
       FROM teams t WHERE t.committee_id = ? ORDER BY t.country_name`,
    cttee.id
  );
  const delegates = req.user.team_id ? all(
    `SELECT u.id, u.email, u.delegate_name, u.phone, u.role, u.country
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY u.delegate_name`,
    req.user.team_id
  ) : [];
  // Event staff belong to no committee in particular, so they are listed for
  // every one — the point of having them here is being able to reach them.
  const secretariat = all(
    `SELECT id, email, delegate_name, phone FROM users
      WHERE role = 'secretariat' ORDER BY delegate_name`
  );
  res.json({
    secretariat,
    committee: {
      id: cttee.id,
      name: cttee.name,
      description: cttee.description,
      total_members: cttee.total_members,
      committee_code: cttee.committee_code,
      registered_teams: teams.length,
      whitelist_enabled: !!cttee.whitelist_enabled,
      block_observers: !!cttee.block_observers,
    },
    whitelist: all(
      'SELECT country_name FROM committee_countries WHERE committee_id = ? ORDER BY country_name COLLATE NOCASE',
      cttee.id
    ).map((r) => r.country_name),
    teams,
    delegates,
    my_seat: req.user.team_id
      ? one('SELECT is_primary FROM memberships WHERE user_id = ? AND team_id = ?',
          req.user.id, req.user.team_id)
      : null,
  });
});

/**
 * Committee settings. There is no moderator (§5.5), so any delegate seated here
 * may correct them — including the seat count, which is the denominator of the
 * 20% threshold and so changes every eligibility figure at once.
 */
orgRoutes.patch('/committees/:id', requireCommittee, (req, res) => {
  assertMember(req.user, req.params.id);
  const name = str(req.body, 'name', { max: 120 });
  const description = str(req.body, 'description', { required: false, max: 2000 });
  const totalMembers = int(req.body, 'total_members', { min: 1, max: 2000 });
  tx(() => {
    run('UPDATE committees SET name = ?, description = ?, total_members = ? WHERE id = ?',
      name, description, totalMembers, req.user.committee_id);
    setRoster(req.user.committee_id, req.body);
  });
  // The threshold moved under every proposition here, so some may have crossed
  // it — or fallen back below.
  for (const row of all(
    `SELECT p.id FROM propositions p
       JOIN projects pr ON pr.id = p.project_id
      WHERE pr.committee_id = ?`, req.user.committee_id
  )) refreshStatus(row.id);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/* ------------------------------------------------------------- agenda */

orgRoutes.get('/committees/:id/projects', requireCommittee, (req, res) => {
  assertMember(req.user, req.params.id);
  res.json({
    projects: all(
      `SELECT id, name, position, created_at,
              (SELECT COUNT(*) FROM propositions p WHERE p.project_id = projects.id) AS proposition_count
         FROM projects
        WHERE committee_id = ? ORDER BY position ASC, id ASC`,
      req.user.committee_id
    ),
  });
});

orgRoutes.post('/committees/:id/projects', requireCommittee, (req, res) => {
  assertMember(req.user, req.params.id);
  const name = str(req.body, 'name', { max: 200 });
  const next = one(
    'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM projects WHERE committee_id = ?',
    req.user.committee_id
  ).pos;
  const info = run(
    'INSERT INTO projects (committee_id, name, position) VALUES (?, ?, ?)',
    req.user.committee_id, name, next
  );
  res.status(201).json({
    project: one('SELECT id, name, position, created_at FROM projects WHERE id = ?',
      Number(info.lastInsertRowid)),
  });
});

function ownProject(req) {
  const project = one('SELECT * FROM projects WHERE id = ?', Number(req.params.id));
  if (!project || project.committee_id !== req.user.committee_id) throw missing('Agenda item not found.');
  return project;
}

/**
 * Rename an agenda item and/or move it. `position` is the index it should end
 * up at: the whole list is renumbered around it, since simply writing a new
 * position would collide with whatever already holds it.
 */
orgRoutes.patch('/projects/:id', requireCommittee, (req, res) => {
  const project = ownProject(req);
  const name = str(req.body, 'name', { max: 200 });

  tx(() => {
    run('UPDATE projects SET name = ? WHERE id = ?', name, project.id);

    if (req.body?.position !== undefined) {
      const target = int(req.body, 'position', { min: 0, max: 1000 });
      const order = all(
        'SELECT id FROM projects WHERE committee_id = ? ORDER BY position ASC, id ASC',
        req.user.committee_id
      ).map((row) => row.id);

      const from = order.indexOf(project.id);
      order.splice(from, 1);
      order.splice(Math.min(target, order.length), 0, project.id);
      order.forEach((id, index) => run('UPDATE projects SET position = ? WHERE id = ?', index, id));
    }
  });

  res.json({ project: one('SELECT id, name, position FROM projects WHERE id = ?', project.id) });
});

/** Only an empty agenda item can go — deleting one would take its work with it. */
orgRoutes.delete('/projects/:id', requireCommittee, (req, res) => {
  const project = ownProject(req);
  const { count } = one('SELECT COUNT(*) AS count FROM propositions WHERE project_id = ?', project.id);
  if (count > 0) {
    throw conflict(`"${project.name}" still holds ${count} proposition(s). Move or withdraw them first.`);
  }
  run('DELETE FROM projects WHERE id = ?', project.id);
  res.json({ ok: true });
});

/**
 * Everything the left-hand explorer needs, in one request — the client polls
 * this every few seconds rather than fanning out per project.
 */
orgRoutes.get('/committees/:id/board', requireCommittee, (req, res) => {
  assertMember(req.user, req.params.id);
  const projects = all(
    `SELECT id, name, position FROM projects
      WHERE committee_id = ? ORDER BY position ASC, id ASC`,
    req.user.committee_id
  );
  const rows = all(
    `SELECT p.*, pr.name AS project_name, pr.committee_id
       FROM propositions p
       JOIN projects pr ON pr.id = p.project_id
      WHERE pr.committee_id = ?
        AND (p.status <> 'draft' OR EXISTS (
              SELECT 1 FROM approvals a
               WHERE a.target_type = 'proposition' AND a.target_id = p.id
                 AND a.kind = 'sponsor' AND a.team_id = ?))
      ORDER BY p.id ASC`,
    req.user.committee_id, req.user.team_id ?? -1
  );
  const byProject = new Map(projects.map((p) => [p.id, []]));
  for (const row of rows) {
    byProject.get(row.project_id)?.push(serializeProposition(row, req.user));
  }
  res.json({
    projects: projects.map((p) => ({ ...p, propositions: byProject.get(p.id) })),
    teams: all(
      'SELECT id, country_name FROM teams WHERE committee_id = ? ORDER BY country_name',
      req.user.committee_id
    ),
  });
});

/**
 * A country's card: who speaks for it, on which committee, and how to reach
 * them. Contact details are shared across the whole conference on purpose —
 * finding the delegate you need to negotiate with is the point.
 */
orgRoutes.get('/countries/:name', requireCommittee, (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) throw missing('No country named.');

  const teams = all(
    `SELECT t.id AS team_id, t.country_name, c.id AS committee_id, c.name AS committee_name
       FROM teams t
       JOIN committees c ON c.id = t.committee_id
      WHERE lower(t.country_name) = lower(?)
      ORDER BY c.name COLLATE NOCASE ASC`,
    name
  );
  if (teams.length === 0) throw missing(`No delegation is registered for ${name}.`);

  const delegations = teams.map((team) => ({
    ...team,
    delegates: all(
      `SELECT u.id, u.delegate_name, u.email, u.phone, u.role, m.is_primary
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ?
        ORDER BY m.is_primary DESC,
                 CASE u.role WHEN 'delegate' THEN 0 ELSE 1 END, u.delegate_name`,
      team.team_id
    ).map((delegate) => ({
      ...delegate,
      is_primary: !!delegate.is_primary,
      // Where else this person works, so a delegation can see who to send.
      also_on: all(
        `SELECT c.name FROM memberships m2
           JOIN teams t2 ON t2.id = m2.team_id
           JOIN committees c ON c.id = t2.committee_id
          WHERE m2.user_id = ? AND m2.team_id <> ? AND m2.is_primary = 1
          ORDER BY c.name COLLATE NOCASE`,
        delegate.id, team.team_id
      ).map((r) => r.name),
    })),
    // What this delegation sponsors in that committee.
    propositions: all(
      `SELECT p.id, p.name, p.status
         FROM propositions p
         JOIN approvals a ON a.target_type = 'proposition' AND a.target_id = p.id
                         AND a.kind = 'sponsor' AND a.team_id = ?
        WHERE p.status <> 'draft'
        ORDER BY p.id ASC`,
      team.team_id
    ),
  }));

  res.json({ country: teams[0].country_name, delegations });
});

/**
 * Give up a seat. The membership always goes; the delegation itself only goes
 * with it when nobody else is in it and it has left nothing behind — a
 * delegation that sponsors, signs or has proposed anything stays on the record,
 * because those commitments were made by a country, not by whoever typed them.
 */
orgRoutes.delete('/teams/:id/seat', requireUser, (req, res) => {
  const teamId = Number(req.params.id);
  const team = one('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw missing('No such delegation.');
  if (!one('SELECT 1 AS x FROM memberships WHERE user_id = ? AND team_id = ?', req.user.id, teamId)) {
    throw missing('You do not have a seat in that delegation.');
  }

  const outcome = tx(() => {
    run('DELETE FROM memberships WHERE user_id = ? AND team_id = ?', req.user.id, teamId);

    const others = one('SELECT COUNT(*) AS n FROM memberships WHERE team_id = ?', teamId).n;
    if (others > 0) return 'left';

    const committed = one(
      `SELECT
         (SELECT COUNT(*) FROM approvals WHERE team_id = ?) +
         (SELECT COUNT(*) FROM amendments WHERE proposing_team_id = ?) +
         (SELECT COUNT(*) FROM versions WHERE author_team_id = ?) AS n`,
      teamId, teamId, teamId
    ).n;
    if (committed > 0) return 'left_standing';

    run('DELETE FROM sponsor_requests WHERE team_id = ?', teamId);
    run('DELETE FROM teams WHERE id = ?', teamId);
    return 'released';
  });

  // Standing up from the chair you were sitting in puts you back in the lobby.
  if (req.user.team_id === teamId) sit(req.token, {});

  res.json({ outcome, user: serializeUser(userFromToken(req.token)) });
});
