import { Router } from 'express';
import { one, all, run, tx, uniqueCode } from '../db.js';
import { conflict, denied, missing, int, str } from '../http.js';
import { requireUser, requireTeam, serializeUser, userFromToken, joinTeam } from '../auth.js';
import { serializeProposition } from '../model.js';

export const orgRoutes = Router();

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
  const countryName = str(req.body, 'country_name', { max: 120 });
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
      // What is already spoken for, so the country picker can rule it out.
      taken_countries: taken.filter((t) => t.committee_id === c.id).map((t) => t.country_name),
    })),
  });
});

/**
 * Register a new delegation inside an existing committee, named either by id
 * (picked from the directory above) or by its shared code.
 */
orgRoutes.post('/teams', requireUser, (req, res) => {
  const countryName = str(req.body, 'country_name', { max: 120 });

  const cttee = req.body?.committee_id !== undefined
    ? one('SELECT * FROM committees WHERE id = ?', int(req.body, 'committee_id', { max: 1e9 }))
    : one('SELECT * FROM committees WHERE committee_code = ?',
        str(req.body, 'committee_code', { max: 40 }).toUpperCase());
  if (!cttee) throw missing('That committee no longer exists.');

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
  const joinCode = str(req.body, 'join_code', { max: 40 }).toUpperCase();
  const team = one('SELECT * FROM teams WHERE join_code = ?', joinCode);
  if (!team) throw missing('That delegation code is not valid.');
  joinTeam(req.user.id, team.id, req.token);
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/** The committee the caller sits in: delegations, delegates, codes. */
orgRoutes.get('/committees/:id', requireTeam, (req, res) => {
  assertMember(req.user, req.params.id);
  const cttee = one('SELECT * FROM committees WHERE id = ?', req.user.committee_id);
  const teams = all(
    `SELECT t.id, t.country_name,
            (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id) AS delegate_count
       FROM teams t WHERE t.committee_id = ? ORDER BY t.country_name`,
    cttee.id
  );
  const delegates = all(
    `SELECT u.id, u.email, u.delegate_name, u.country
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY u.delegate_name`,
    req.user.team_id
  );
  res.json({
    committee: {
      id: cttee.id,
      name: cttee.name,
      description: cttee.description,
      total_members: cttee.total_members,
      committee_code: cttee.committee_code,
      registered_teams: teams.length,
    },
    teams,
    delegates,
  });
});

/**
 * Committee settings. There is no moderator (§5.5), so any delegate seated here
 * may correct them — including the seat count, which is the denominator of the
 * 20% threshold and so changes every eligibility figure at once.
 */
orgRoutes.patch('/committees/:id', requireTeam, (req, res) => {
  assertMember(req.user, req.params.id);
  const name = str(req.body, 'name', { max: 120 });
  const description = str(req.body, 'description', { required: false, max: 2000 });
  const totalMembers = int(req.body, 'total_members', { min: 1, max: 2000 });
  run(
    'UPDATE committees SET name = ?, description = ?, total_members = ? WHERE id = ?',
    name, description, totalMembers, req.user.committee_id
  );
  res.json({ user: serializeUser(userFromToken(req.token)) });
});

/* ------------------------------------------------------------- agenda */

orgRoutes.get('/committees/:id/projects', requireTeam, (req, res) => {
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

orgRoutes.post('/committees/:id/projects', requireTeam, (req, res) => {
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
orgRoutes.patch('/projects/:id', requireTeam, (req, res) => {
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
orgRoutes.delete('/projects/:id', requireTeam, (req, res) => {
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
orgRoutes.get('/committees/:id/board', requireTeam, (req, res) => {
  assertMember(req.user, req.params.id);
  const projects = all(
    `SELECT id, name, position FROM projects
      WHERE committee_id = ? ORDER BY position ASC, id ASC`,
    req.user.committee_id
  );
  const rows = all(
    `SELECT p.*, t.country_name AS initiating_country, t.committee_id,
            pr.name AS project_name
       FROM propositions p
       JOIN teams t     ON t.id = p.initiating_team_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE pr.committee_id = ?
        AND (p.status <> 'draft' OR p.initiating_team_id = ?)
      ORDER BY p.id ASC`,
    req.user.committee_id, req.user.team_id
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
