import React from 'react';
import { Card, Stamp, formatDate } from './bits.jsx';
import { CountryLink } from './CountryCard.jsx';

const ORDER = { pending: 0, frozen: 1, draft: 2, adopted: 3, detached: 4, withdrawn: 5 };

/** Right panel: amendments filed against the proposition currently open. */
export function AmendmentExplorer({ proposition, amendments, selectedId, onSelect, onNew, canPropose }) {
  if (!proposition) {
    return (
      <section className="panel panel--right">
        <div className="panel__head"><h2>Amendments</h2><div className="sub">No proposition open</div></div>
        <div className="panel__empty">Open a proposition to see the amendments filed against it.</div>
      </section>
    );
  }

  const list = [...(amendments || [])].sort(
    (a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.updated_at.localeCompare(a.updated_at))
  );

  return (
    <section className="panel panel--right">
      <div className="panel__head">
        <h2>Amendments</h2>
        <div className="sub">to #{proposition.id} {proposition.name}</div>
        <div className="panel__toolbar">
          <button className="btn btn--small btn--block" onClick={onNew} disabled={!canPropose}>
            + Propose an amendment
          </button>
        </div>
      </div>

      <div className="panel__body">
        {list.length === 0 && (
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
              amendment.id === selectedId ? 'card--selected' : '',
              amendment.is_own_team ? 'card--own' : '',
              amendment.status === 'frozen' ? 'card--frozen' : '',
              amendment.status === 'adopted' ? 'card--adopted' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(amendment.id)}
          >
            <div className="card__top">
              <span className="card__name">{amendment.name}</span>
            </div>
            <div className="card__foot">
              <CountryLink name={amendment.proposing_team.country_name} className="card__country" />
              <span className="spacer" />
              <Stamp status={amendment.status} />
            </div>
            <div className="card__foot" style={{ marginTop: 3 }}>
              <span>
                {amendment.status === 'pending' || amendment.status === 'frozen'
                  ? `${amendment.approval.approved_count}/${amendment.approval.required_count} sponsors approved`
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
