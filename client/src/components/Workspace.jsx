import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Stamp, SupportMeter, ApprovalTally, Blank, formatDate } from './bits.jsx';
import { CountryLink } from './CountryCard.jsx';
import { Sheet, MarkdownBody, DiffBody, DiffSummary } from './DocumentSheet.jsx';

/** Content of one specific version, fetched on demand (history is not polled). */
function useVersion(propositionId, versionId) {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    if (!propositionId || !versionId) { setVersion(null); return undefined; }
    let alive = true;
    api(`/propositions/${propositionId}/versions/${versionId}`)
      .then(({ version: v }) => { if (alive) setVersion(v); })
      .catch(() => { if (alive) setVersion(null); });
    return () => { alive = false; };
  }, [propositionId, versionId]);
  return version;
}

/** Marked-up source, or the proposed text as it would read once accepted. */
function ReadingToggle({ value, onChange }) {
  return (
    <span className="segbar">
      <button type="button" aria-pressed={value === 'redline'} onClick={() => onChange('redline')}>
        Redline
      </button>
      <button type="button" aria-pressed={value === 'clean'} onClick={() => onChange('clean')}>
        Clean
      </button>
    </span>
  );
}

function SupportList({ label, teams }) {
  return (
    <div>
      <span className="label">{label}</span>{' '}
      {teams.length === 0
        ? <span className="none">none yet</span>
        : teams.map((team, index) => (
            <React.Fragment key={team.team_id}>
              {index > 0 && ', '}
              <CountryLink name={team.country_name} />
            </React.Fragment>
          ))}
    </div>
  );
}

