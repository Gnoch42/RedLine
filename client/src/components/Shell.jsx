import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { usePoll } from '../lib/usePoll.js';
import { Wordmark, Toast } from './bits.jsx';
import { CommitteeModal } from './CommitteeModal.jsx';
import { ProjectExplorer } from './ProjectExplorer.jsx';
import { AmendmentExplorer } from './AmendmentExplorer.jsx';
import { Workspace } from './Workspace.jsx';
import { PropositionEditor, AmendmentEditor, ProjectForm } from './editors.jsx';
import { CountryProvider } from './CountryCard.jsx';
import { AdminModal } from './AdminModal.jsx';
import { SignatureModal } from './SignatureModal.jsx';

/**
 * Move between the committees this delegate sits on, or go and join another.
 * The secretariat holds no seats, so for them it is a list of every committee.
 */
function CommitteeSwitcher({ user, onSwitch, onAddSeat }) {
  const staff = user.role === 'secretariat';
  const [all, setAll] = useState([]);

  useEffect(() => {
    if (!staff) return;
    api('/committees').then(({ committees }) => setAll(committees)).catch(() => setAll([]));
  }, [staff, user.committee.id]);

  // Everything is addressed by committee: the server seats you where you have a
  // seat and otherwise lets you look in, so a room being watched belongs on the
  // list beside the ones being worked.
  const options = staff
    ? all.map((c) => [c.id, c.name])
    : (user.seats || []).map((seat) => [
        seat.committee_id,
        `${seat.committee_name} · ${seat.country_name}${seat.is_primary ? ' ★' : ''}`,
      ]);
  if (!staff && !options.some(([id]) => id === user.committee.id)) {
    options.unshift([user.committee.id, `${user.committee.name} · looking in`]);
  }

  return (
    <label className="switcher">
      <span className="label">Committee</span>
      <select
        value={user.committee.id}
        onChange={(event) => {
          if (event.target.value === 'add') onAddSeat();
          else onSwitch(Number(event.target.value));
        }}
      >
        {options.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
        {!staff && <option value="add">+ Another committee…</option>}
      </select>
    </label>
  );
}

export function Shell({ user, onSignOut, onUserChange, onAddSeat }) {
  const committeeId = user.committee.id;

  const [selectedPropositionId, setSelectedPropositionId] = useState(null);
  const [selectedAmendmentId, setSelectedAmendmentId] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [panel, setPanel] = useState('left'); // narrow screens only

  const say = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const board = usePoll(() => api(`/committees/${committeeId}/board`), { deps: [committeeId] });
  const detail = usePoll(() => api(`/propositions/${selectedPropositionId}`), {
    deps: [selectedPropositionId], enabled: !!selectedPropositionId,
  });
  const amendmentList = usePoll(() => api(`/propositions/${selectedPropositionId}/amendments`), {
    deps: [selectedPropositionId], enabled: !!selectedPropositionId,
  });
  const amendmentDetail = usePoll(() => api(`/amendments/${selectedAmendmentId}`), {
    deps: [selectedAmendmentId], enabled: !!selectedAmendmentId,
  });

  const refreshAll = useCallback(() => {
    board.refresh();
    if (selectedPropositionId) { detail.refresh(); amendmentList.refresh(); }
    if (selectedAmendmentId) amendmentDetail.refresh();
  }, [board, detail, amendmentList, amendmentDetail, selectedPropositionId, selectedAmendmentId]);

  const proposition = detail.data?.proposition;
  const amendments = amendmentList.data?.amendments;
  const amendment = amendmentDetail.data?.amendment;

  /** Run an action, surface its outcome, then re-sync every panel. */
  const act = useCallback(async (fn, successMessage) => {
    try {
      const result = await fn();
      refreshAll();
      if (successMessage) say(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      return result;
    } catch (err) {
      say(err.message, 'error');
      throw err;
    }
  }, [refreshAll, say]);

  // On a narrow screen only one panel shows at a time, so opening a document
  // should bring the document forward.
  const openProposition = (id) => {
    setSelectedPropositionId(id);
    setSelectedAmendmentId(null);
    setPanel('center');
  };

  const openAmendment = (id) => {
    setSelectedAmendmentId(id);
    setPanel('center');
  };

  const switchCommittee = async (id) => {
    try {
      const { user: next } = await api('/auth/switch', {
        method: 'POST', body: { committee_id: id },
      });
      setSelectedPropositionId(null);
      setSelectedAmendmentId(null);
      setPanel('left');
      onUserChange(next);
    } catch (err) {
      say(err.message, 'error');
    }
  };

  /** Stand up from this delegation for good. */
  const leaveSeat = async () => {
    if (!window.confirm(
      `Give up ${user.team.country_name}'s seat on ${user.committee.name}?`
    )) return;
    try {
      const { outcome, user: next } = await api(`/teams/${user.team.id}/seat`, { method: 'DELETE' });
      onUserChange(next);
      say(outcome === 'released'
        ? `Seat given up. ${user.team.country_name} is free for another delegation to register.`
        : outcome === 'left_standing'
          ? `You have left. The ${user.team.country_name} delegation stays on the record — it has taken positions that outlast you.`
          : 'You have left the delegation.');
    } catch (err) {
      say(err.message, 'error');
    }
  };

  const reloadUser = useCallback(async () => {
    const { user: next } = await api('/auth/me');
    onUserChange(next);
    board.refresh();
    if (selectedPropositionId) detail.refresh();
  }, [onUserChange, board, detail, selectedPropositionId]);

  const on = useMemo(() => ({
    editProposition: () => setModal({ type: 'edit-proposition' }),
    submitProposition: () => act(
      () => api(`/propositions/${proposition.id}/submit`, { method: 'PATCH' }),
      'Submitted — the committee can see it now.'
    ),
    withdrawProposition: () => {
      if (!window.confirm('Withdraw this proposition from the committee?')) return;
      act(() => api(`/propositions/${proposition.id}/withdraw`, { method: 'POST' }), 'Withdrawn.');
    },
    askToSponsor: () => act(
      () => api(`/propositions/${proposition.id}/sponsor-request`, { method: 'POST' }),
      'Asked. One of the sponsors has to admit you.'
    ),
    cancelSponsorRequest: () => act(
      () => api(`/propositions/${proposition.id}/sponsor-request`, { method: 'DELETE' }),
      'Request withdrawn.'
    ),
    acceptSponsor: (requestId) => act(
      () => api(`/propositions/${proposition.id}/sponsor-requests/${requestId}/accept`, { method: 'POST' }),
      (res) => `Admitted. ${res.proposition.sponsors.length} delegations now carry this text.`
    ),
    declineSponsor: (requestId) => act(
      () => api(`/propositions/${proposition.id}/sponsor-requests/${requestId}/decline`, { method: 'POST' }),
      'Request declined.'
    ),
    standDown: () => {
      if (!window.confirm('Stop sponsoring this proposition? You will no longer be asked to approve amendments to it.')) return;
      act(
        () => api(`/propositions/${proposition.id}/support/sponsor`, { method: 'DELETE' }),
        'You no longer sponsor this proposition.'
      );
    },
    declareReady: () => act(
      () => api(`/propositions/${proposition.id}/ready`, { method: 'POST' }),
      (res) => res.proposition.status === 'active'
        ? `Noted. ${res.proposition.readiness.ready_count} of ${res.proposition.readiness.sponsor_count} sponsors call the text settled.`
        : res.proposition.status === 'ready'
          ? 'The text is closed and already has the support to be presented.'
          : 'The text is closed. Signatures are open.'
    ),
    unready: () => act(
      () => api(`/propositions/${proposition.id}/ready`, { method: 'DELETE' }),
      'Taken back — the text is open to amendment again.'
    ),
    sign: () => setModal({ type: 'sign' }),
    unsign: () => act(
      () => api(`/propositions/${proposition.id}/support/signatory`, { method: 'DELETE' }),
      'Signature withdrawn.'
    ),

    newAmendment: () => setModal({ type: 'new-amendment' }),
    editAmendment: () => setModal({ type: 'edit-amendment' }),
    submitAmendment: () => act(
      () => api(`/amendments/${amendment.id}/submit`, { method: 'PATCH' }),
      (res) => res.amendment.status === 'frozen'
        ? 'Submitted, but the proposition has already moved on — the amendment is frozen. Reapply it to the current version.'
        : 'Submitted — the sponsors can approve it now.'
    ),
    approve: () => act(
      () => api(`/amendments/${amendment.id}/approve`, { method: 'POST' }),
      (res) => res.adopted
        ? `Adopted. The proposition is now at version ${res.proposition.current_version.number}.`
        : `Approved. ${res.amendment.approval.approved_count} of ${res.amendment.approval.required_count} sponsors so far.`
    ),
    detach: async () => {
      if (!window.confirm('Take this amendment out and file it as a proposition of its own?')) return;
      const result = await act(
        () => api(`/amendments/${amendment.id}/detach`, { method: 'POST' }),
        'Detached — it is now a proposition in its own right.'
      );
      openProposition(result.proposition.id);
    },
    reapply: () => setModal({ type: 'reapply' }),
    withdrawAmendment: () => {
      if (!window.confirm('Withdraw this amendment?')) return;
      act(() => api(`/amendments/${amendment.id}/withdraw`, { method: 'POST' }), 'Amendment withdrawn.');
    },
  }), [act, proposition, amendment]);

  const currentVersion = proposition?.current_version;
  const canAct = user.can_draft;

  return (
    <CountryProvider>
    <div className="app">
      <header className="masthead">
        <Wordmark />
        <CommitteeSwitcher user={user} onSwitch={switchCommittee} onAddSeat={onAddSeat} />
        <div className="panel-toggles">
          <button className="btn btn--small" aria-pressed={panel === 'left'} onClick={() => setPanel('left')}>
            Propositions
          </button>
          <button className="btn btn--small" aria-pressed={panel === 'center'} onClick={() => setPanel('center')}>
            Document
          </button>
          <button className="btn btn--small" aria-pressed={panel === 'right'} onClick={() => setPanel('right')}>
            Amendments
          </button>
        </div>
        <span className="masthead__spacer" />
        <div className="masthead__identity">
          <div className="country">
            {user.team
              ? user.team.country_name
              : user.role === 'secretariat' ? 'Secretariat' : 'Observing'}
          </div>
          <div className="delegate">{user.delegate_name}</div>
        </div>
        {user.is_admin && (
          <button className="btn btn--small" onClick={() => setModal({ type: 'admin' })}>
            Admin
          </button>
        )}
        <button className="btn btn--small" onClick={() => setModal({ type: 'committee' })}>Committee</button>
        <button className="btn btn--small" onClick={onSignOut}>Sign out</button>
      </header>

      <div className={`workbench show-${panel}`}>
        <ProjectExplorer
          board={board.data}
          committee={user.committee}
          selectedId={selectedPropositionId}
          onSelect={openProposition}
          onNewProposition={(projectId) => setModal({ type: 'new-proposition', projectId })}
          onNewProject={() => setModal({ type: 'new-project' })}
          onOpenSettings={() => setModal({ type: 'committee', tab: 'agenda' })}
          canAct={canAct}
        />

        <Workspace
          user={user}
          detail={detail.data}
          amendmentDetail={amendmentDetail.data}
          onClearAmendment={() => setSelectedAmendmentId(null)}
          on={on}
        />

        <AmendmentExplorer
          proposition={proposition}
          amendments={amendments}
          selectedId={selectedAmendmentId}
          onSelect={openAmendment}
          onNew={() => setModal({ type: 'new-amendment' })}
          canPropose={canAct && proposition?.status === 'active'}
        />
      </div>

      <Toast toast={toast} />

      {modal?.type === 'sign' && proposition && (
        <SignatureModal
          proposition={proposition}
          country={user.team?.country_name}
          onClose={() => setModal(null)}
          onSign={async () => {
            await act(
              () => api(`/propositions/${proposition.id}/sign`, {
                method: 'POST', body: { undertaking: true },
              }),
              (res) => res.proposition.status === 'ready'
                ? 'Signed. The proposition now has the support to be presented.'
                : 'Signed. Your delegation is on the record.'
            );
            setModal(null);
          }}
        />
      )}

      {modal?.type === 'admin' && (
        <AdminModal user={user} onClose={() => setModal(null)} />
      )}

      {modal?.type === 'committee' && (
        <CommitteeModal
          user={user}
          initialTab={modal.tab}
          onClose={() => setModal(null)}
          onChanged={reloadUser}
          onLeave={leaveSeat}
        />
      )}

      {modal?.type === 'new-project' && (
        <ProjectForm
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await act(() => api(`/committees/${committeeId}/projects`, { method: 'POST', body: { name } }),
              'Agenda item added.');
            setModal(null);
          }}
        />
      )}

      {modal?.type === 'new-proposition' && (
        <PropositionEditor
          title="New proposition"
          subtitle="Delegation draft"
          submitLabel="Save draft"
          initial={{}}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            const result = await act(
              () => api(`/projects/${modal.projectId}/propositions`, {
                method: 'POST',
                body: { name: values.name, content: values.content },
              }),
              'Draft saved. Only your delegation can see it until you submit it.'
            );
            setModal(null);
            openProposition(result.proposition.id);
          }}
        />
      )}

      {modal?.type === 'edit-proposition' && proposition && (
        <PropositionEditor
          title="Edit draft"
          subtitle={`#${proposition.id}`}
          submitLabel="Save"
          initial={{ name: proposition.name, content: currentVersion?.markdown_content || '' }}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            await act(async () => {
              await api(`/propositions/${proposition.id}`, {
                method: 'PATCH', body: { name: values.name },
              });
              if (values.content !== (currentVersion?.markdown_content || '')) {
                await api(`/propositions/${proposition.id}/versions`, {
                  method: 'POST', body: { content: values.content, note: 'Draft revision' },
                });
              }
            }, 'Draft saved.');
            setModal(null);
          }}
        />
      )}

      {modal?.type === 'new-amendment' && proposition && (
        <AmendmentEditor
          title="Propose an amendment"
          subtitle={`to #${proposition.id} · version ${currentVersion?.number}`}
          submitLabel="Save draft"
          base={{ number: currentVersion?.number, markdown_content: currentVersion?.markdown_content }}
          initial={{}}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            const result = await act(
              () => api(`/propositions/${proposition.id}/amendments`, { method: 'POST', body: values }),
              'Amendment drafted. Submit it when you are ready for the sponsors to see it.'
            );
            setModal(null);
            openAmendment(result.amendment.id);
          }}
        />
      )}

      {modal?.type === 'edit-amendment' && amendment && (
        <AmendmentEditor
          title="Edit amendment"
          subtitle={`against version ${amendment.base_version.number}`}
          submitLabel="Save"
          base={{
            number: amendmentDetail.data.base_version.number,
            markdown_content: amendmentDetail.data.base_version.markdown_content,
          }}
          initial={{ name: amendment.name, content: amendment.markdown_content }}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            await act(() => api(`/amendments/${amendment.id}`, { method: 'PATCH', body: values }), 'Saved.');
            setModal(null);
          }}
        />
      )}

      {modal?.type === 'reapply' && amendment && proposition && (
        <AmendmentEditor
          title={`Reapply "${amendment.name}"`}
          subtitle={`onto version ${currentVersion?.number}`}
          submitLabel="Reapply and reopen for approval"
          showFields={false}
          base={{ number: currentVersion?.number, markdown_content: currentVersion?.markdown_content }}
          initial={{ name: amendment.name, content: amendment.markdown_content }}
          onClose={() => setModal(null)}
          onSubmit={async (values) => {
            await act(
              () => api(`/amendments/${amendment.id}/reapply`, {
                method: 'POST', body: { content: values.content },
              }),
              'Reapplied to the current version. Previous approvals were cleared.'
            );
            setModal(null);
          }}
        />
      )}
    </div>
    </CountryProvider>
  );
}
