import { Router } from 'express';
import { one, all, run, tx } from '../db.js';
import { bad, conflict, missing, str } from '../http.js';
import { requireCommittee, requireDelegation } from '../auth.js';
import {
  getProposition, assertPropositionVisible, serializeProposition, assertSponsor, isSponsor,
  versionsOf, versionNumber, newVersion, recordApproval, dropApproval, approvalsFor,
  settlePendingAmendments, refreshStatus, pendingAmendmentCount,
} from '../model.js';

export const propositionRoutes = Router();

// A draft is visible to the delegations that sponsor it — which, at the draft
// stage, is the one that wrote it.
const SPONSORED_BY = `EXISTS (SELECT 1 FROM approvals a
                              WHERE a.target_type = 'proposition' AND a.target_id = p.id
                                AND a.kind = 'sponsor' AND a.team_id = ?)`;

function projectInCommittee(projectId, user) {
  const project = one('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project || project.committee_id !== user.committee_id) throw missing('Project not found.');
  return project;
}

function visibleProposition(id, user) {
  return assertPropositionVisible(getProposition(id), user);
}

const respond = (res, id, user) => res.json({
  proposition: serializeProposition(getProposition(id), user, { includeContent: true }),
});

/* ------------------------------------------------------- list / create */

propositionRoutes.get('/projects/:id/propositions', requireCommittee, (req, res) => {
  const project = projectInCommittee(req.params.id, req.user);
  const rows = all(
    `SELECT p.*, pr.name AS project_name, pr.committee_id
       FROM propositions p
       JOIN projects pr ON pr.id = p.project_id
      WHERE p.project_id = ? AND (p.status <> 'draft' OR ${SPONSORED_BY})
      ORDER BY p.id ASC`,
    project.id, req.user.team_id ?? -1
  );
  res.json({ propositions: rows.map((r) => serializeProposition(r, req.user)) });
});

/** Writing a proposition makes you its first sponsor, not its owner. */
propositionRoutes.post('/projects/:id/propositions', requireDelegation, (req, res) => {
  const project = projectInCommittee(req.params.id, req.user);
  const name = str(req.body, 'name', { max: 200 });
  const content = str(req.body, 'content', { required: false, max: 200000 });

  const id = tx(() => {
    const info = run(
      `INSERT INTO propositions (project_id, name, status, author_user_id)
       VALUES (?, ?, 'draft', ?)`,
      project.id, name, req.user.id
    );
    const propositionId = Number(info.lastInsertRowid);
    newVersion({
      propositionId,
      content,
      note: 'Initial draft',
      authorTeamId: req.user.team_id,
      parentVersionId: null,
    });
    recordApproval(req.user.team_id, 'proposition', propositionId, 'sponsor', req.user.id);
    return propositionId;
  });

  res.status(201).json({
    proposition: serializeProposition(getProposition(id), req.user, { includeContent: true }),
  });
});

/* -------------------------------------------------------------- read */

propositionRoutes.get('/propositions/:id', requireCommittee, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  res.json({
    proposition: serializeProposition(prop, req.user, { includeContent: true }),
    versions: versionsOf(prop.id),
  });
});

propositionRoutes.get('/propositions/:id/versions', requireCommittee, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  res.json({ versions: versionsOf(prop.id) });
});

/**
 * Content of any two versions, for a side-by-side comparison. The diff itself is
 * computed in the browser (jsdiff) — the server just hands over both texts.
 */
propositionRoutes.get('/propositions/:id/versions/diff', requireCommittee, (req, res) => {
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

propositionRoutes.get('/propositions/:id/versions/:versionId', requireCommittee, (req, res) => {
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

/** Retitle a draft. Any of its sponsors may. */
propositionRoutes.patch('/propositions/:id', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
  if (prop.status !== 'draft') {
    throw conflict('A submitted proposition can only be changed through amendments.');
  }
  const name = str(req.body, 'name', { max: 200 });
  run(
    `UPDATE propositions SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    name, prop.id
  );
  respond(res, prop.id, req.user);
});

/**
 * A new version by direct edit. Only while the proposition is a private draft —
 * once it is live, the text moves only through the amendment process (§5.2).
 */
propositionRoutes.post('/propositions/:id/versions', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
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
  respond(res, prop.id, req.user);
});

propositionRoutes.patch('/propositions/:id/submit', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
  if (prop.status !== 'draft') throw conflict('This proposition has already been submitted.');
  run(
    `UPDATE propositions SET status = 'active',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    prop.id
  );
  respond(res, prop.id, req.user);
});

/**
 * A proposition belongs to all of its sponsors, so no one of them can take it
 * off the table over the others' heads. The last one standing can.
 */
propositionRoutes.post('/propositions/:id/withdraw', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
  if (prop.status === 'withdrawn') throw conflict('Already withdrawn.');

  const sponsors = approvalsFor('proposition', prop.id, 'sponsor');
  if (sponsors.length > 1) {
    const others = sponsors.filter((s) => s.team_id !== req.user.team_id)
      .map((s) => s.country_name).join(', ');
    throw conflict(
      `This proposition is sponsored jointly with ${others}. Stand down as a sponsor if you no longer support it — the last sponsor left can withdraw it.`
    );
  }
  run(
    `UPDATE propositions SET status = 'withdrawn',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    prop.id
  );
  respond(res, prop.id, req.user);
});

/* -------------------------------------------------------- sponsorship */

/** Ask the sponsors to be let in. One of them has to say yes. */
propositionRoutes.post('/propositions/:id/sponsor-request', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  if (prop.status === 'draft') throw conflict('This proposition has not been submitted yet.');
  if (prop.status === 'withdrawn') throw conflict('This proposition has been withdrawn.');
  if (isSponsor(prop.id, req.user.team_id)) throw conflict('You already sponsor this proposition.');

  const message = str(req.body, 'message', { required: false, max: 500 });
  const existing = one(
    'SELECT * FROM sponsor_requests WHERE proposition_id = ? AND team_id = ?',
    prop.id, req.user.team_id
  );
  if (existing?.status === 'pending') throw conflict('Your request is already with the sponsors.');

  if (existing) {
    run(
      `UPDATE sponsor_requests
          SET status = 'pending', message = ?, user_id = ?, decided_by_team_id = NULL,
              decided_at = NULL, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      message, req.user.id, existing.id
    );
  } else {
    run(
      `INSERT INTO sponsor_requests (proposition_id, team_id, user_id, message)
       VALUES (?, ?, ?, ?)`,
      prop.id, req.user.team_id, req.user.id, message
    );
  }
  respond(res, prop.id, req.user);
});

propositionRoutes.delete('/propositions/:id/sponsor-request', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  run(
    `DELETE FROM sponsor_requests
      WHERE proposition_id = ? AND team_id = ? AND status = 'pending'`,
    prop.id, req.user.team_id
  );
  respond(res, prop.id, req.user);
});