function VersionPicker({ versions, value, onChange, allowCurrent = true, label = 'Version' }) {
  return (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="label">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        style={{ padding: '2px 6px', border: '1px solid var(--rule-strong)', borderRadius: 3, background: 'var(--paper)', fontSize: 12 }}
      >
        {allowCurrent && <option value="">Current (v{versions.length})</option>}
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            v{v.number} · {v.note || 'revision'} · {v.author_country}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------ info panes */

function PropositionPane({ proposition, on, hasAmendmentOpen, canAct }) {
  const own = proposition.is_own_team;
  const draft = proposition.status === 'draft';
  const live = proposition.status === 'active';

  return (
    <div className="infobar__pane">
      <div className="infobar__title">
        <h1>{proposition.name}</h1>
        <Stamp status={proposition.status} />
        {own && <span className="label">your delegation</span>}
      </div>
      <div className="infobar__meta">
        #{proposition.id} · {proposition.project_name} · initiated by{' '}
        <CountryLink name={proposition.initiating_team.country_name} /> · version{' '}
        {proposition.current_version?.number} of {proposition.version_count} · updated{' '}
        {formatDate(proposition.updated_at)}
      </div>

      {draft ? (
        <div className="notice" style={{ marginTop: 10, maxWidth: 520 }}>
          A draft of your delegation. Your fellow delegates can read and revise it; the rest of the
          committee cannot see it until you submit it.
        </div>
      ) : (
        <>
          <div className="sponsors">
            <SupportList label="Sponsors" teams={proposition.sponsors} />
            <SupportList label="Signatories" teams={proposition.signatories} />
          </div>
          <SupportMeter support={proposition.support} />
        </>
      )}

      {!canAct && (
        <div className="observing">
          You are here as event secretariat: everything is visible to you, and the drafting —
          proposing, sponsoring, approving — stays with the delegations.
        </div>
      )}

      <div className="infobar__actions">
        {canAct && draft && own && (
          <>
            <button className="btn" onClick={on.editProposition}>Edit draft</button>
            <button className="btn btn--redline" onClick={on.submitProposition}>Submit to committee</button>
          </>
        )}
        {canAct && live && (
          <>
            <button
              className={proposition.my_roles.sponsor ? 'btn' : 'btn btn--primary'}
              onClick={proposition.my_roles.sponsor ? on.unsponsor : on.sponsor}
            >
              {proposition.my_roles.sponsor ? 'Sponsoring ✓ — stand down' : 'Become a sponsor'}
            </button>
            <button
              className="btn"
              onClick={proposition.my_roles.signatory ? on.unsign : on.sign}
            >
              {proposition.my_roles.signatory ? 'Signatory ✓ — withdraw' : 'Sign as signatory'}
            </button>
            {!hasAmendmentOpen && (
              <button className="btn" onClick={on.newAmendment}>Propose an amendment</button>
            )}
          </>
        )}
        {canAct && own && proposition.status !== 'withdrawn' && (
          <button className="btn btn--ghost btn--small" onClick={on.withdrawProposition}>Withdraw</button>
        )}
      </div>
    </div>
  );
}

function AmendmentPane({ amendment, on, onClose, canAct }) {
  const { approval } = amendment;
  return (
    <div className="infobar__pane">
      <div className="infobar__title">
        <h1>{amendment.name}</h1>
        <Stamp status={amendment.status} />
        <span style={{ flex: 1 }} />
        <button
          className="closer"
          onClick={onClose}
          title="Close the amendment and read the proposition on its own"
          aria-label="Close amendment"
        >
          ✕
        </button>
      </div>
      <div className="infobar__meta">
        Proposed by <CountryLink name={amendment.proposing_team.country_name} />
        {amendment.cosponsors.length > 0 && (
          <>
            {' with '}
            {amendment.cosponsors.map((cosponsor, index) => (
              <React.Fragment key={cosponsor.team_id}>
                {index > 0 && ', '}
                <CountryLink name={cosponsor.country_name} />
              </React.Fragment>
            ))}
          </>
        )}
        {' '}· against version {amendment.base_version.number} · {formatDate(amendment.updated_at)}
      </div>
      {['pending', 'frozen'].includes(amendment.status) && (
        <ApprovalTally approval={approval} myTeamId={amendment.my_team_id} />
      )}

      <div className="infobar__actions">
        {canAct && amendment.can_approve && (
          <button className="btn btn--redline" onClick={on.approve}>Approve this amendment</button>
        )}
        {amendment.my_approval && <span className="stamp stamp--adopted">you approved</span>}
        {canAct && amendment.status === 'draft' && amendment.is_own_team && (
          <>
            <button className="btn" onClick={on.editAmendment}>Edit</button>
            <button className="btn btn--redline" onClick={on.submitAmendment}>Submit to committee</button>
          </>
        )}
        {canAct && amendment.status === 'frozen' && amendment.is_own_team && (
          <button className="btn btn--primary" onClick={on.reapply}>Reapply to the current version</button>
        )}
        {canAct && ['pending', 'frozen', 'draft'].includes(amendment.status) && amendment.is_own_team && (
          <>
            <button className="btn" onClick={on.detach}>Detach as its own proposition</button>
            <button className="btn btn--ghost btn--small" onClick={on.withdrawAmendment}>Withdraw</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- center */

export function Workspace({ user, detail, amendmentDetail, onClearAmendment, on }) {
  const canAct = user.role !== 'secretariat';
  const proposition = detail?.proposition;
  const versions = detail?.versions || [];
  const [viewVersionId, setViewVersionId] = useState(null);
  const [compareFromId, setCompareFromId] = useState(null);
  const [comparing, setComparing] = useState(false);
  // "Clean" reads the proposed text as it would stand, without the markup.
  const [reading, setReading] = useState('redline');

  useEffect(() => {
    setViewVersionId(null);
    setComparing(false);
    setCompareFromId(null);
  }, [proposition?.id]);

  const viewed = useVersion(proposition?.id, viewVersionId);
  const compareFrom = useVersion(proposition?.id, compareFromId);

  if (!proposition) {
    return (
      <div className="workspace">
        <Blank mark="¶" title="Nothing open">
          {canAct
            ? 'Pick a proposition on the left to read it, or start one of your own. Drafts stay inside your delegation until you submit them.'
            : 'Pick a proposition on the left to read it. Delegations’ private drafts stay theirs until they submit them.'}
        </Blank>
      </div>
    );
  }

  const amendment = amendmentDetail?.amendment;
  const baseVersion = amendmentDetail?.base_version;
  const currentContent = proposition.current_version?.markdown_content || '';
  const shownContent = viewed ? viewed.markdown_content : currentContent;
  const shownNumber = viewed ? viewed.number : proposition.current_version?.number;

  const startCompare = () => {
    setComparing(true);
    setCompareFromId(versions.length > 1 ? versions[versions.length - 2].id : versions[0]?.id);
  };

  return (
    <div className="workspace">
      <div className={`infobar${amendment ? ' infobar--split' : ''}`}>
        <PropositionPane
          proposition={proposition}
          on={on}
          hasAmendmentOpen={!!amendment}
          canAct={canAct}
        />
        {amendment && (
          <AmendmentPane
            amendment={{ ...amendment, my_team_id: user.team?.id ?? null }}
            on={on}
            onClose={onClearAmendment}
            canAct={canAct}
          />
        )}
      </div>

      {amendment ? (
        <div className="docs docs--split">
          <div className="docs__col docs__col--reference">
            <Sheet
              marginalia={<>
                <span>Version {baseVersion?.number} — the text this amendment answers</span>
              </>}
            >
              <MarkdownBody content={baseVersion?.markdown_content} />
            </Sheet>
          </div>
          <div className="docs__col">
            {amendment.is_stale && (
              <div className="frozen-banner">
                <strong>This amendment is frozen.</strong>
                The proposition has moved on since version {amendment.base_version.number} — it is
                now at version {proposition.current_version?.number}. Nothing is merged
                automatically: {amendment.is_own_team
                  ? 'reapply it to the current version to put it back in front of the sponsors.'
                  : 'its authors must reapply it to the current version.'}
              </div>
            )}
            <Sheet
              marginalia={<>
                <ReadingToggle value={reading} onChange={setReading} />
                <span style={{ flex: 1 }} />
                <DiffSummary from={baseVersion?.markdown_content} to={amendment.markdown_content} />
              </>}
            >
              {reading === 'redline'
                ? <DiffBody from={baseVersion?.markdown_content} to={amendment.markdown_content} />
                : <MarkdownBody content={amendment.markdown_content} />}
            </Sheet>
          </div>
        </div>
      ) : comparing ? (
        <div className="docs docs--split">
          <div className="docs__col docs__col--reference">
            <Sheet
              marginalia={<>
                <VersionPicker
                  versions={versions}
                  value={compareFromId}
                  onChange={setCompareFromId}
                  allowCurrent={false}
                  label="Compare from"
                />
              </>}
            >
              <MarkdownBody content={compareFrom?.markdown_content} />
            </Sheet>
          </div>
          <div className="docs__col">
            <Sheet
              marginalia={<>
                <VersionPicker versions={versions} value={viewVersionId} onChange={setViewVersionId} label="to" />
                <ReadingToggle value={reading} onChange={setReading} />
                <span style={{ flex: 1 }} />
                <DiffSummary from={compareFrom?.markdown_content} to={shownContent} />
                <button className="btn btn--ghost btn--small" onClick={() => setComparing(false)}>
                  Stop comparing
                </button>
              </>}
            >
              {reading === 'redline'
                ? <DiffBody from={compareFrom?.markdown_content} to={shownContent} />
                : <MarkdownBody content={shownContent} />}
            </Sheet>
          </div>
        </div>
      ) : (
        <div className="docs">
          <div className="docs__col">
            <Sheet
              marginalia={<>
                <VersionPicker versions={versions} value={viewVersionId} onChange={setViewVersionId} />
                <span>{viewed ? viewed.note : proposition.current_version?.note}</span>
                <span style={{ flex: 1 }} />
                {versions.length > 1 && (
                  <button className="btn btn--ghost btn--small" onClick={startCompare}>Compare versions</button>
                )}
              </>}
            >
              {viewed && (
                <div className="notice" style={{ marginBottom: 16 }}>
                  You are reading version {shownNumber} of {versions.length}, from{' '}
                  {formatDate(viewed.created_at)}.{' '}
                  <button className="btn btn--ghost btn--small" onClick={() => setViewVersionId(null)}>
                    Back to the current text
                  </button>
                </div>
              )}
              <MarkdownBody content={shownContent} />
            </Sheet>
          </div>
        </div>
      )}
    </div>
  );
}
