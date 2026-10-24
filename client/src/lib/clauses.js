/**
 * The text operations behind the editor's toolbar, as plain functions on a
 * string and a selection. Keeping them out of the component is what makes them
 * testable — numbering that renumbers the wrong neighbour is easy to write and
 * hard to spot by eye.
 *
 * Each returns the whole new text and where the selection should end up.
 */

export const INDENT = '   '; // Three spaces: where a nested item sits, under "1. "
export const NUMBERED = /^(\s*)(\d+)\.\s+/;

const depthOf = (line) => line.match(/^\s*/)[0].length;

/** The first and last line a selection touches. */
export function lineRange(value, start, end) {
  const lineAt = (index) => value.slice(0, index).split('\n').length - 1;
  return [lineAt(start), lineAt(end)];
}

/**
 * Where numbering at this depth has got to among the lines above, so a clause
 * added under "2." becomes "3." rather than another "1.".
 */
function countAbove(lines, from, indentWidth) {
  for (let i = from - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const depth = depthOf(line);
    // Deeper lines are items nested inside this list; keep looking past them
    // for the previous sibling.
    if (depth > indentWidth) continue;
    // A sibling clause: carry on from its number.
    if (depth === indentWidth && NUMBERED.test(line)) return Number(line.match(NUMBERED)[2]);
    // Anything else at this level or shallower — a paragraph between two runs
    // of clauses, say — ends the list, so the next one starts again at one.
    return 0;
  }
  return 0;
}

/**
 * Renumber every numbered line, each depth counting on its own and restarting
 * whenever the text comes back out to a shallower level. Run over the whole
 * document, so moving one clause cannot leave its old neighbours stale.
 */
export function renumberAll(lines) {
  const counters = new Map();
  return lines.map((line, i) => {
    const match = line.match(NUMBERED);
    if (!match) {
      // An unindented paragraph between lists ends them.
      if (line.trim() && depthOf(line) === 0) counters.clear();
      return line;
    }
    const width = match[1].length;
    if (!counters.has(width)) counters.set(width, countAbove(lines, i, width));
    counters.set(width, counters.get(width) + 1);
    for (const depth of [...counters.keys()]) if (depth > width) counters.delete(depth);
    return line.replace(NUMBERED, `${match[1]}${counters.get(width)}. `);
  });
}

/** Rewrite the touched lines, renumber the document, keep them selected. */
function perLine(value, start, end, fn) {
  const lines = value.split('\n');
  const [first, last] = lineRange(value, start, end);
  for (let i = first; i <= last; i++) lines[i] = fn(lines[i]);

  const next = renumberAll(lines);
  const startOf = (index) => next.slice(0, index).reduce((n, line) => n + line.length + 1, 0);
  return {
    text: next.join('\n'),
    selectionStart: startOf(first),
    selectionEnd: startOf(last) + next[last].length,
  };
}

/** Number the touched lines as clauses, or strip it if it is all there already. */
export function numberClauses(value, start, end) {
  const lines = value.split('\n');
  const [first, last] = lineRange(value, start, end);
  const touched = lines.slice(first, last + 1);

  if (touched.every((line) => NUMBERED.test(line) || !line.trim())) {
    return perLine(value, start, end, (line) => line.replace(NUMBERED, '$1'));
  }
  const indent = touched.find((line) => line.trim())?.match(/^\s*/)[0] ?? '';
  return perLine(value, start, end, (line) => (line.trim()
    ? `${indent}1. ${line.replace(NUMBERED, '').trimStart()}`
    : line));
}

/**
 * One step in or out. A clause indented under "1." becomes "a." in the
 * exported paper, and starts counting again from the top.
 */
export function changeDepth(value, start, end, direction) {
  return perLine(value, start, end, (line) => {
    if (!line.trim()) return line;
    if (direction > 0) return INDENT + line;
    return line.startsWith(INDENT) ? line.slice(INDENT.length) : line.replace(/^\s+/, '');
  });
}

/** Wrap the selection in a marker, or peel it off if it is already there. */
export function wrapSelection(value, start, end, marker) {
  const selected = value.slice(start, end);

  if (!selected) {
    // Nothing selected: leave the markers with the cursor between them.
    const at = start + marker.length;
    return {
      text: value.slice(0, start) + marker + marker + value.slice(end),
      selectionStart: at,
      selectionEnd: at,
    };
  }

  const already = selected.startsWith(marker) && selected.endsWith(marker)
    && selected.length > marker.length * 2;
  const inner = already
    ? selected.slice(marker.length, -marker.length)
    : `${marker}${selected}${marker}`;
  return {
    text: value.slice(0, start) + inner + value.slice(end),
    selectionStart: start,
    selectionEnd: start + inner.length,
  };
}
