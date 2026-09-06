import React, { useEffect, useState } from 'react';
import { api, getToken, clearToken } from './api.js';
import { Lobby } from './components/Lobby.jsx';
import { Shell } from './components/Shell.jsx';
import { Blank } from './components/bits.jsx';

const joinCodeFromUrl = () => new URLSearchParams(window.location.search).get('join');

export default function App() {
  const [state, setState] = useState({ loading: true, user: null });
  const [joinCode] = useState(joinCodeFromUrl);
  // The lobby doubles as "where am I sitting today", so a signed-in delegate can
  // reopen it to take a seat on another committee.
  const [seating, setSeating] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setState({ loading: false, user: null });
      return;
    }
    api('/auth/me')
      .then(({ user }) => setState({ loading: false, user }))
      .catch(() => {
        clearToken();
        setState({ loading: false, user: null });
      });
  }, []);

  if (state.loading) {
    return <Blank mark="§" title="Opening the file room">One moment.</Blank>;
  }

  // A committee is what the workbench needs, and a delegation is not: the
  // secretariat holds none, and a delegate may be looking in on a room their
  // country has no seat on. The server decides who may be in which room.
  if (!state.user?.committee || seating) {
    return (
      <Lobby
        initialUser={state.user}
        prefillJoinCode={joinCode}
        startSeating={seating}
        onCancel={seating ? () => setSeating(false) : undefined}
        onEnter={(user) => {
          window.history.replaceState({}, '', window.location.pathname);
          setSeating(false);
          setState({ loading: false, user });
        }}
      />
    );
  }

  return (
    <Shell
      user={state.user}
      onUserChange={(user) => setState({ loading: false, user })}
      onAddSeat={() => setSeating(true)}
      onSignOut={async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* session already gone */ }
        clearToken();
        setState({ loading: false, user: null });
      }}
    />
  );
}
