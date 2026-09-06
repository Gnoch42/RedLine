import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';
import { CodeCard } from './CodeCard.jsx';
import { CountrySelect } from './CountrySelect.jsx';
import { CountryLink } from './CountryCard.jsx';
import { WhitelistEditor } from './WhitelistEditor.jsx';

const joinLink = (code) => `${window.location.origin}/?join=${encodeURIComponent(code)}`;

function Error({ message }) {
  if (!message) return null;
  return <div className="notice" style={{ marginBottom: 12 }}>{message}</div>;
}

/**
 * Committee settings. Nothing here needs a moderator (§5.5) — any delegate
 * seated on the committee can correct what was typed when it was set up.
 */
function Settings({ committee, data, onSaved }) {
  const [values, setValues] = useState({
    name: committee.name,
    description: committee.description || '',
    total_members: committee.total_members,
  });
  const [restricted, setRestricted] = useState(!!committee.whitelist_enabled);
  const [blockObservers, setBlockObservers] = useState(!!committee.block_observers);
  const [whitelist, setWhitelist] = useState(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Seed the list from the server once, then keep editing locally until saved.
  useEffect(() => {
    if (whitelist === null && data?.whitelist) setWhitelist(data.whitelist);
  }, [data, whitelist]);

  const touch = () => setSaved(false);
  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    touch();
  };
  const list = whitelist || [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/committees/${committee.id}`, {
        method: 'PATCH',
        body: {
          ...values,
          total_members: Number(values.total_members),
          whitelist_enabled: restricted,
          block_observers: blockObservers,
          whitelist: list,
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const seatsChanged = Number(values.total_members) !== committee.total_members;

  return (
    <>
      <Error message={error} />
      <label className="field">
        <span className="label">Committee name</span>
        <input value={values.name} onChange={set('name')} />
      </label>
      <label className="field">
        <span className="label">Description</span>
        <input value={values.description} onChange={set('description')} />
      </label>
      <label className="field">
        <span className="label">Seats in committee</span>
        <input type="number" min="1" value={values.total_members} onChange={set('total_members')} />
        <span className="hint">
          Every country seated, whether or not they use Redline. This is the denominator of the 20%
          needed to present a proposition, so changing it moves every eligibility figure at once.
        </span>
      </label>
      {seatsChanged && (
        <div className="notice" style={{ marginBottom: 12 }}>
          Changing the seat count from {committee.total_members} to {values.total_members} will
          recalculate support for every proposition on this committee.
        </div>
      )}

      <WhitelistEditor
        enabled={restricted}
        onEnabled={(v) => { setRestricted(v); touch(); }}
        blockObservers={blockObservers}
        onBlockObservers={(v) => { setBlockObservers(v); touch(); }}
        list={list}
        onList={(next) => { setWhitelist(next); touch(); }}
        adding={adding}
        onAdding={setAdding}
        registered={(data?.teams || []).map((t) => t.country_name)}
      />

      <button className="btn btn--primary" onClick={save} disabled={busy || !values.name.trim()}>
        {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save settings'}
      </button>
    </>
  );
}

/** The agenda: add, rename and remove items. */
function Agenda({ committee, onChanged }) {
  const [projects, setProjects] = useState(null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState(null);

  const load = async () => {
    const { projects: list } = await api(`/committees/${committee.id}/projects`);
    setProjects(list);
  };
  useEffect(() => { load().catch((err) => setError(err.message)); }, [committee.id]);

  const run = async (fn) => {
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  const add = () => {
    const name = adding.trim();
    if (!name) return;
    run(async () => {
      await api(`/committees/${committee.id}/projects`, { method: 'POST', body: { name } });
      setAdding('');
    });
  };

  return (
    <>
      <Error message={error} />
      <div className="rows">
        {(projects || []).map((project, index) => (
          <AgendaRow
            key={project.id}
            project={project}
            first={index === 0}
            last={index === projects.length - 1}
            onRename={(name) => run(() => api(`/projects/${project.id}`, { method: 'PATCH', body: { name } }))}
            onMove={(delta) => run(() => api(`/projects/${project.id}`, {
              method: 'PATCH',
              body: { name: project.name, position: Math.max(0, index + delta) },
            }))}
            onDelete={() => run(() => api(`/projects/${project.id}`, { method: 'DELETE' }))}
          />
        ))}
        {projects?.length === 0 && (
          <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>No agenda items yet.</p>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="New agenda item"
          style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--rule-strong)', borderRadius: 3, background: 'var(--paper)' }}
        />
        <button className="btn btn--primary" onClick={add} disabled={!adding.trim()}>Add</button>
      </div>
    </>
  );
}

function AgendaRow({ project, first, last, onRename, onMove, onDelete }) {
  const [name, setName] = useState(project.name);
  const [editing, setEditing] = useState(false);

  useEffect(() => { setName(project.name); }, [project.name]);

  const commit = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== project.name) onRename(name.trim());
    else setName(project.name);
  };

  return (
    <div className="row">
      {editing ? (
        <input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setName(project.name); setEditing(false); }
          }}
          style={{ flex: 1, padding: '3px 6px', border: '1px solid var(--redline)', borderRadius: 3 }}
        />
      ) : (
        <button
          className="btn btn--ghost btn--small"
          style={{ flex: 1, justifyContent: 'flex-start', fontWeight: 600 }}
          onClick={() => setEditing(true)}
        >
          {project.name}
        </button>
      )}
      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
        {project.proposition_count} proposition(s)
      </span>
      <button className="btn btn--ghost btn--small" onClick={() => onMove(-1)} disabled={first} title="Move up">↑</button>
      <button className="btn btn--ghost btn--small" onClick={() => onMove(1)} disabled={last} title="Move down">↓</button>
      <button
        className="btn btn--ghost btn--small"
        onClick={() => {
          if (window.confirm(`Remove "${project.name}" from the agenda?`)) onDelete();
        }}
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
}

function Codes({ user }) {
  if (user.role === 'secretariat') {
    return (
      <>
        {user.personal_code && (
          <CodeCard
            code={user.personal_code}
            what="Your sign-in code. It belongs to you, not to a delegation — keep it."
          />
        )}
        <p style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          Delegations hand out their own join codes; yours gets you into every committee.
        </p>
      </>
    );
  }
  return (
    <>
      <CodeCard
        code={user.team.join_code}
        link={joinLink(user.team.join_code)}
        what={`Join code for the ${user.team.country_name} delegation — your fellow delegates sign in with it.`}
      />
      <p style={{ fontSize: 13, color: 'var(--ink-2)' }}>
        Other countries need nothing from you: {user.committee.name} appears in the list of
        committees everyone sees when they sign in, and they register their own delegation from
        there.
      </p>
    </>
  );
}

/** Your own account: the name and country that follow you between committees. */
function Account({ user, seat, onSaved, onLeave }) {
  const [values, setValues] = useState({
    delegate_name: user.delegate_name,
    phone: user.phone || '',
    country: user.country || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const staff = user.role === 'secretariat';
  const dirty = values.delegate_name !== user.delegate_name
    || values.phone !== (user.phone || '')
    || values.country !== (user.country || '');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/me', { method: 'PATCH', body: values });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--rule)' }}>
      <span className="label">Your account</span>
      <Error message={error} />
      <label className="field" style={{ marginTop: 8 }}>
        <span className="label">Name</span>
        <input
          value={values.delegate_name}
          onChange={(e) => { setValues((v) => ({ ...v, delegate_name: e.target.value })); setSaved(false); }}
        />
      </label>
      <label className="field">
        <span className="label">Phone or WhatsApp</span>
        <input
          type="tel"
          value={values.phone}
          onChange={(e) => { setValues((v) => ({ ...v, phone: e.target.value })); setSaved(false); }}
          placeholder="+1 514 555 0101"
        />
        <span className="hint">Optional, and visible to everyone at the conference.</span>
      </label>
      {!staff && (
        <div className="field">
          <span className="label">The country you represent</span>
          <CountrySelect
            value={values.country}
            onChange={(country) => { setValues((v) => ({ ...v, country })); setSaved(false); }}
          />
          <span className="hint">
            The default when you register a delegation. Changing it leaves the delegations you
            already hold untouched.
          </span>
        </div>
      )}
      {user.team && (
        <label className="signature-check" style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={!!seat?.is_primary}
            onChange={async (event) => {
              await api(`/auth/seats/${user.team.id}`, {
                method: 'PATCH', body: { is_primary: event.target.checked },
              });
              onSaved();
            }}
          />
          <span>
            {user.committee.name} is one of my working committees — shown on the country card so
            the rest of the conference knows who covers what.
          </span>
        </label>
      )}

      <button
        className="btn"
        onClick={save}
        disabled={busy || !dirty || !values.delegate_name.trim() || (!staff && !values.country.trim())}
      >
        {busy ? 'Saving…' : saved && !dirty ? 'Saved ✓' : 'Save'}
      </button>

      {user.team && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--rule)' }}>
          <span className="label">Leaving</span>
          <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '6px 0 8px' }}>
            Give up your seat on {user.committee.name}. If you are the last delegate of{' '}
            {user.team.country_name} here and the delegation has taken no position, the country is
            released and can be registered again; if it sponsors or has signed anything, the
            delegation stays on the record without you.
          </p>
          <button className="btn btn--ghost btn--small" onClick={onLeave}>
            Give up this seat
          </button>
        </div>
      )}
    </div>
  );
}

function Delegations({ user, data, onSaved, onLeave }) {
  return (
    <>
      <span className="label">Delegations registered</span>
      <div className="rows" style={{ marginTop: 6 }}>
        {(data?.teams || []).map((team) => (
          <div className="row" key={team.id}>
            <CountryLink name={team.country_name} className="row__country" />
            {team.id === user.team?.id && <span className="label">you</span>}
            <span className="spacer" />
            <span style={{ color: 'var(--ink-3)' }}>{team.delegate_count} delegate(s)</span>
          </div>
        ))}
      </div>
      <p className="label" style={{ marginTop: 8 }}>
        {data?.teams?.length || 0} of {user.committee.total_members} seats signed in — the 20%
        threshold is always measured against all {user.committee.total_members}.
      </p>

      {user.team && (
        <div style={{ marginTop: 18 }}>
          <span className="label">Your delegation</span>
          <div className="rows" style={{ marginTop: 6 }}>
            {(data?.delegates || []).map((delegate) => (
              <div className="row row--person" key={delegate.id}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{delegate.delegate_name}</strong>
                  {delegate.role !== 'delegate' && (
                    <span className="label" style={{ marginLeft: 6 }}>{delegate.role}</span>
                  )}
                  <span className="person__contact">
                    <a href={`mailto:${delegate.email}`}>{delegate.email}</a>
                    {delegate.phone && <>{' · '}{delegate.phone}</>}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(data?.secretariat || []).length > 0 && (
        <div style={{ marginTop: 18 }}>
          <span className="label">Event secretariat</span>
          <div className="rows" style={{ marginTop: 6 }}>
            {data.secretariat.map((person) => (
              <div className="row row--person" key={person.id}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{person.delegate_name}</strong>
                  <span className="person__contact">
                    <a href={`mailto:${person.email}`}>{person.email}</a>
                    {person.phone && <>{' · '}{person.phone}</>}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Account user={user} seat={data?.my_seat} onSaved={onSaved} onLeave={onLeave} />
    </>
  );
}

const TABS = [
  ['codes', 'Codes'],
  ['agenda', 'Agenda'],
  ['settings', 'Settings'],
  ['delegations', 'Delegations'],
];

export function CommitteeModal({ user, onClose, onChanged, onLeave, initialTab = 'codes' }) {
  const [tab, setTab] = useState(initialTab);
  const [data, setData] = useState(null);

  useEffect(() => {
    api(`/committees/${user.committee.id}`).then(setData).catch(() => setData(null));
  }, [user.committee.id, tab]);

  return (
    <Modal title={user.committee.name} subtitle="Committee" onClose={onClose}>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'codes' && <Codes user={user} />}
      {tab === 'agenda' && <Agenda committee={user.committee} onChanged={onChanged} />}
      {tab === 'settings' && <Settings committee={user.committee} data={data} onSaved={onChanged} />}
      {tab === 'delegations' && (
        <Delegations user={user} data={data} onSaved={onChanged} onLeave={onLeave} />
      )}
    </Modal>
  );
}