function decide(accept) {
  return (req, res) => {
    const prop = visibleProposition(req.params.id, req.user);
    assertSponsor(prop, req.user);

    const request = one(
      `SELECT * FROM sponsor_requests WHERE id = ? AND proposition_id = ? AND status = 'pending'`,
      Number(req.params.requestId), prop.id
    );
    if (!request) throw missing('No such request is waiting.');

    if (accept && !['draft', 'active'].includes(prop.status)) {
      throw conflict(
        'The sponsors have already declared the text settled. Reopen it for amendment before admitting a new sponsor.'
      );
    }

    tx(() => {
      run(
        `UPDATE sponsor_requests
            SET status = ?, decided_by_team_id = ?,
                decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
        accept ? 'accepted' : 'declined', req.user.team_id, request.id
      );
      if (accept) {
        recordApproval(request.team_id, 'proposition', prop.id, 'sponsor', request.user_id);
        // A sponsor who has not yet had their say cannot already be ready.
        refreshStatus(prop.id);
      }
    });
    respond(res, prop.id, req.user);
  };
}

propositionRoutes.post('/propositions/:id/sponsor-requests/:requestId/accept',
  requireDelegation, decide(true));
propositionRoutes.post('/propositions/:id/sponsor-requests/:requestId/decline',
  requireDelegation, decide(false));

/** Renounce sponsorship. The last sponsor cannot: they withdraw it instead. */
propositionRoutes.delete('/propositions/:id/support/sponsor', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);

  const sponsors = approvalsFor('proposition', prop.id, 'sponsor');
  if (sponsors.length === 1) {
    throw conflict(
      'You are the only sponsor left, so standing down would leave the text with nobody behind it. Withdraw the proposition instead.'
    );
  }
  tx(() => {
    dropApproval(req.user.team_id, 'proposition', prop.id, 'sponsor');
    dropApproval(req.user.team_id, 'proposition', prop.id, 'ready');
    // A smaller sponsor set is a smaller set of approvals an amendment needs,
    // and a smaller set that has to agree the text is settled.
    settlePendingAmendments(prop.id);
    refreshStatus(prop.id);
  });
  respond(res, prop.id, req.user);
});

/* ------------------------------------------------- readiness & signatures */

/**
 * A sponsor declaring the text settled. Once every sponsor has, the proposition
 * opens for signatures — and once enough of the committee is behind it, it is
 * ready to present.
 */
propositionRoutes.post('/propositions/:id/ready', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
  if (!['active', 'collecting', 'ready'].includes(prop.status)) {
    throw conflict(`A ${prop.status} proposition is not being negotiated.`);
  }
  const pending = pendingAmendmentCount(prop.id);
  if (pending > 0) {
    throw conflict(
      `${pending} amendment(s) are still in front of the sponsors. Settle them before calling the text final.`
    );
  }
  tx(() => {
    recordApproval(req.user.team_id, 'proposition', prop.id, 'ready', req.user.id);
    refreshStatus(prop.id);
  });
  respond(res, prop.id, req.user);
});

/** Take it back: the text reopens to amendment for everyone. */
propositionRoutes.delete('/propositions/:id/ready', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  assertSponsor(prop, req.user);
  tx(() => {
    dropApproval(req.user.team_id, 'proposition', prop.id, 'ready');
    refreshStatus(prop.id);
  });
  respond(res, prop.id, req.user);
});

/**
 * Signing is an undertaking on a settled text, so it is only open once the
 * sponsors have closed it — and the version signed is recorded with it.
 */
propositionRoutes.post('/propositions/:id/sign', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  if (!['collecting', 'ready'].includes(prop.status)) {
    throw conflict(
      'This proposition is not collecting signatures yet — its sponsors have not declared the text settled.'
    );
  }
  if (isSponsor(prop.id, req.user.team_id)) {
    throw conflict('You sponsor this proposition; sponsors carry it rather than sign it.');
  }
  if (req.body?.undertaking !== true) {
    throw bad('A signature has to be given knowingly: confirm the undertaking.');
  }
  tx(() => {
    recordApproval(
      req.user.team_id, 'proposition', prop.id, 'signatory', req.user.id, prop.current_version_id
    );
    refreshStatus(prop.id);
  });
  respond(res, prop.id, req.user);
});

propositionRoutes.delete('/propositions/:id/support/signatory', requireDelegation, (req, res) => {
  const prop = visibleProposition(req.params.id, req.user);
  tx(() => {
    dropApproval(req.user.team_id, 'proposition', prop.id, 'signatory');
    refreshStatus(prop.id);
  });
  respond(res, prop.id, req.user);
});
