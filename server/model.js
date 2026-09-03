// Domain rules from the build spec §5. Routes stay thin; anything that decides
// who may do what, or what a state transition means, lives here.
import { one, all, run } from './db.js';
import { bad, conflict, denied, missing } from './http.js';

export const SUPPORT_THRESHOLD = 0.20; // §5.4

/* ------------------------------------------------------------------ lookups */

export function getProposition(id) {
  const prop = one(
    `SELECT p.*, t.country_name AS initiating_country, t.committee_id,
            pr.name AS project_name, pr.committee_id AS project_committee_id
       FROM propositions p
       JOIN teams t    ON t.id = p.initiating_team_id
       JOIN projects pr ON pr.id = p.project_id
      WHERE p.id = ?`,
    id
  );
  if (!prop) throw missing('Proposition not found.');
  return prop;
}

export function getAmendment(id) {
  const amendment = one(
    `SELECT a.*, t.country_name AS proposing_country
       FROM amendments a
       JOIN teams t ON t.id = a.proposing_team_id
      WHERE a.id = ?`,
    id
  );
  if (!amendment) throw missing('Amendment not found.');
  return amendment;
}

/** 1-based ordinal of a version within its proposition. */
export function versionNumber(versionId) {
  const row = one(
    `SELECT (SELECT COUNT(*) FROM versions v2
              WHERE v2.proposition_id = v.proposition_id AND v2.id <= v.id) AS n
       FROM versions v WHERE v.id = ?`,
    versionId
  );
  return row ? row.n : null;
}

export function versionsOf(propositionId) {
  return all(
    `SELECT v.id, v.note, v.created_at, v.parent_version_id, v.author_team_id,
            t.country_name AS author_country,
            (SELECT COUNT(*) FROM versions v2
              WHERE v2.proposition_id = v.proposition_id AND v2.id <= v.id) AS number
       FROM versions v
       JOIN teams t ON t.id = v.author_team_id
      WHERE v.proposition_id = ?
      ORDER BY v.id ASC`,
    propositionId
  );
}

/* -------------------------------------------------------------- visibility */

/**
 * §5.1.2 / §5.2.2 — a draft is the delegation's own business: its delegates all
 * see and edit it, the rest of the committee cannot. Everything else is
 * committee-wide.
 */
export function assertPropositionVisible(prop, user) {
  if (prop.committee_id !== user.committee_id) throw missing('Proposition not found.');
  if (prop.status === 'draft' && prop.initiating_team_id !== user.team_id) {
    throw missing('Proposition not found.');
  }
  return prop;
}

export function assertAmendmentVisible(amendment, user) {
  const prop = getProposition(amendment.proposition_id);
  assertPropositionVisible(prop, user);
  if (amendment.status === 'draft' && amendment.proposing_team_id !== user.team_id) {
    throw missing('Amendment not found.');
  }
  return amendment;
}

/* ---------------------------------------------------------------- approvals */

export function approvalsFor(targetType, targetId, kind) {
  return all(
    `SELECT ap.team_id, ap.created_at, t.country_name
       FROM approvals ap
       JOIN teams t ON t.id = ap.team_id
      WHERE ap.target_type = ? AND ap.target_id = ? AND ap.kind = ?
      ORDER BY ap.created_at ASC, ap.id ASC`,
    targetType, targetId, kind
  );
}

export function recordApproval(teamId, targetType, targetId, kind, userId) {
  const existing = one(
    `SELECT id FROM approvals
      WHERE team_id = ? AND target_type = ? AND target_id = ? AND kind = ?`,
    teamId, targetType, targetId, kind
  );
  if (existing) return false;
  run(
    `INSERT INTO approvals (team_id, target_type, target_id, kind, user_id)
     VALUES (?, ?, ?, ?, ?)`,
    teamId, targetType, targetId, kind, userId
  );
  return true;
}

/**
 * §5.4 — distinct delegations backing a proposition in either role, over the
 * committee size fixed at creation. A delegation that is both sponsor and
 * signatory counts once.
 */
export function supportOf(prop) {
  const totalMembers = one(
    `SELECT c.total_members FROM committees c WHERE c.id = ?`,
    prop.committee_id
  ).total_members;
  const { teams } = one(
    `SELECT COUNT(DISTINCT team_id) AS teams FROM approvals
      WHERE target_type = 'proposition' AND target_id = ?
        AND kind IN ('sponsor', 'signatory')`,
    prop.id
  );
  const percent = totalMembers > 0 ? teams / totalMembers : 0;
  return {
    teams,
    total_members: totalMembers,
    percent,
    threshold: SUPPORT_THRESHOLD,
    eligible: percent >= SUPPORT_THRESHOLD,
  };
}

/* ------------------------------------------------------------ serialization */

