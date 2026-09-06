import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';
import { Stamp } from './bits.jsx';

/**
 * Any country name in the interface opens its card. The provider holds the one
 * modal; CountryLink is what every list and info bar renders.
 */
const CountryContext = createContext(() => {});

export function CountryProvider({ children }) {
  const [open, setOpen] = useState(null);
  return (
    <CountryContext.Provider value={setOpen}>
      {children}
      {open && <CountryModal country={open} onClose={() => setOpen(null)} />}
    </CountryContext.Provider>
  );
}

export function CountryLink({ name, className = '' }) {
  const show = useContext(CountryContext);
  if (!name) return null;
  return (
    <button
      type="button"
      className={`countrylink ${className}`.trim()}
      title={`Who speaks for ${name}`}
      onClick={(event) => {
        // Cards are clickable too; opening the card should not also open them.
        event.stopPropagation();
        show(name);
      }}
    >
      {name}
    </button>
  );
}

const ROLE_LABEL = { delegate: 'delegate', faculty: 'faculty advisor', secretariat: 'secretariat' };

function CountryModal({ country, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api(`/countries/${encodeURIComponent(country)}`)
      .then((result) => { if (alive) setData(result); })
      .catch((err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [country]);

  return (
    <Modal title={data?.country || country} subtitle="Delegation" onClose={onClose}>
      {error && <div className="notice">{error}</div>}
      {!error && !data && <p className="lead">Looking it up…</p>}

      {data?.delegations.map((delegation) => (
        <section key={delegation.team_id} className="delegation">
          <div className="delegation__head">
            <span className="delegation__committee">{delegation.committee_name}</span>
          </div>

          {delegation.delegates.length === 0 ? (
            <p className="delegation__empty">Registered, but nobody has signed in yet.</p>
          ) : (
            <div className="rows">
              {delegation.delegates.map((person) => (
                <div className="row row--person" key={person.id}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{person.delegate_name}</strong>
                    {person.role !== 'delegate' && (
                      <span className="label" style={{ marginLeft: 6 }}>{ROLE_LABEL[person.role]}</span>
                    )}
                    {person.is_primary && (
                      <span className="chip chip--works" title="This is one of their working committees">
                        works here
                      </span>
                    )}
                    {!person.is_primary && person.also_on.length > 0 && (
                      <span className="label" style={{ marginLeft: 6 }}>
                        works on {person.also_on.join(', ')}
                      </span>
                    )}
                    <span className="person__contact">
                      <a href={`mailto:${person.email}`} onClick={(e) => e.stopPropagation()}>
                        {person.email}
                      </a>
                      {person.phone && (
                        <>
                          {' · '}
                          <a href={`tel:${person.phone.replace(/[^\d+]/g, '')}`}>{person.phone}</a>
                        </>
                      )}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {delegation.propositions.length > 0 && (
            <div className="delegation__props">
              <span className="label">On the table here</span>
              {delegation.propositions.map((proposition) => (
                <div className="row" key={proposition.id}>
                  <span style={{ flex: 1 }}>{proposition.name}</span>
                  <Stamp status={proposition.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </Modal>
  );
}
