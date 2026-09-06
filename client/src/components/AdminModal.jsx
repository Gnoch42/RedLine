import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

/**
 * The instance's keys, and deliberately little else: find an account, hand its
 * owner a way back in, and appoint someone else who can do the same. There is
 * no mail server in this design, so a reset code is read out to the person in
 * front of you.
 */
export function AdminModal({ user, onClose }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (q = query) => {
    setError(null);
    try {
      const { users: found } = await api(`/auth/admin/users?q=${encodeURIComponent(q)}`);
      setUsers(found);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => load(query), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Administration" subtitle="This instance" onClose={onClose}>
      {error && <div className="notice" style={{ marginBottom: 12 }}>{error}</div>}

      {issued && (
        <div className="undertaking" style={{ marginBottom: 16 }}>
          Reset code for <strong>{issued.email}</strong>
          <div className="codecard__code" style={{ margin: '8px 0 4px' }}>{issued.reset_code}</div>
          Good for one use, for the next {issued.minutes} minutes. Read it out to them in person —
          it is the whole of their account until they set a password with it.
          <div style={{ marginTop: 8 }}>
            <button className="btn btn--small" onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      )}

      <label className="field">
        <span className="label">Find an account</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, email or country"
          autoFocus
        />
      </label>

      <div className="rows">
        {users.map((person) => (
          <div className="row row--person" key={person.id}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{person.delegate_name}</strong>
              {person.is_admin && <span className="chip chip--works">admin</span>}
              {person.role !== 'delegate' && (
                <span className="label" style={{ marginLeft: 6 }}>{person.role}</span>
              )}
              <span className="person__contact">
                {person.email}
                {person.country && ` · ${person.country}`}
                {` · ${person.seats} seat(s)`}
                {!person.has_password && ' · no password yet'}
                {person.has_reset && ' · reset pending'}
              </span>
            </span>
            <button
              className="btn btn--small"
              disabled={busy}
              onClick={() => act(async () => {
                const result = await api(`/auth/admin/users/${person.id}/reset`, { method: 'POST' });
                setIssued(result);
              })}
            >
              Reset code
            </button>
            <button
              className="btn btn--small btn--ghost"
              disabled={busy || person.id === user.id}
              title={person.id === user.id ? 'You cannot change your own standing here' : undefined}
              onClick={() => act(() => api(`/auth/admin/users/${person.id}/admin`, {
                method: 'POST', body: { is_admin: !person.is_admin },
              }))}
            >
              {person.is_admin ? 'Remove admin' : 'Make admin'}
            </button>
          </div>
        ))}
        {users.length === 0 && (
          <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>Nobody matches that.</p>
        )}
      </div>

      <p className="lead" style={{ marginTop: 16, fontSize: 12 }}>
        Administration is separate from the secretariat on purpose: it is the keys to the
        installation, not standing in a committee. The first administrator is appointed from the
        machine itself, with <code>npm run admin -- grant</code>.
      </p>
    </Modal>
  );
}
