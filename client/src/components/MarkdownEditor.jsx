import React, { useCallback, useRef } from 'react';
import { numberClauses, changeDepth, wrapSelection } from '../lib/clauses.js';

/*
 * A textarea with the few marks a resolution actually needs: bold for the
 * operative verb, italic for the preambular lead-in, and numbering that nests
 * the way the NMUN template does.
 *
 * The text stays Markdown — it is what versions are diffed on and what the
 * exporter reads — so the buttons only ever edit the text in front of you.
 * Indenting a numbered clause makes it a sub-clause: 1. becomes a., and a.
 * becomes i., in the exported paper. The operations themselves are in
 * lib/clauses.js; this only applies them to the element.
 */

/**
 * Put `text` in the textarea, exactly.
 *
 * execCommand is the only edit that lands on the browser's own undo stack, so
 * it is tried first — but Chrome's "smart insert" quietly adjusts whitespace
 * around a word-shaped selection, which would turn "**Calls upon** Member"
 * into "**Calls upon**Member". So the result is checked, and put right with
 * setRangeText when it is not what was asked for.
 */
function put(textarea, { text, selectionStart, selectionEnd }) {
  textarea.focus();
  textarea.setSelectionRange(0, textarea.value.length);

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }
  if (!inserted || textarea.value !== text) {
    textarea.setRangeText(text, 0, textarea.value.length, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(selectionStart, selectionEnd);
}

const BUTTONS = [
  { label: 'B', title: 'Bold — for the operative verb', style: { fontWeight: 700 },
    run: (v, a, b) => wrapSelection(v, a, b, '**') },
  { label: 'I', title: 'Italic — for the preambular lead-in', style: { fontStyle: 'italic' },
    run: (v, a, b) => wrapSelection(v, a, b, '*') },
  { label: '1.', title: 'Number these lines as clauses', run: numberClauses },
  { label: '⇥', title: 'Indent one level: 1. becomes a., a. becomes i.',
    run: (v, a, b) => changeDepth(v, a, b, 1) },
  { label: '⇤', title: 'Outdent one level', run: (v, a, b) => changeDepth(v, a, b, -1) },
];

export function MarkdownEditor({ value, onChange, placeholder, style, className }) {
  const ref = useRef(null);

  const apply = useCallback((run) => {
    const textarea = ref.current;
    if (!textarea) return;
    put(textarea, run(textarea.value, textarea.selectionStart, textarea.selectionEnd));
  }, []);

  return (
    <div className={className}>
      <div className="mdbar">
        {BUTTONS.map((button) => (
          <button
            key={button.label}
            type="button"
            title={button.title}
            aria-label={button.title}
            style={button.style}
            onMouseDown={(event) => event.preventDefault()} // keep the caret where it is
            onClick={() => apply(button.run)}
          >
            {button.label}
          </button>
        ))}
        <span className="mdbar__hint">1. → a. → i. by indent</span>
      </div>

      <textarea
        ref={ref}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={style}
        onKeyDown={(event) => {
          if (!(event.metaKey || event.ctrlKey)) return;
          const key = event.key.toLowerCase();
          if (key === 'b') {
            event.preventDefault();
            apply((v, a, b) => wrapSelection(v, a, b, '**'));
          }
          if (key === 'i') {
            event.preventDefault();
            apply((v, a, b) => wrapSelection(v, a, b, '*'));
          }
        }}
      />
    </div>
  );
}
