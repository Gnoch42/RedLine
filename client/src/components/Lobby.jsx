import React, { useEffect, useState } from 'react';
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
const ROLES = [
  ['delegate', 'Delegate', 'You represent a country in committee.'],
  ['faculty', 'Faculty', 'You accompany a delegation as its teacher or advisor.'],
  ['secretariat', 'Secretariat', 'You run the event. You watch every committee and take no part in the drafting.'],
];

function Credentials({ onAuthenticated, prefillJoinCode }) {
  const [mode, setMode] = useState(prefillJoinCode ? 'login' : 'register');
  const [country, setCountry] = useState('');
  const [role, setRole] = useState('delegate');
  const staff = role === 'secretariat';

  const form = useSubmit(async (data) => {
    const path = mode === 'register' ? '/auth/register' : '/auth/login';
    const body = mode === 'register'
      ? {
          delegate_name: data.get('delegate_name'),
          email: data.get('email'),
          phone: data.get('phone'),
          role,
          ...(staff ? {} : { country }),
        }
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
            <span className="label">You are here as</span>
            <div className="roles">
              {ROLES.map(([key, label, blurb]) => (
                <button
                  type="button"
                  key={key}
                  className="role"
                  aria-pressed={role === key}
                  onClick={() => setRole(key)}
                >
                  <span className="role__name">{label}</span>
                  <span className="role__blurb">{blurb}</span>
                </button>
              ))}
            </div>
          </div>

          {!staff && (
            <div className="field">
              <span className="label">The country you represent</span>
              <CountrySelect value={country} onChange={setCountry} />
              <span className="hint">
                Filled in for you whenever you register a delegation, so nobody ends up filed
                under a country they did not mean.
              </span>
            </div>
          )}
        </>
      )}

      <label className="field">
        <span className="label">Email</span>
        <input name="email" type="email" required placeholder="camille@school.example"
               autoComplete="email" />
        {mode === 'register' && <span className="hint">How we recognise you next time.</span>}
      </label>

      {mode === 'register' && (
        <label className="field">
          <span className="label">Phone or WhatsApp</span>
          <input name="phone" type="tel" placeholder="+1 514 555 0101" autoComplete="tel" />
          <span className="hint">
            Optional, and shown to everyone at the conference — it is how other delegations reach
            you between sessions.
          </span>
        </label>
      )}

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
        disabled={form.busy || (mode === 'register' && !staff && !country.trim())}
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

/**
 * The committees on this instance, to be picked from rather than reached with a
 * code. Registering is then one choice — the country comes from the account.
 */
function JoinCommittee({ me, onUser, onSwitched, onOpenCommittee }) {
  const staff = me?.role === 'secretariat';
  const [committees, setCommittees] = useState(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState(null);
  const [country, setCountry] = useState(me?.country || '');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/committees')
      .then(({ committees: list }) => setCommittees(list))
      .catch((err) => setError(err.message));
  }, []);

  const choose = (committee) => {
    setError(null);
    // The secretariat holds no seat anywhere: opening a room is all there is.
    if (staff) {
      onOpenCommittee(committee.id);
      return;
    }
    // Already seated here: this is a way back in, not a second delegation.
    if (committee.my_team_id) {
      onSwitched(committee.my_team_id);
      return;
    }
    if (!committee.may_enter) {
      setError(`${committee.name} seats only the countries on its list, and ${me?.country} is not one of them.`);
      return;
    }
    setChosen(committee);
    setChanging(false);
    const taken = committee.taken_countries.map((c) => c.toLowerCase());
    setCountry(taken.includes((me?.country || '').toLowerCase()) ? '' : (me?.country || ''));
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { user } = await api('/teams', {
        method: 'POST',
        body: { committee_id: chosen.id, country_name: country },
      });
      onUser(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (error && !committees) return <div className="notice">{error}</div>;
  if (!committees) return <p className="lead">Looking for committees…</p>;

  if (committees.length === 0) {
    return (
      <p className="lead">
        {staff
          ? 'No committees have been set up yet. They will appear here as they are created.'
          : 'No committees have been set up yet. Start the first one on the next tab — whoever comes after you will find it here.'}
      </p>
    );
  }

  if (chosen) {
    const mine = (me?.country || '').trim();
    const taken = chosen.taken_countries.map((c) => c.toLowerCase());
    const clash = mine && taken.includes(mine.toLowerCase());
    return (
      <>
        <div className="chosen">
          <div className="chosen__name">{chosen.name}</div>
          {chosen.description && <div className="chosen__desc">{chosen.description}</div>}
          <div className="chosen__meta">
            {chosen.registered_teams} of {chosen.total_members} seats registered
          </div>
        </div>

        {clash && !changing && (
          <div className="notice" style={{ marginBottom: 12 }}>
            {mine} already has a delegation on this committee. Ask them for their join code to
            sit with them, or register under a different country here.
          </div>
        )}

        {changing || !country ? (
          <div className="field">
            <span className="label">Register as</span>
            <CountrySelect
              value={country}
              onChange={setCountry}
              taken={chosen.taken_countries}
            />
          </div>
        ) : (
          <p className="lead" style={{ marginBottom: 14 }}>
            You will be registered as <strong>{country}</strong>.{' '}
            <button type="button" className="linky" onClick={() => setChanging(true)}>
              Represent someone else
            </button>
          </p>
        )}

        {error && <div className="notice" style={{ marginBottom: 12 }}>{error}</div>}

        <button className="btn btn--primary btn--block" onClick={join} disabled={busy || !country.trim()}>
          {busy ? 'Joining…' : `Take ${chosen.name}'s ${country || ''} seat`.replace(/\s+/g, ' ')}
        </button>
        {/* Not every country is seated on every committee, and watching one you
            are not on is ordinary. */}
        <button
          className="btn btn--block"
          style={{ marginTop: 8 }}
          onClick={() => onOpenCommittee(chosen.id)}
          disabled={busy}
        >
          Just look in, without taking a seat
        </button>
        <div className="lobby__switch">
          <button type="button" onClick={() => setChosen(null)}>Back to the list</button>
        </div>
      </>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? committees.filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(needle))
    : committees;

  return (
    <>
      {committees.length > 6 && (
        <label className="field">
          <span className="label">Find a committee</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="UNDP" />
        </label>
      )}

      <div className="seats">
        {shown.map((committee) => (
          <button key={committee.id} className="seat seat--committee" onClick={() => choose(committee)}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="seat__country">{committee.name}</span>
              {committee.description && <span className="seat__desc">{committee.description}</span>}
            </span>
            <span className="seat__committee">
              {!staff && committee.my_team_id
                ? 'you are seated here'
                : committee.may_enter
                  ? `${committee.registered_teams}/${committee.total_members} seats`
                  : 'closed to your country'}
            </span>
          </button>
        ))}
        {shown.length === 0 && <p className="lead">Nothing matches “{filter}”.</p>}
      </div>
    </>
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
function SeatPicker({ me, onSit, onElsewhere }) {
  const [busy, setBusy] = useState(null);
  const enter = async (seat) => {
    setBusy(seat.team_id);
    try {
      await onSit(seat.team_id);
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
  const [tab, setTab] = useState(prefillJoinCode ? 'code' : 'browse');
  const [handover, setHandover] = useState(null);
  // Set when a delegate with existing seats asks to take another one.
  const [seatingElsewhere, setSeatingElsewhere] = useState(startSeating);

  const acceptUser = (user, { immediate = false } = {}) => {
    setMe(user);
    if (immediate) onEnter(user);
    else setHandover(user);
  };

  /** Sit down in a seat this delegate already holds. */
  const switchSeat = async (teamId) => {
    const { user } = await api('/auth/switch', { method: 'POST', body: { team_id: teamId } });
    onEnter(user);
  };

  /** The secretariat's way in: a committee, without a delegation in it. */
  const openCommittee = async (committeeId) => {
    const { user } = await api('/auth/switch', {
      method: 'POST', body: { committee_id: committeeId },
    });
    onEnter(user);
  };

  const seats = me?.seats || [];
  const staff = me?.role === 'secretariat';
  const choosing = me && !handover && !staff && seats.length > 0 && !seatingElsewhere;
  const seating = me && !handover && (staff || seats.length === 0 || seatingElsewhere);

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
          <SeatPicker me={me} onSit={switchSeat} onElsewhere={() => setSeatingElsewhere(true)} />
        )}

        {seating && me.role === 'secretariat' && (
          <>
            <h2>Open a committee</h2>
            <p className="lead">
              Signed in as <strong>{me.delegate_name}</strong>, event secretariat. You can look
              into any room; the drafting itself stays with the delegations.
            </p>
            {me.personal_code && (
              <CodeCard
                code={me.personal_code}
                what="Your sign-in code. You have no delegation to share one with, so this one is yours — keep it."
              />
            )}
            <JoinCommittee me={me} onUser={acceptUser} onSwitched={switchSeat}
                           onOpenCommittee={openCommittee} />
          </>
        )}

        {seating && me.role !== 'secretariat' && (
          <>
            <h2>Take your seat</h2>
            <p className="lead">
              Signed in as <strong>{me.delegate_name}</strong>
              {me.country ? <> for <strong>{me.country}</strong></> : null} ({me.email}).
            </p>
            <div className="lobby__tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'browse'} onClick={() => setTab('browse')}>
                Join a committee
              </button>
              <button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>
                Use a join code
              </button>
              <button role="tab" aria-selected={tab === 'create'} onClick={() => setTab('create')}>
                Start a committee
              </button>
            </div>
            {tab === 'browse' && (
              <JoinCommittee me={me} onUser={acceptUser} onSwitched={switchSeat}
                             onOpenCommittee={openCommittee} />
            )}
            {tab === 'code' && <JoinDelegation onUser={acceptUser} prefillJoinCode={prefillJoinCode} />}
            {tab === 'create' && <CreateCommittee me={me} onUser={acceptUser} />}
            {/* When the app itself sent us here, its own "go back" is the way out. */}
            {seats.length > 0 && !onCancel && (
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
            <h2>One code to hand out</h2>
            <p className="lead">Write it down now — it is how your fellow delegates get in.</p>
            <CodeCard
              code={handover.team.join_code}
              link={joinLink(handover.team.join_code)}
              what={`Your delegation (${handover.team.country_name}). Give it to your fellow delegates — it is also what they sign in with.`}
            />
            <p className="lead">
              The other countries need nothing from you: {handover.committee.name} is now in the
              list of committees they see when they sign in.
            </p>
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
