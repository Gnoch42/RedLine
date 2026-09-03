import React, { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.js';
import { buildDiff, diffStats } from '../lib/diff.js';

export function Sheet({ marginalia, children }) {
  return (
    <div className="sheet">
      {marginalia && <div className="sheet__marginalia">{marginalia}</div>}
      {children}
    </div>
  );
}

export function MarkdownBody({ content }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  if (!content?.trim()) {
    return <div className="doc doc__empty">This version is empty — no text has been drafted yet.</div>;
  }
  return <div className="doc" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The redline view: the proposed text with what would be struck and what would
 * be inserted marked in place, over the markdown source.
 */
export function DiffBody({ from, to }) {
  const segments = useMemo(() => buildDiff(from, to), [from, to]);
  return (
    <div className="doc doc--diff">
      {segments.map((segment, index) => {
        if (segment.type === 'ins') return <ins key={index}>{segment.value}</ins>;
        if (segment.type === 'del') return <del key={index}>{segment.value}</del>;
        return <span key={index}>{segment.value}</span>;
      })}
    </div>
  );
}

export function DiffSummary({ from, to }) {
  const stats = useMemo(() => diffStats(buildDiff(from, to)), [from, to]);
  if (stats.unchanged) return <span className="diffsummary"><span className="same">no changes</span></span>;
  return (
    <span className="diffsummary">
      <span className="ins">+{stats.inserted} inserted</span>
      <span className="del">−{stats.deleted} struck</span>
    </span>
  );
}
