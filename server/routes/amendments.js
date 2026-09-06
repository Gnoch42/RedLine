import { Router } from 'express';
import { one, all, run, tx } from '../db.js';
import { conflict, str } from '../http.js';
import { requireCommittee, requireDelegation } from '../auth.js';
import {
  getProposition, getAmendment, assertPropositionVisible, assertAmendmentVisible,
  serializeAmendment, serializeProposition, amendmentApprovalState, adoptAmendment,
  newVersion, recordApproval, assertOwnTeam, versionNumber, clearReadiness, refreshStatus,
} from '../model.js';


export const amendmentRoutes = Router();

function visibleProposition(id, user) {
  return assertPropositionVisible(getProposition(id), user);
}

function setCosponsors(amendmentId, teamIds, committeeId) {
  run('DELETE FROM amendment_cosponsors WHERE amendment_id = ?', amendmentId);
  const ids = Array.isArray(teamIds) ? [...new Set(teamIds.map(Number))] : [];
  for (const teamId of ids.slice(0, 100)) {
    const team = one('SELECT id FROM teams WHERE id = ? AND committee_id = ?', teamId, committeeId);
    if (!team) continue;
    run('INSERT INTO amendment_cosponsors (amendment_id, team_id) VALUES (?, ?)', amendmentId, teamId);
  }
}

/* ------------------------------------------------------- list / create */

amendmentRoutes.get('/propositions/:id/amendments', requireCommittee, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  const rows = all(
    `SELECT a.*, t.country_name AS proposing_country
       FROM amendments a
       JOIN teams t ON t.id = a.proposing_team_id
      WHERE a.proposition_id = ?
        AND (a.status <> 'draft' OR a.proposing_team_id = ?)
      ORDER BY a.id ASC`,
    prop.id, req.user.team_id
  );
  res.json({ amendments: rows.map((a) => serializeAmendment(a, prop, req.user)) });
});

