import React from 'react';
import { CountryLink } from './CountryCard.jsx';

/**
 * An explorer card. A div rather than a button, because country names inside it
 * are buttons of their own and nesting them would be invalid.
 */
export function Card({ className, onClick, children }) {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

// A proposition's phase, in the words that fit on a stamp.
const STATUS_LABEL = {
  draft: 'draft',
  active: 'open',
  collecting: 'signing',
  ready: 'ready',
  withdrawn: 'withdrawn',
};

export function Stamp({ status }) {
  if (!status) return null;
  return <span className={`stamp stamp--${status}`}>{STATUS_LABEL[status] || status}</span>;
}

/** How far along the sponsors are in calling the text final. */
export function ReadinessLine({ readiness, sponsors }) {
  if (readiness.sponsor_count === 0) return null;
  const waiting = sponsors.filter((s) => !s.ready).map((s) => s.country_name);
  return (
    <div className="tally__head" style={{ marginTop: 6 }}>
      <strong>{readiness.ready_count}/{readiness.sponsor_count}</strong>
      <span>
        sponsors call the text settled
        {waiting.length > 0 && ` — waiting on ${waiting.join(', ')}`}
      </span>
    </div>
  );
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Progress toward the 20% of the committee needed to present (§5.4). */
export function SupportMeter({ support }) {
  const pct = Math.round(support.percent * 1000) / 10;
  const width = Math.min(100, support.percent * 100);
  return (
    <div className="meter">
      <div className="meter__bar">
        <div
          className={`meter__fill${support.eligible ? ' meter__fill--eligible' : ''}`}
          style={{ width: `${width}%` }}
        />
        <div className="meter__tick" style={{ left: `${support.threshold * 100}%` }} />
      </div>
      <div className="meter__caption">
        <span>
          <strong>{support.teams}</strong>/{support.total_members} delegations — {pct}%
        </span>
        {support.eligible
          ? <span className="stamp stamp--eligible">eligible to present</span>
          : <span style={{ color: 'var(--ink-3)' }}>
              {Math.max(0, Math.ceil(support.total_members * support.threshold) - support.teams)} more to reach 20%
            </span>}
      </div>
    </div>
  );
}

/** Which sponsors of the target proposition have approved an amendment (§5.2.4). */
export function ApprovalTally({ approval, myTeamId, compact = false }) {
  if (approval.required_count === 0) {
    return (
      <div className="tally">
        <div className="tally__head">
          The proposition has no sponsors yet, so no one can approve amendments to it.
        </div>
      </div>
    );
  }
  return (
    <div className="tally">
      <div className="tally__head">
        <strong>{approval.approved_count}/{approval.required_count}</strong>
        <span>sponsors approved</span>
      </div>
      {!compact && (
        <ul className="tally__list">
          {approval.required.map((sponsor) => (
            <li key={sponsor.team_id} className={sponsor.team_id === myTeamId ? 'is-you' : undefined}>
              <span className={`tally__box${sponsor.approved ? ' tally__box--checked' : ''}`}>
                {sponsor.approved ? '✓' : ''}
              </span>
              <CountryLink name={sponsor.country_name} />
              {sponsor.team_id === myTeamId && <span className="label">you</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Blank({ mark = '§', title, children }) {
  return (
    <div className="blank">
      <div className="blank__mark">{mark}</div>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast${toast.kind === 'error' ? ' toast--error' : ''}`} role="status">
      {toast.message}
    </div>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="struck">RED</span>
      <span className="inserted">LINE</span>
    </span>
  );
}
