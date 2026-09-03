import React, { useState } from 'react';
import { Modal } from './Modal.jsx';
import { MarkdownBody, DiffBody, DiffSummary } from './DocumentSheet.jsx';

function useForm(initial) {
  const [values, setValues] = useState(initial);
  const set = (key) => (event) => setValues((v) => ({ ...v, [key]: event.target.value }));
  return [values, set, setValues];
}

function Busy({ error }) {
  if (!error) return null;
  return <div className="notice" style={{ marginBottom: 12 }}>{error}</div>;
}

/** Write or revise a proposition's own text. */
export function PropositionEditor({ title, subtitle, initial, submitLabel, onSubmit, onClose }) {
  const [values, set] = useForm({
    name: initial?.name || '',
    content: initial?.content || '',
  });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="label">Drafts stay inside your delegation until you submit them.</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !values.name.trim()}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <Busy error={error} />
      <label className="field">
        <span className="label">Title</span>
        <input value={values.name} onChange={set('name')}
               placeholder="Resolution on climate finance replenishment" autoFocus />
        <span className="hint">Make it say what the text does — it is all the committee sees in the list.</span>
      </label>

      <div className="field" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
          <span className="label">Text (Markdown)</span>
          <span style={{ flex: 1 }} />
          <div className="segbar">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
          </div>
        </div>
        {preview ? (
          <div className="editor-preview"><MarkdownBody content={values.content} /></div>
        ) : (
          <textarea
            value={values.content}
            onChange={set('content')}
            style={{ minHeight: 320 }}
            placeholder={'The General Assembly,\n\nRecalling …\n\n1. Calls upon Member States to …'}
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * Amendments are written as the full proposed text; the redline beside the
 * editor is what the sponsors will actually be asked to approve.
 */
export function AmendmentEditor({ title, subtitle, base, initial, submitLabel, onSubmit, onClose, showFields = true }) {
  const [values, set] = useForm({
    name: initial?.name || '',
    content: initial?.content ?? base?.markdown_content ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      wide
      footer={
        <>
          <DiffSummary from={base?.markdown_content} to={values.content} />
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !values.name.trim()}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <Busy error={error} />
      {showFields && (
        <label className="field">
          <span className="label">Amendment title</span>
          <input value={values.name} onChange={set('name')}
                 placeholder="Add a reporting deadline to operative clause 2" autoFocus />
          <span className="hint">Say what it changes — sponsors decide from this and the redline.</span>
        </label>
      )}

      <div className="editor-split">
        <div>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>
            Your text — edit the draft in place
          </span>
          <textarea value={values.content} onChange={set('content')} />
        </div>
        <div>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>
            Redline against version {base?.number}
          </span>
          <div className="editor-preview">
            <DiffBody from={base?.markdown_content} to={values.content} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function ProjectForm({ onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New agenda item"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !name.trim()}>Add</button>
        </>
      }
    >
      <Busy error={error} />
      <label className="field" style={{ marginBottom: 0 }}>
        <span className="label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Climate finance" autoFocus />
      </label>
    </Modal>
  );
}
