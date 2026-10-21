import {
  AlignmentType, BorderStyle, Document, LevelFormat, Packer, Paragraph, TextRun,
} from 'docx';
import { marked } from 'marked';
import { config } from './config.js';

/*
 * The NMUN working paper template, filled in.
 *
 * A proposition is written in Markdown; a working paper has a shape. This
 * turns one into the other: the header block, then preambular clauses as
 * paragraphs and operative clauses as a 1. / a. / i. numbered list, with the
 * emphasis delegates wrote preserved.
 */

const NUMBERING = 'nmun-operative';

/** Markdown inline tokens become runs, so bold and italic survive the trip. */
function runs(tokens, inherited = {}) {
  const out = [];
  for (const token of tokens || []) {
    switch (token.type) {
      case 'strong':
        out.push(...runs(token.tokens, { ...inherited, bold: true }));
        break;
      case 'em':
        out.push(...runs(token.tokens, { ...inherited, italics: true }));
        break;
      case 'codespan':
        out.push(new TextRun({ ...inherited, text: token.text, font: 'Courier New' }));
        break;
      case 'br':
        out.push(new TextRun({ ...inherited, break: 1 }));
        break;
      case 'link':
        out.push(...runs(token.tokens, inherited));
        break;
      case 'del':
        out.push(...runs(token.tokens, { ...inherited, strike: true }));
        break;
      default:
        if (token.text !== undefined) out.push(new TextRun({ ...inherited, text: token.text }));
    }
  }
  return out.length ? out : [new TextRun('')];
}

const BODY = { font: 'Times New Roman', size: 24 }; // 12pt

function paragraph(children, extra = {}) {
  return new Paragraph({ children, spacing: { after: 200 }, ...extra });
}

/** One list item, and any list nested inside it, at the given depth. */
function listItems(token, depth, out) {
  for (const item of token.items) {
    const inline = [];
    const nested = [];
    for (const child of item.tokens || []) {
      if (child.type === 'list') nested.push(child);
      else if (child.tokens) inline.push(...child.tokens);
      else if (child.text !== undefined) inline.push({ type: 'text', text: child.text });
    }
    out.push(new Paragraph({
      children: runs(inline, BODY),
      numbering: { reference: NUMBERING, level: Math.min(depth, 2) },
      spacing: { after: 120 },
    }));
    // Three levels is all the template shows, and all a resolution needs.
    for (const child of nested) listItems(child, depth + 1, out);
  }
}

function body(markdown) {
  const out = [];
  for (const token of marked.lexer(markdown || '')) {
    switch (token.type) {
      case 'heading':
        out.push(paragraph(runs(token.tokens, { ...BODY, bold: true })));
        break;
      case 'list':
        listItems(token, 0, out);
        break;
      case 'blockquote':
        out.push(paragraph(runs(token.tokens?.[0]?.tokens, { ...BODY, italics: true }),
          { indent: { left: 720 } }));
        break;
      case 'hr':
        out.push(rule());
        break;
      case 'space':
        break;
      default:
        if (token.tokens || token.text) {
          out.push(paragraph(runs(token.tokens || [{ type: 'text', text: token.text }], BODY)));
        }
    }
  }
  return out;
}

const rule = () => new Paragraph({
  children: [],
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
  spacing: { after: 240 },
});

function headerLine(label, value) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ ...BODY, bold: true, text: `${label} ` }),
      new TextRun({ ...BODY, text: value }),
    ],
  });
}

/** Alphabetical, as the template asks, and by the rules of the user's locale. */
const alphabetical = (teams) => teams
  .map((t) => t.country_name)
  .sort((a, b) => a.localeCompare(b, 'en'))
  .join(', ');

/**
 * Build the working paper. `proposition` is the serialized shape, with its
 * current version's content included.
 */
export async function nmunWorkingPaper({ proposition, committeeName, topic }) {
  const children = [];

  children.push(new Paragraph({
    spacing: { after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ ...BODY, bold: true, size: 28, text: 'Working Paper' })],
  }));

  if (config.export.includeAffirmation) {
    children.push(paragraph([new TextRun({
      ...BODY,
      italics: true,
      text: 'In submitting this document to the Dais, the authors affirm that they did not write '
        + 'any of the text of the working paper before arriving at the conference or reproduce it '
        + 'directly from other sources without proper reference. All working papers should be '
        + 'drafted in collaboration with other members of your committee.',
    })]));
  }

  if (config.export.includeCodeLine) children.push(headerLine('Code:', '[Leave blank for Dais]'));
  children.push(headerLine('Committee:', committeeName));
  children.push(headerLine('Topic:', topic || '—'));
  children.push(headerLine('Sponsors:', alphabetical(proposition.sponsors) || '—'));
  children.push(headerLine('Signatories:', alphabetical(proposition.signatories) || '—'));
  children.push(rule());

  children.push(paragraph([new TextRun({
    ...BODY,
    text: (config.export.openingLine || 'The {committee},').replace('{committee}', committeeName),
  })]));

  children.push(...body(proposition.current_version?.markdown_content));

  const document = new Document({
    creator: 'Redline',
    title: proposition.name,
    description: `Working paper — ${committeeName}`,
    numbering: {
      config: [{
        reference: NUMBERING,
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.END,
            style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
        ],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children,
    }],
  });

  return Packer.toBuffer(document);
}

/** A filename that survives every operating system people will open it on. */
export function paperFilename({ committeeName, topic, name }) {
  const clean = (text) => String(text || '')
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${[clean(committeeName), clean(topic), clean(name)].filter(Boolean).join(' - ')}.docx`;
}
