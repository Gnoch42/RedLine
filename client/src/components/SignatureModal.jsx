import React, { useState } from 'react';
import { Modal } from './Modal.jsx';
import { MarkdownBody } from './DocumentSheet.jsx';

/**
 * A signature is a commitment, so it is asked for as one: the delegation reads
 * the text as it stands, undertakes to sign it, and only then can confirm. The
 * paper signing still happens in the room — this is the promise that precedes
 * it (§5.4b).
 */
export function SignatureModal({ proposition, country, onClose, onSign }) {
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const version = proposition.current_version;

  const sign = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSign();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Sign this proposition"
      subtitle={`Version ${version?.number}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="label">Your delegation is committing itself, on the record.</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Not yet</button>
          <button className="btn btn--redline" onClick={sign} disabled={busy || !read}>
            {busy ? 'Signing…' : `Sign as ${country}`}
          </button>
        </>
      }
    >
      {error && <div className="notice" style={{ marginBottom: 12 }}>{error}</div>}

      <p className="label" style={{ display: 'block', marginBottom: 6 }}>
        The text you are signing — {proposition.name}, version {version?.number}
      </p>
      <div className="signature-text">
        <MarkdownBody content={version?.markdown_content} />
      </div>

      <div className="undertaking">
        The delegation of <strong>{country}</strong> undertakes to sign
        “{proposition.name}” <strong>as it stands above</strong>, and to add its name to the
        document presented in committee.
        <br />
        Your signature is recorded against version {version?.number}. If the sponsors reopen
        the text and it changes, your signature stays on record against this version and is
        shown as given for an earlier draft.
      </div>

      <label className="signature-check">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
        <span>
          I have read the text above and my delegation undertakes to sign it as it stands.
        </span>
      </label>
    </Modal>
  );
}
