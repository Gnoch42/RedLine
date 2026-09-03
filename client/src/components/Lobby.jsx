import React, { useState } from 'react';
import { api, setToken } from '../api.js';
import { Wordmark } from './bits.jsx';
import { CodeCard } from './CodeCard.jsx';
import { CountrySelect } from './CountrySelect.jsx';

const joinLink = (code) => `${window.location.origin}/?join=${encodeURIComponent(code)}`;

function useSubmit(handler) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const onSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await handler(new FormData(event.currentTarget));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { onSubmit, busy, error };
}

/* ------------------------------------------------------------- step one */

/**
 * An account is a person: a name and an email, nothing about countries or
 * committees. Those come from the codes they present next, and there can be
 * several of them.
 */
function Credentials({ onAuthenticated, prefillJoinCode }) {
  const [mode, setMode] = useState(prefillJoinCode ? 'login' : 'register');
  const [country, setCountry] = useState('');

  const form = useSubmit(async (data) => {
    const path = mode === 'register' ? '/auth/register' : '/auth/login';
    const body = mode === 'register'
      ? { delegate_name: data.get('delegate_name'), email: data.get('email'), country }
      : { email: data.get('email'), join_code: data.get('join_code') };
    const result = await api(path, { method: 'POST', body });
    setToken(result.token);
    onAuthenticated(result.user);
  });

  return (
    <form onSubmit={form.onSubmit}>
      <h2>{mode === 'register' ? 'Create your delegate account' : 'Sign in'}</h2>
      <p className="lead">
        {mode === 'register'
          ? 'One account per person — you can sit on as many committees as you like with it.'
          : 'Your email, plus the join code of any delegation you belong to.'}
      </p>

      {mode === 'register' && (
        <>
          <label className="field">
            <span className="label">Your name</span>
            <input name="delegate_name" required placeholder="Camille Fournier" autoComplete="name" />
          </label>
          <div className="field">
            <span className="label">The country you represent</span>
            <CountrySelect value={country} onChange={setCountry} />
            <span className="hint">
              Filled in for you whenever you register a delegation, so nobody ends up filed under
              a country they did not mean.
            </span>
          </div>
        </>
      )}

      <label className="field">
        <span className="label">Email</span>
        <input name="email" type="email" required placeholder="camille@school.example"
               autoComplete="email" />
        {mode === 'register' && <span className="hint">How we recognise you next time.</span>}
      </label>

      {mode === 'login' && (
        <label className="field">
          <span className="label">Delegation join code</span>
          <input
            name="join_code"
            required
            placeholder="AB4K-7QRT"
            defaultValue={prefillJoinCode || ''}
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}
          />
          <span className="hint">A delegation shares one code — it is both invitation and password.</span>
        </label>
      )}

      {form.error && <div className="notice" style={{ marginBottom: 12 }}>{form.error}</div>}

      <button
        type="submit"
        className="btn btn--primary btn--block"
        disabled={form.busy || (mode === 'register' && !country.trim())}
      >
        {form.busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
      </button>

      <div className="lobby__switch">
        {mode === 'register' ? 'Already have an account? ' : 'First time here? '}
        <button type="button" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
          {mode === 'register' ? 'Sign in' : 'Create an account'}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- step two */

function JoinDelegation({ onUser, prefillJoinCode }) {
  const form = useSubmit(async (data) => {
    const { user } = await api('/teams/join', {
      method: 'POST', body: { join_code: data.get('join_code') },
    });
    onUser(user, { immediate: true });
  });
  return (
    <form onSubmit={form.onSubmit}>
      <label className="field">
        <span className="label">Delegation join code</span>
        <input name="join_code" required placeholder="AB4K-7QRT" defaultValue={prefillJoinCode || ''}
               style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em' }} />
        <span className="hint">From a delegate already on your delegation, or their QR code.</span>
      </label>
      {form.error && <div className="notice" style={{ marginBottom: 12 }}>{form.error}</div>}
      <button className="btn btn--primary btn--block" disabled={form.busy}>Join delegation</button>
    </form>
  );
}

function AddDelegation({ me, onUser }) {
  const [preview, setPreview] = useState(null);
  const [country, setCountry] = useState(me?.country || '');
  const form = useSubmit(async (data) => {
    const { user } = await api('/teams', {
      method: 'POST',
      body: { committee_code: data.get('committee_code'), country_name: country },
    });
    onUser(user);
  });

  const lookup = async (code) => {
    setPreview(null);
    if (!code || code.length < 4) return;
    try {
      const found = await api(`/committees/lookup?code=${encodeURIComponent(code)}`);
      setPreview(found);
    } catch { /* nothing found yet — stay quiet while they type */ }
  };

  return (
    <form onSubmit={form.onSubmit}>
      <label className="field">
        <span className="label">Committee code</span>
        <input name="committee_code" required placeholder="7KQP-2MTX" onBlur={(e) => lookup(e.target.value)}
               style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em' }} />
        <span className="hint">From whoever set up the committee.</span>
      </label>
      {preview && (
        <div className="notice" style={{ marginBottom: 14, borderLeftColor: 'var(--insert)', background: 'var(--insert-soft)', color: '#14543f' }}>
          <strong>{preview.committee.name}</strong> — {preview.teams.length} delegation(s) registered
          of {preview.committee.total_members} seats.
        </div>
      )}
      <div className="field">
        <span className="label">Your country</span>
        <CountrySelect
          value={country}
          onChange={setCountry}
          taken={(preview?.teams || []).map((t) => t.country_name)}
        />
        {me?.country && country !== me.country && (
          <span className="hint">
            Your account says {me.country}. Change it here only if you speak for someone else on
            this committee.
          </span>
        )}
      </div>
      {form.error && <div className="notice" style={{ marginBottom: 12 }}>{form.error}</div>}
      <button className="btn btn--primary btn--block" disabled={form.busy || !country.trim()}>
        Register delegation
      </button>
    </form>
  );
}

function CreateCommittee({ me, onUser }) {
  const [country, setCountry] = useState(me?.country || '');
  const form = useSubmit(async (data) => {
    const { user } = await api('/committees', {
      method: 'POST',
      body: {
        name: data.get('name'),
        description: data.get('description'),
        total_members: Number(data.get('total_members')),
        country_name: country,
        projects: String(data.get('projects') || '').split('\n').map((s) => s.trim()).filter(Boolean),
      },
    });
    onUser(user);
  });

  return (
    <form onSubmit={form.onSubmit}>
      <label className="field">
        <span className="label">Committee</span>
        <input name="name" required placeholder="UNDP" />
      </label>
      <label className="field">
        <span className="label">Description</span>
        <input name="description" placeholder="UN Development Programme" />
      </label>
      <label className="field">
        <span className="label">Seats in committee</span>
        <input name="total_members" type="number" min="1" required defaultValue="20" />
        <span className="hint">
          Every country seated, whether or not they sign in here. This is the denominator for the
          20% needed to present a proposition. You can correct it later.
        </span>
      </label>
      <div className="field">
        <span className="label">Your country</span>
        <CountrySelect value={country} onChange={setCountry} />
      </div>
      <label className="field">
        <span className="label">Agenda items</span>
        <textarea name="projects" rows="3" style={{ fontFamily: 'var(--sans)', fontSize: 14, minHeight: 80 }}
                  placeholder={'Climate finance\nDigital divide'} />
        <span className="hint">One per line. You can add more later.</span>
      </label>
      {form.error && <div className="notice" style={{ marginBottom: 12 }}>{form.error}</div>}
      <button className="btn btn--primary btn--block" disabled={form.busy || !country.trim()}>
        Open the committee
      </button>
    </form>
  );
}

/** The seats this delegate already holds, when there is a choice to make. */
function SeatPicker({ me, onEnter, onElsewhere }) {
  const [busy, setBusy] = useState(null);
  const enter = async (seat) => {
    setBusy(seat.team_id);
    try {
      const { user } = await api('/auth/switch', { method: 'POST', body: { team_id: seat.team_id } });
      onEnter(user);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <h2>Where are you sitting today?</h2>
      <p className="lead">Signed in as <strong>{me.delegate_name}</strong>.</p>
      <div className="seats">
        {me.seats.map((seat) => (
          <button key={seat.team_id} className="seat" onClick={() => enter(seat)} disabled={busy === seat.team_id}>
            <span className="seat__country">{seat.country_name}</span>
            <span className="seat__committee">{seat.committee_name}</span>
          </button>
        ))}
      </div>
      <button className="btn btn--block" style={{ marginTop: 14 }} onClick={onElsewhere}>
        Take a seat somewhere else
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ shell */

export function Lobby({ initialUser, onEnter, onCancel, prefillJoinCode, startSeating = false }) {
  const [me, setMe] = useState(initialUser || null);
  const [tab, setTab] = useState(prefillJoinCode ? 'join' : 'create');
  const [handover, setHandover] = useState(null);
  // Set when a delegate with existing seats asks to take another one.
  const [seatingElsewhere, setSeatingElsewhere] = useState(startSeating);

  const acceptUser = (user, { immediate = false } = {}) => {
    setMe(user);
    if (immediate) onEnter(user);
    else setHandover(user);
  };

  const seats = me?.seats || [];
  const choosing = me && !handover && seats.length > 0 && !seatingElsewhere;
  const seating = me && !handover && (seats.length === 0 || seatingElsewhere);

  return (
    <div className="lobby">
      <aside className="lobby__pitch">
        <Wordmark />
        <h1>Every change to the draft, attributed and reversible.</h1>
        <p>
          Redline replaces the shared document your committee would otherwise fight over. Rival
          drafts sit side by side, amendments carry their own sponsors, and the text only moves when
          the sponsors of a proposition all say so.
        </p>
        <div className="lobby__sample">
          2. <ins>Requests</ins> <del>Urges</del> the Secretariat to report{' '}
          <ins>by 31 March each year</ins><del>annually</del>.
        </div>
        <p style={{ fontSize: 12 }}>
          Adoption still happens in the room. This is the drafting floor, not the assembly.
        </p>
      </aside>

      <main className="lobby__panel">
        {/* Signing in already names a delegation, so there is nothing to choose. */}
        {!me && (
          <Credentials
            onAuthenticated={(user) => (user.team ? onEnter(user) : setMe(user))}
            prefillJoinCode={prefillJoinCode}
          />
        )}

        {choosing && (
          <SeatPicker me={me} onEnter={onEnter} onElsewhere={() => setSeatingElsewhere(true)} />
        )}

        {seating && (
          <>
            <h2>Take your seat</h2>
            <p className="lead">
              Signed in as <strong>{me.delegate_name}</strong>
              {me.country ? <> for <strong>{me.country}</strong></> : null} ({me.email}).
            </p>
            <div className="lobby__tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'join'} onClick={() => setTab('join')}>
                Join a delegation
              </button>
              <button role="tab" aria-selected={tab === 'add'} onClick={() => setTab('add')}>
                Register your country
              </button>
              <button role="tab" aria-selected={tab === 'create'} onClick={() => setTab('create')}>
                Start a committee
              </button>
            </div>
            {tab === 'join' && <JoinDelegation onUser={acceptUser} prefillJoinCode={prefillJoinCode} />}
            {tab === 'add' && <AddDelegation me={me} onUser={acceptUser} />}
            {tab === 'create' && <CreateCommittee me={me} onUser={acceptUser} />}
            {seats.length > 0 && (
              <div className="lobby__switch">
                <button type="button" onClick={() => setSeatingElsewhere(false)}>
                  Back to my committees
                </button>
              </div>
            )}
          </>
        )}

        {handover && (
          <>
            <h2>Codes to hand out</h2>
            <p className="lead">Write these down now — they are how everyone else gets in.</p>
            <CodeCard
              code={handover.team.join_code}
              link={joinLink(handover.team.join_code)}
              what={`Your delegation (${handover.team.country_name}). Give it to your fellow delegates — it is also what they sign in with.`}
            />
            <CodeCard
              code={handover.committee.committee_code}
              what={`${handover.committee.name}. Give it to the other countries so they can register their own delegation.`}
            />
            <button className="btn btn--primary btn--block" onClick={() => onEnter(handover)}>
              Enter {handover.committee.name}
            </button>
          </>
        )}

        {onCancel && (
          <div className="lobby__switch">
            <button type="button" onClick={onCancel}>Never mind, go back</button>
          </div>
        )}
      </main>
    </div>
  );
}
