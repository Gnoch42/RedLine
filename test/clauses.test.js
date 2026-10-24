import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberClauses, changeDepth, wrapSelection } from '../client/src/lib/clauses.js';

/** Apply an operation to the whole of `text` and return what it becomes. */
const all = (text, op) => op(text, 0, text.length).text;

const CLAUSES = [
  'Calls upon Member States to act',
  'at no less than 100 billion',
  'reviewed every five years',
  'Requests a report',
].join('\n');

test('numbering runs down the lines it is given', () => {
  assert.equal(all(CLAUSES, numberClauses), [
    '1. Calls upon Member States to act',
    '2. at no less than 100 billion',
    '3. reviewed every five years',
    '4. Requests a report',
  ].join('\n'));
});

test('numbering an already numbered run takes it off again', () => {
  const numbered = all(CLAUSES, numberClauses);
  assert.equal(all(numbered, numberClauses), CLAUSES);
});

test('a clause added below continues the count rather than restarting', () => {
  const text = '1. First\n2. Second\nThird';
  const at = text.length - 'Third'.length;
  assert.equal(numberClauses(text, at, text.length).text, '1. First\n2. Second\n3. Third');
});

test('indenting makes a sub-clause, which counts on its own', () => {
  const numbered = all(CLAUSES, numberClauses);
  const lines = numbered.split('\n');
  const from = lines[0].length + 1;
  const to = from + lines[1].length + 1 + lines[2].length;

  // The two middle clauses become a. and b. under the first; the last moves up.
  assert.equal(changeDepth(numbered, from, to, 1).text, [
    '1. Calls upon Member States to act',
    '   1. at no less than 100 billion',
    '   2. reviewed every five years',
    '2. Requests a report',
  ].join('\n'));
});

test('outdenting one clause leaves no stale numbering behind it', () => {
  const nested = [
    '1. Calls upon Member States to act',
    '   1. at no less than 100 billion',
    '   2. reviewed every five years',
    '2. Requests a report',
  ].join('\n');
  const from = nested.split('\n')[0].length + 1;

  // The sub-clause left behind restarts at 1, and the list below renumbers.
  assert.equal(changeDepth(nested, from, from + 2, -1).text, [
    '1. Calls upon Member States to act',
    '2. at no less than 100 billion',
    '   1. reviewed every five years',
    '3. Requests a report',
  ].join('\n'));
});

test('a paragraph between runs of clauses starts the numbering again', () => {
  const text = [
    '1. First',
    '2. Second',
    '',
    'The Committee further,',
    '',
    'Fresh start',
    'And again',
  ].join('\n');
  const from = text.indexOf('Fresh start');

  assert.equal(numberClauses(text, from, text.length).text, [
    '1. First',
    '2. Second',
    '',
    'The Committee further,',
    '',
    '1. Fresh start',
    '2. And again',
  ].join('\n'));
});

test('wrapping keeps the text either side of the selection intact', () => {
  // Chrome's execCommand would eat the space after the selection; this must not.
  const text = 'Calls upon Member States';
  const bolded = wrapSelection(text, 0, 10, '**');
  assert.equal(bolded.text, '**Calls upon** Member States');
  assert.equal(bolded.text.slice(bolded.selectionStart, bolded.selectionEnd), '**Calls upon**');

  // And wrapping the same selection again takes it off.
  assert.equal(wrapSelection(bolded.text, 0, bolded.selectionEnd, '**').text, text);
});

test('wrapping nothing leaves the markers with the cursor between them', () => {
  const { text, selectionStart, selectionEnd } = wrapSelection('ab', 1, 1, '*');
  assert.equal(text, 'a**b');
  assert.equal(selectionStart, 2);
  assert.equal(selectionEnd, 2);
});
