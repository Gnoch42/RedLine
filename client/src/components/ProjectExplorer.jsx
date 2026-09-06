import React, { useState } from 'react';
import { Card, Stamp, formatDate } from './bits.jsx';
import { CountryLink } from './CountryCard.jsx';

const firstSponsor = (p) => p.sponsors[0]?.country_name || '';

const SORTS = {
  modified: { label: 'Last modified', compare: (a, b) => b.updated_at.localeCompare(a.updated_at) },
  sponsor: { label: 'Lead sponsor', compare: (a, b) => firstSponsor(a).localeCompare(firstSponsor(b)) },
  support: { label: 'Support', compare: (a, b) => b.support.teams - a.support.teams },
  number: { label: 'Number', compare: (a, b) => a.id - b.id },
};

/** Left panel: the committee's agenda, and the propositions filed under it. */
export function ProjectExplorer({ board, committee, selectedId, onSelect, onNewProposition, onNewProject, onOpenSettings, canAct = true }) {
  const [sort, setSort] = useState('modified');
  const projects = board?.projects || [];

  return (
    <section className="panel panel--left">
      <div className="panel__head">
        <h2>{committee.name}</h2>
        <div className="sub">{committee.description || 'Agenda and propositions'}</div>
        <div className="panel__toolbar">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort propositions">
            {Object.entries(SORTS).map(([key, { label }]) => (
              <option key={key} value={key}>Sort: {label}</option>
            ))}
          </select>
          <button className="btn btn--small" onClick={onNewProject} title="Add an agenda item">+ Item</button>
          <button className="btn btn--small" onClick={onOpenSettings} title="Edit the agenda and committee settings">⚙</button>
        </div>
      </div>

      <div className="panel__body">
        {projects.length === 0 && (
          <div className="panel__empty">
            No agenda items yet.<br />Add one to start filing propositions.
          </div>
        )}

        {projects.map((project) => {
          const propositions = [...project.propositions].sort(SORTS[sort].compare);
          return (
            <div className="project" key={project.id}>
              <div className="project__head">
                <span className="project__name">{project.name}</span>
                <span className="project__count">{propositions.length}</span>
              </div>

              {propositions.map((proposition) => (
                <Card
                  key={proposition.id}
                  className={[
                    'card',
                    proposition.id === selectedId ? 'card--selected' : '',
                    proposition.my_roles.sponsor ? 'card--own' : '',
                    proposition.status === 'collecting' ? 'card--collecting' : '',
                    proposition.status === 'ready' ? 'card--ready' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelect(proposition.id)}
                >
                  <div className="card__top">
                    <span className="card__number">#{proposition.id}</span>
                    <span className="card__name">{proposition.name}</span>
                  </div>
                  <div className="card__foot">
                    {proposition.sponsors.slice(0, 2).map((sponsor, index) => (
                      <React.Fragment key={sponsor.team_id}>
                        {index > 0 && <span>·</span>}
                        <CountryLink name={sponsor.country_name} className="card__country" />
                      </React.Fragment>
                    ))}
                    {proposition.sponsors.length > 2 && (
                      <span>+{proposition.sponsors.length - 2}</span>
                    )}
                    <span className="spacer" />
                    {proposition.support.eligible && <span className="stamp stamp--eligible">20%</span>}
                    <Stamp status={proposition.status} />
                  </div>
                  {proposition.status !== 'draft' && (
                    <div className="card__foot" style={{ marginTop: 3 }}>
                      <span>
                        v{proposition.version_count} · {proposition.support.teams}/{proposition.support.total_members} backing
                        {proposition.readiness.sponsor_count > 1
                          && proposition.status === 'active'
                          && ` · ${proposition.readiness.ready_count}/${proposition.readiness.sponsor_count} settled`}
                      </span>
                      <span className="spacer" />
                      <span>{formatDate(proposition.updated_at)}</span>
                    </div>
                  )}
                </Card>
              ))}

              {canAct && (
                <button className="btn btn--ghost btn--small" onClick={() => onNewProposition(project.id)}>
                  + New proposition
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
