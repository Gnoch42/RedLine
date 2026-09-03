import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Markdown-source diff, the way a redlined draft reads: line-level structure,
 * word-level detail wherever a block was rewritten rather than added or cut
 * outright.
 *
 * Returns flat segments of { type: 'same' | 'ins' | 'del', value }.
 */
export function buildDiff(from, to) {
  const parts = diffLines(from || '', to || '');
  const segments = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];

    // A removal immediately followed by an addition is a rewrite: show which
    // words actually changed instead of striking the whole block.
    if (part.removed && next?.added) {
      for (const word of diffWordsWithSpace(part.value, next.value)) {
        segments.push({
          type: word.added ? 'ins' : word.removed ? 'del' : 'same',
          value: word.value,
        });
      }
      i++;
      continue;
    }
    segments.push({
      type: part.added ? 'ins' : part.removed ? 'del' : 'same',
      value: part.value,
    });
  }

  // Merge neighbours of the same type so the DOM stays small and selectable.
  const merged = [];
  for (const segment of segments) {
    if (!segment.value) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === segment.type) last.value += segment.value;
    else merged.push({ ...segment });
  }
  return merged;
}

const countWords = (text) => (text.match(/\S+/g) || []).length;

export function diffStats(segments) {
  let inserted = 0;
  let deleted = 0;
  for (const segment of segments) {
    if (segment.type === 'ins') inserted += countWords(segment.value);
    if (segment.type === 'del') deleted += countWords(segment.value);
  }
  return { inserted, deleted, unchanged: inserted === 0 && deleted === 0 };
}