export function serializeProposition(prop, user, { includeContent = false } = {}) {
  const sponsors = approvalsFor('proposition', prop.id, 'sponsor');
  const signatories = approvalsFor('proposition', prop.id, 'signatory');
  const versions = versionsOf(prop.id);
  const current = prop.current_version_id
    ? one('SELECT * FROM versions WHERE id = ?', prop.current_version_id)
    : null;
  const currentNumber = versions.length;

  const counts = one(
    `SELECT
        SUM(status = 'pending')  AS pending,
        SUM(status = 'adopted')  AS adopted,
        SUM(status = 'frozen')   AS frozen
       FROM amendments
      WHERE proposition_id = ?
        AND (status <> 'draft' OR proposing_team_id = ?)`,
    prop.id, user.team_id
  );

  return {
    id: prop.id,
    project_id: prop.project_id,
    project_name: prop.project_name,
    name: prop.name,
    status: prop.status,
    initiating_team: { id: prop.initiating_team_id, country_name: prop.initiating_country },
    is_own_team: prop.initiating_team_id === user.team_id,
    created_at: prop.created_at,
    updated_at: prop.updated_at,
    version_count: versions.length,
    current_version: current
      ? {
          id: current.id,
          number: currentNumber,
          note: current.note,
          created_at: current.created_at,
          ...(includeContent ? { markdown_content: current.markdown_content } : {}),
        }
      : null,
    sponsors,
    signatories,
    my_roles: {
      sponsor: sponsors.some((s) => s.team_id === user.team_id),
      signatory: signatories.some((s) => s.team_id === user.team_id),
    },
    support: supportOf(prop),
    amendment_counts: {
      pending: counts?.pending || 0,
      adopted: counts?.adopted || 0,
      frozen: counts?.frozen || 0,
    },
  };
}

/**
 * §5.2.4 — an amendment needs every current sponsor of the target proposition.
 * Its own co-sponsors are just its authors and carry no approval weight.
 */
export function amendmentApprovalState(amendment, prop) {
  const required = approvalsFor('proposition', prop.id, 'sponsor');
  const given = approvalsFor('amendment', amendment.id, 'amendment_approval');
  const givenIds = new Set(given.map((g) => g.team_id));
  return {
    required: required.map((r) => ({ ...r, approved: givenIds.has(r.team_id) })),
    approved_count: required.filter((r) => givenIds.has(r.team_id)).length,
    required_count: required.length,
    // A proposition with no sponsors has nobody who can approve; adopting on a
    // vacuously-satisfied condition would be wrong.
    complete: required.length > 0 && required.every((r) => givenIds.has(r.team_id)),
  };
}

export function serializeAmendment(amendment, prop, user, { includeContent = false } = {}) {
  const approval = amendmentApprovalState(amendment, prop);
  const cosponsors = all(
    `SELECT ac.team_id, t.country_name
       FROM amendment_cosponsors ac
       JOIN teams t ON t.id = ac.team_id
      WHERE ac.amendment_id = ?`,
    amendment.id
  );
  const isSponsor = approval.required.some((r) => r.team_id === user.team_id);
  const mine = amendment.proposing_team_id === user.team_id;

  return {
    id: amendment.id,
    proposition_id: amendment.proposition_id,
    name: amendment.name,
    status: amendment.status,
    created_at: amendment.created_at,
    updated_at: amendment.updated_at,
    proposing_team: { id: amendment.proposing_team_id, country_name: amendment.proposing_country },
    cosponsors,
    base_version: {
      id: amendment.base_version_id,
      number: versionNumber(amendment.base_version_id),
    },
    is_stale: amendment.base_version_id !== prop.current_version_id,
    is_own_team: mine,
    approval,
    my_approval: approval.required.some((r) => r.team_id === user.team_id && r.approved),
    can_approve:
      amendment.status === 'pending' &&
      isSponsor &&
      !approval.required.some((r) => r.team_id === user.team_id && r.approved),
    ...(includeContent ? { markdown_content: amendment.markdown_content } : {}),
  };
}

/* ------------------------------------------------------------- transitions */

export function newVersion({ propositionId, content, note, authorTeamId, parentVersionId }) {
  const info = run(
    `INSERT INTO versions (proposition_id, markdown_content, note, author_team_id, parent_version_id)
     VALUES (?, ?, ?, ?, ?)`,
    propositionId, content, note, authorTeamId, parentVersionId
  );
  const versionId = Number(info.lastInsertRowid);
  run(
    `UPDATE propositions
        SET current_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    versionId, propositionId
  );
  return versionId;
}

/**
 * §5.2.5 — the amendment carries the full proposed text, so the merged result
 * is its content. Then §5.3: every other pending amendment written against the
 * version we just superseded is frozen. No automatic merging, by design.
 */
export function adoptAmendment(amendment, prop) {
  const supersededVersionId = prop.current_version_id;
  newVersion({
    propositionId: prop.id,
    content: amendment.markdown_content,
    note: `Amendment adopted: ${amendment.name}`,
    authorTeamId: amendment.proposing_team_id,
    parentVersionId: supersededVersionId,
  });
  run(
    `UPDATE amendments
        SET status = 'adopted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    amendment.id
  );
  run(
    `UPDATE amendments
        SET status = 'frozen', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE proposition_id = ? AND id <> ? AND status = 'pending'
        AND base_version_id = ?`,
    prop.id, amendment.id, supersededVersionId
  );
}

/**
 * Re-evaluate pending amendments after the sponsor set changed. Adopting one
 * freezes its rivals, so at most one can go through per pass.
 */
export function settlePendingAmendments(propositionId) {
  const pending = all(
    `SELECT * FROM amendments
      WHERE proposition_id = ? AND status = 'pending' ORDER BY id ASC`,
    propositionId
  );
  for (const amendment of pending) {
    const prop = getProposition(propositionId);
    if (amendment.base_version_id !== prop.current_version_id) continue;
    if (amendmentApprovalState(amendment, prop).complete) {
      adoptAmendment(amendment, prop);
      return amendment.id;
    }
  }
  return null;
}

export function assertOwnTeam(row, user, what = 'this') {
  const owner = row.proposing_team_id ?? row.initiating_team_id;
  if (owner !== user.team_id) throw denied(`Only ${what} author delegation can do that.`);
}

export { bad, conflict, denied, missing };
