import { Router } from 'express';
import { one, all, run, tx } from '../db.js';
import { bad, conflict, missing, str } from '../http.js';
import { requireTeam } from '../auth.js';
import {
  getProposition, assertPropositionVisible, serializeProposition,
  versionsOf, versionNumber, newVersion, recordApproval, assertOwnTeam,
  settlePendingAmendments,
} from '../model.js';

export const propositionRoutes = Router();

function projectInCommittee(projectId, user) {
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project || project.committee_id !== user.committee_id) throw missing('Project not found.');
  return project;
}

function visibleProposition(id, user) {
  return assertPropositionVisible(getProposition(id), user);
}

/* ------------------------------------------------------- list / create */

propositionRoutes.get('/projects/:id/propositions', requireTeam, (req, res) => {
  const project = projectInCommittee(req.params.id, req.user);
  const rows = all(
    `SELECT p.*, t.country_name AS initiating_country, t.committee_id,
            pr.name AS project_name
       FROM propositions p
       JOIN teams t     ON t.id = p.initiating_team_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE p.project_id = ?
        AND (p.status <> 'draft' OR p.initiating_team_id = ?)
      ORDER BY p.id ASC`,
    project.id, req.user.team_id
  );
  res.json({ propositions: rows.map((r) => serializeProposition(r, req.user)) });
});

propositionRoutes.post('/projects/:id/propositions', requireTeam, (req, res) => {
  const project = projectInCommittee(req.params.id, req.user);
  const name = str(req.body, 'name', { max: 200 });
  const content = str(req.body, 'content', { required: false, max: 200000 });

  const id = tx(() => {
    const info = run(
      `INSERT INTO propositions
         (project_id, name, status, initiating_team_id, author_user_id)
       VALUES (?, ?, 'draft', ?, ?)`,
      project.id, name, req.user.team_id, req.user.id
    );
    const propositionId = Number(info.lastInsertRowid);
    newVersion({
      propositionId,
      content,
      note: 'Initial draft',
      authorTeamId: req.user.team_id,
      parentVersionId: null,
    });
    return propositionId;
  });

  res.status(201).json({
    proposition: serializeProposition(getProposition(id), req.user, { includeContent: true }),
  });
});

/* -------------------------------------------------------------- read */

propositionRoutes.get('/propositions/:id', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  res.json({
    proposition: serializeProposition(prop, req.user, { includeContent: true }),
    versions: versionsOf(prop.id),
  });
});

propositionRoutes.get('/propositions/:id/versions', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  res.json({ versions: versionsOf(prop.id) });
});

/**
 * Content of any two versions, for a side-by-side comparison. The diff itself is
 * computed in the browser (jsdiff) — the server just hands over both texts.
 */
propositionRoutes.get('/propositions/:id/versions/diff', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  const load = (key) => {
    const id = Number(req.query[key]);
    const version = one('SELECT * FROM versions WHERE id = ? AND proposition_id = ?', id, prop.id);
    if (!version) throw bad(`"${key}" is not a version of this proposition.`);
    return {
      id: version.id,
      number: versionNumber(version.id),
      note: version.note,
      created_at: version.created_at,
      markdown_content: version.markdown_content,
    };
  };
  res.json({ from: load('from'), to: load('to') });
});

propositionRoutes.get('/propositions/:id/versions/:versionId', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  const version = one(
    'SELECT * FROM versions WHERE id = ? AND proposition_id = ?',
    Number(req.params.versionId), prop.id
  );
  if (!version) throw missing('Version not found.');
  res.json({
    version: {
      id: version.id,
      number: versionNumber(version.id),
      note: version.note,
      created_at: version.created_at,
      parent_version_id: version.parent_version_id,
      markdown_content: version.markdown_content,
    },
  });
});

/* ------------------------------------------------------- transitions */

/** Edit the title/description of a draft (own delegation, before submission). */
propositionRoutes.patch('/propositions/:id', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertOwnTeam(prop, req.user, 'the');
  if (prop.status !== 'draft') {
    throw conflict('A submitted proposition can only be changed through amendments.');
  }
  const name = str(req.body, 'name', { max: 200 });
  run(
    `UPDATE propositions SET name = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    name, prop.id
  );
  res.json({ proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }) });
});

/**
 * A new version by direct edit. Only while the proposition is a private draft —
 * once it is active, the text moves only through the amendment process (§5.2).
 */
propositionRoutes.post('/propositions/:id/versions', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertOwnTeam(prop, req.user, 'the');
  if (prop.status !== 'draft') {
    throw conflict('This proposition is live — propose an amendment instead of editing it.');
  }
  const content = str(req.body, 'content', { required: false, max: 200000 });
  const note = str(req.body, 'note', { required: false, max: 500 }) || 'Draft revision';
  newVersion({
    propositionId: prop.id,
    content,
    note,
    authorTeamId: req.user.team_id,
    parentVersionId: prop.current_version_id,
  });
  res.json({
    proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }),
  });
});

propositionRoutes.patch('/propositions/:id/submit', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertOwnTeam(prop, req.user, 'the');
  if (prop.status !== 'draft') throw conflict('This proposition has already been submitted.');
  run(
    `UPDATE propositions SET status = 'active',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    prop.id
  );
  res.json({
    proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }),
  });
});

propositionRoutes.post('/propositions/:id/withdraw', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertOwnTeam(prop, req.user, 'the');
  if (prop.status === 'withdrawn') throw conflict('Already withdrawn.');
  run(
    `UPDATE propositions SET status = 'withdrawn',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    prop.id
  );
  res.json({ proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }) });
});

/* -------------------------------------------------- sponsors & signatories */

function support(kind) {
  return (req, res) => {
    const prop = visibleProposition(req.params.id, req.user);
    if (prop.status === 'draft') throw conflict('This proposition has not been submitted yet.');
    if (prop.status === 'withdrawn') throw conflict('This proposition has been withdrawn.');
    recordApproval(req.user.team_id, 'proposition', prop.id, kind, req.user.id);
    res.json({
      proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }),
    });
  };
}

// Any delegation may take either role; the app does not police who "contributed
// content" — there is no moderator to adjudicate it (§5.5).
propositionRoutes.post('/propositions/:id/sponsor', requireTeam, support('sponsor'));
propositionRoutes.post('/propositions/:id/sign', requireTeam, support('signatory'));

/** Step back from a role you took. */
propositionRoutes.delete('/propositions/:id/support/:kind', requireTeam, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  const kind = req.params.kind === 'sponsor' ? 'sponsor'
    : req.params.kind === 'signatory' ? 'signatory' : null;
  if (!kind) throw bad('Unknown support role.');
  run(
    `DELETE FROM approvals
      WHERE team_id = ? AND target_type = 'proposition' AND target_id = ? AND kind = ?`,
    req.user.team_id, prop.id, kind
  );
  // Standing down as a sponsor shrinks the set of approvals an amendment needs,
  // which can complete one that was waiting on this delegation.
  if (kind === 'sponsor') settlePendingAmendments(prop.id);
  res.json({
    proposition: serializeProposition(getProposition(prop.id), req.user, { includeContent: true }),
  });
});