amendmentRoutes.post('/propositions/:id/amendments', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  if (prop.status !== 'active') {
    throw conflict(
      prop.status === 'collecting' || prop.status === 'ready'
        ? 'The sponsors have declared this text settled and it is collecting signatures. It has to be reopened before it can be amended.'
        : 'Amendments can only be written against a live proposition.'
    );
  }
  const name = str(req.body, 'name', { max: 200 });
  const content = str(req.body, 'content', { required: false, max: 200000 });

  const id = tx(() => {
    const info = run(
      `INSERT INTO amendments
         (proposition_id, base_version_id, name, markdown_content,
          proposing_team_id, author_user_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
      prop.id, prop.current_version_id, name, content, req.user.team_id, req.user.id
    );
    const amendmentId = Number(info.lastInsertRowid);
    setCosponsors(amendmentId, req.body?.cosponsor_team_ids, req.user.committee_id);
    return amendmentId;
  });

  res.status(201).json({
    amendment: serializeAmendment(getAmendment(id), prop, req.user, { includeContent: true }),
  });
});

amendmentRoutes.get('/amendments/:id', requireCommittee, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  const base = one('SELECT * FROM versions WHERE id = ?', amendment.base_version_id);
  res.json({
    amendment: serializeAmendment(amendment, prop, req.user, { includeContent: true }),
    base_version: {
      id: base.id,
      number: versionNumber(base.id),
      markdown_content: base.markdown_content,
    },
  });
});

/* ------------------------------------------------------- transitions */

amendmentRoutes.patch('/amendments/:id', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  assertOwnTeam(amendment, req.user, "an amendment's");
  if (amendment.status !== 'draft') {
    throw conflict('A submitted amendment can no longer be edited in place — reapply it instead.');
  }
  const name = str(req.body, 'name', { max: 200 });
  const content = str(req.body, 'content', { required: false, max: 200000 });
  run(
    `UPDATE amendments SET name = ?, markdown_content = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    name, content, amendment.id
  );
  if (req.body?.cosponsor_team_ids) {
    setCosponsors(amendment.id, req.body.cosponsor_team_ids, req.user.committee_id);
  }
  res.json({
    amendment: serializeAmendment(getAmendment(amendment.id), prop, req.user, { includeContent: true }),
  });
});

/**
 * draft -> pending. If the proposition moved on while this was still private,
 * the amendment lands frozen instead: same state, same fix (reapply) as a
 * conflict discovered later (§5.3).
 */
amendmentRoutes.patch('/amendments/:id/submit', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  assertOwnTeam(amendment, req.user, "an amendment's");
  if (amendment.status !== 'draft') throw conflict('This amendment has already been submitted.');

  const stale = amendment.base_version_id !== prop.current_version_id;
  tx(() => {
    run(
      `UPDATE amendments SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      stale ? 'frozen' : 'pending', amendment.id
    );
    if (!stale) {
      // The text is in play again: no sponsor can still be calling it settled.
      clearReadiness(prop.id);
      refreshStatus(prop.id);
    }
  });
  res.json({
    amendment: serializeAmendment(getAmendment(amendment.id), prop, req.user, { includeContent: true }),
  });
});

/**
 * §5.2.4–5 — record one sponsor's approval, and adopt the moment every current
 * sponsor of the target proposition has approved.
 */
amendmentRoutes.post('/amendments/:id/approve', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);

  if (amendment.status === 'frozen') {
    throw conflict('This amendment is frozen — its author must reapply it to the current version.');
  }
  if (amendment.status !== 'pending') {
    throw conflict(`This amendment is ${amendment.status} and no longer collecting approvals.`);
  }
  const state = amendmentApprovalState(amendment, prop);
  if (state.required_count === 0) {
    throw conflict('The proposition has no sponsors yet, so nobody can approve amendments to it.');
  }
  if (!state.required.some((r) => r.team_id === req.user.team_id)) {
    throw conflict('Only sponsors of the target proposition can approve its amendments.');
  }

  const adopted = tx(() => {
    recordApproval(req.user.team_id, 'amendment', amendment.id, 'amendment_approval', req.user.id);
    const fresh = getAmendment(amendment.id);
    if (amendmentApprovalState(fresh, prop).complete) {
      adoptAmendment(fresh, prop);
      return true;
    }
    return false;
  });

  refreshStatus(prop.id);
  const after = getProposition(prop.id);
  res.json({
    adopted,
    amendment: serializeAmendment(getAmendment(amendment.id), after, req.user, { includeContent: true }),
    proposition: serializeProposition(after, req.user, { includeContent: true }),
  });
});

/**
 * §5.2.6 — give up on approval and take the text out as a rival proposition of
 * its own, seeded at version 1.
 */
amendmentRoutes.post('/amendments/:id/detach', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  assertOwnTeam(amendment, req.user, "an amendment's");
  if (!['pending', 'frozen', 'draft'].includes(amendment.status)) {
    throw conflict(`An ${amendment.status} amendment cannot be detached.`);
  }

  const newPropId = tx(() => {
    const info = run(
      `INSERT INTO propositions (project_id, name, status, author_user_id)
       VALUES (?, ?, ?, ?)`,
      prop.project_id,
      amendment.name,
      // A draft was never public, so it stays private; anything already public
      // stays public.
      amendment.status === 'draft' ? 'draft' : 'active',
      amendment.author_user_id
    );
    const propositionId = Number(info.lastInsertRowid);
    // The delegation that wrote it carries it: its first and only sponsor.
    recordApproval(
      amendment.proposing_team_id, 'proposition', propositionId, 'sponsor', amendment.author_user_id
    );
    newVersion({
      propositionId,
      content: amendment.markdown_content,
      note: `Detached from amendment to "${prop.name}"`,
      authorTeamId: amendment.proposing_team_id,
      parentVersionId: null,
    });
    run(
      `UPDATE amendments SET status = 'detached',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      amendment.id
    );
    return propositionId;
  });

  res.json({
    amendment: serializeAmendment(getAmendment(amendment.id), prop, req.user),
    proposition: serializeProposition(getProposition(newPropId), req.user, { includeContent: true }),
  });
});

/**
 * §5.3 — manual rebase of a frozen amendment onto the current version. Prior
 * approvals are cleared: sponsors approved a different text.
 */
amendmentRoutes.post('/amendments/:id/reapply', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  assertOwnTeam(amendment, req.user, "an amendment's");
  if (amendment.status !== 'frozen') {
    throw conflict('Only a frozen amendment can be reapplied.');
  }
  if (prop.status !== 'active') {
    throw conflict('The target proposition is no longer live.');
  }
  const content = str(req.body, 'content', { required: false, max: 200000 });

  tx(() => {
    run(
      `DELETE FROM approvals
        WHERE target_type = 'amendment' AND target_id = ? AND kind = 'amendment_approval'`,
      amendment.id
    );
    run(
      `UPDATE amendments
          SET markdown_content = ?, base_version_id = ?, status = 'pending',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      content, prop.current_version_id, amendment.id
    );
    clearReadiness(prop.id);
    refreshStatus(prop.id);
  });

  res.json({
    amendment: serializeAmendment(getAmendment(amendment.id), prop, req.user, { includeContent: true }),
  });
});

amendmentRoutes.post('/amendments/:id/withdraw', requireDelegation, (req, res) => {
  const amendment = assertAmendmentVisible(getAmendment(req.params.id), req.user);
  const prop = getProposition(amendment.proposition_id);
  assertOwnTeam(amendment, req.user, "an amendment's");
  if (['adopted', 'detached'].includes(amendment.status)) {
    throw conflict(`An ${amendment.status} amendment cannot be withdrawn.`);
  }
  run(
    `UPDATE amendments SET status = 'withdrawn',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    amendment.id
  );
  res.json({ amendment: serializeAmendment(getAmendment(amendment.id), prop, req.user) });
});
