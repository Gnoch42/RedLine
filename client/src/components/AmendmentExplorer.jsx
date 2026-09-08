import React, { useState } from 'react';
import { Card, Stamp, formatDate } from './bits.jsx';
import { CountryLink } from './CountryCard.jsx';

const STATUSES = [
  ['pending', 'Pending'],
  ['frozen', 'Frozen'],
  ['draft', 'Draft'],
  ['adopted', 'Adopted'],
  ['detached', 'Detached'],
  ['withdrawn', 'Withdrawn'],
];
const byModified = (a, b) => b.updated_at.localeCompare(a.updated_at);

/**
 * Sub-amendments belong under the amendment they answer, whichever way the list
 * is filtered — grouping by the parent's id keeps them there.
 */
function inFamilies(list) {
  const key = (a) => a.parent_amendment_id ?? a.id;
  return [...list].sort((a, b) => {
    if (key(a) !== key(b)) {
      const anchorA = list.find((x) => x.id === key(a)) || a;
      const anchorB = list.find((x) => x.id === key(b)) || b;
      return byModified(anchorA, anchorB) || (key(a) - key(b));
    }
    if (a.is_sub !== b.is_sub) return a.is_sub ? 1 : -1;
    return byModified(a, b);
  });
}

/** Right panel: amendments filed against the proposition currently open. */
export function AmendmentExplorer({ proposition, amendments, selectedId, onSelect, onNew, canPropose }) {
  const [status, setStatus] = useState('all');

  if (!proposition) {
    return (
      <section className="panel panel--right">
        <div className="panel__head"><h2>Amendments</h2><div className="sub">No proposition open</div></div>
        <div className="panel__empty">Open a proposition to see the amendments filed against it.</div>
      </section>
    );
  }

  const all = amendments || [];
  const counts = {};
  for (const amendment of all) counts[amendment.status] = (counts[amendment.status] || 0) + 1;
  const list = inFamilies(all.filter((a) => status === 'all' || a.status === status));

  return (
    <section className="panel panel--right">
      <div className="panel__head">
        <h2>Amendments</h2>
        <div className="sub">to #{proposition.id} {proposition.name}</div>
        <div className="panel__toolbar">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Show amendments with this status"
          >
            <option value="all">All statuses ({all.length})</option>
            {STATUSES.filter(([key]) => counts[key]).map(([key, label]) => (
              <option key={key} value={key}>{label} ({counts[key]})</option>
            ))}
          </select>
        </div>
        <div className="panel__toolbar">
          <button className="btn btn--small btn--block" onClick={onNew} disabled={!canPropose}>
            + Propose an amendment
          </button>
        </div>
      </div>

      <div className="panel__body">
        {list.length === 0 && all.length > 0 && (
          <div className="panel__empty">Nothing here with that status.</div>
        )}

        {all.length === 0 && (
          <div className="panel__empty">
            Nothing filed yet.<br />
            {canPropose
              ? 'Propose a change to this text and collect the sponsors’ approval.'
              : 'Amendments are written by delegations, against a live proposition.'}
          </div>
        )}

        {list.map((amendment) => (
          <Card
            key={amendment.id}
            className={[
              'card',
              amendment.is_sub ? 'card--sub' : '',
              amendment.id === selectedId ? 'card--selected' : '',
              amendment.is_own_team ? 'card--own' : '',
              amendment.status === 'frozen' ? 'card--frozen' : '',
              amendment.status === 'adopted' ? 'card--adopted' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(amendment.id)}
          >
            <div className="card__top">
              <span className="card__name">
                {amendment.is_sub && <span className="card__branch" aria-hidden="true">↳ </span>}
                {amendment.name}
              </span>
            </div>
            {amendment.is_sub && amendment.parent && (
              <div className="card__desc">
                rewording {amendment.parent.country_name}’s “{amendment.parent.name}”
              </div>
            )}
            <div className="card__foot">
              <CountryLink name={amendment.proposing_team.country_name} className="card__country" />
              <span className="spacer" />
              <Stamp status={amendment.status} />
            </div>
            <div className="card__foot" style={{ marginTop: 3 }}>
              <span>
                {amendment.status === 'pending' || amendment.status === 'frozen'
                  ? amendment.is_sub
                    ? `${amendment.approval.approved_count}/1 — its author's call`
                    : `${amendment.approval.approved_count}/${amendment.approval.required_count} sponsors approved`
                  : amendment.sub_amendment_count > 0
                    ? `${amendment.sub_amendment_count} sub-amendment(s)`
                    : `on version ${amendment.base_version.number}`}
              </span>
              <span className="spacer" />
              <span>{formatDate(amendment.updated_at)}</span>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
