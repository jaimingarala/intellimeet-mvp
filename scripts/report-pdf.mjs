#!/usr/bin/env node
/**
 * Render the project report from Markdown into a real A4 PDF, with no
 * dependencies at all.
 *
 * Why this exists: the brief requires the report as a PDF (A4, 8-15 pages), and
 * every path to one needs something installed. Pandoc has no PDF engine here; a
 * LaTeX or headless-browser toolchain is a large, fragile addition to a
 * repository whose rule is that a judge can clone it and run it. A PDF is not
 * actually complicated — page objects, a font resource, a content stream, and an
 * xref table — and Node already ships the one hard part (zlib, for Flate
 * compression). So the report is written once in Markdown, which GitHub renders
 * too, and this turns it into the deliverable.
 *
 * It is a deliberately small Markdown subset, not a CommonMark implementation:
 * headings, paragraphs, lists, blockquotes, fenced code (where the ASCII
 * architecture diagram lives), pipe tables, rules, and inline bold / italic /
 * code / links. Anything outside the subset renders as text rather than
 * disappearing, so a source typo is visible in the output instead of silent.
 *
 * Two invariants are checked rather than hoped for, because both would otherwise
 * be invisible until someone opened the file: no layout line may exceed the text
 * box (or it silently runs off the page), and every character must map to a
 * glyph in the standard fonts (or it silently becomes a blank). Both are
 * reported in `stats`, and the test suite asserts them for the report.
 *
 * Usage: node scripts/report-pdf.mjs [input.md] [output.pdf]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ metrics */

/**
 * Adobe's AFM advance widths, per 1000 units of em, for the printable ASCII
 * range 32-126. The standard-14 fonts are never embedded, so the viewer supplies
 * the glyphs and these numbers are what make a line's width predictable — which
 * is the whole basis for wrapping. A wrong entry would show up as a wrapped line
 * that is slightly short or slightly long, never as a broken file.
 */
const HELVETICA = `
  278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015
  667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611
  278 278 278 469 556 333
  556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500
  334 260 334 584
`;
const HELVETICA_BOLD = `
  278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975
  722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611
  333 278 333 584 556 333
  556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500
  389 280 389 584
`;

/** 95 values for codes 32-126, in order; a mismatch is a table typo, so assert it. */
function widthTable(text) {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 95) throw new Error(`width table has ${values.length} entries, want 95`);
  const table = new Map();
  for (let i = 0; i < values.length; i += 1) table.set(32 + i, values[i]);
  return table;
}

const COURIER = new Map(Array.from({ length: 95 }, (_, i) => [32 + i, 600]));

const FONTS = {
  helv: { pdf: 'F1', label: 'Helvetica', widths: widthTable(HELVETICA), mono: false },
  helvB: { pdf: 'F2', label: 'Helvetica-Bold', widths: widthTable(HELVETICA_BOLD), mono: false },
  helvO: { pdf: 'F5', label: 'Helvetica-Oblique', widths: widthTable(HELVETICA), mono: false },
  cour: { pdf: 'F3', label: 'Courier', widths: COURIER, mono: true },
  courB: { pdf: 'F4', label: 'Courier-Bold', widths: COURIER, mono: true },
};

/**
 * The one fallback width used for anything outside the measured range. It is a
 * fallback, not an estimate to rely on: `unmeasuredIn` reports every character
 * that lands on it, and the tests fail if the report contains one. Getting this
 * wrong is not cosmetic — a glyph measured too narrow pulls every following
 * character left, so words collide on the page.
 */
const DEFAULT_WIDTH = 556;

/**
 * The winAnsi-frequency typographic characters (0x80-0x9f and the Latin-1
 * punctuation), whose widths are nothing like the ASCII default: an em dash is a
 * full em, and measuring it as 0.556 pushed the next word into it. Codes absent
 * from these maps are reported by `unmeasuredIn` rather than guessed at.
 */
const EXTRAS = {
  helv: {
    0x80: 556,
    0x82: 222,
    0x83: 556,
    0x84: 333,
    0x85: 1000,
    0x86: 556,
    0x87: 556,
    0x88: 333,
    0x89: 1000,
    0x8a: 667,
    0x8b: 333,
    0x8c: 1000,
    0x8e: 611,
    0x91: 333,
    0x92: 222,
    0x93: 333,
    0x94: 333,
    0x95: 350,
    0x96: 556,
    0x97: 1000,
    0x98: 333,
    0x99: 1000,
    0x9a: 500,
    0x9b: 333,
    0x9c: 944,
    0x9e: 500,
    0x9f: 667,
    0xa0: 278,
    0xa1: 333,
    0xa9: 737,
    0xab: 556,
    0xb7: 278,
    0xbb: 556,
    0xbf: 611,
  },
  helvB: {
    0x80: 556,
    0x82: 278,
    0x83: 556,
    0x84: 500,
    0x85: 1000,
    0x86: 556,
    0x87: 556,
    0x88: 333,
    0x89: 1000,
    0x8a: 667,
    0x8b: 333,
    0x8c: 1000,
    0x8e: 611,
    0x91: 333,
    0x92: 278,
    0x93: 500,
    0x94: 500,
    0x95: 350,
    0x96: 556,
    0x97: 1000,
    0x98: 333,
    0x99: 1000,
    0x9a: 556,
    0x9b: 333,
    0x9c: 944,
    0x9e: 500,
    0x9f: 667,
    0xa0: 278,
    0xa1: 333,
    0xa9: 737,
    0xab: 556,
    0xb7: 278,
    0xbb: 556,
    0xbf: 611,
  },
};

// Helvetica-Oblique shares Helvetica's metrics; Courier is uniformly 600.
EXTRAS.helvO = EXTRAS.helv;
EXTRAS.cour = {};
EXTRAS.courB = {};

for (const key of Object.keys(FONTS)) {
  for (const [code, width] of Object.entries(EXTRAS[key])) {
    FONTS[key].widths.set(Number(code), width);
  }
}

/**
 * The width table's key for a character: its WinAnsi byte.
 *
 * This is the one thing that has to be canonical, because a character reaches
 * this module in two different spellings — U+2014 from the Markdown source, and
 * 0x97 from the content stream when something measures what was actually written
 * — and both must resolve to the same width. When they disagreed, the wrapper
 * believed an em dash was 0.556em and the finished line ran past the right
 * margin, which is exactly what a reader would see as text falling off the page.
 */
function canonicalByte(char) {
  const code = char.codePointAt(0);
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0x80 && code <= 0xff) return code;

  const mapped = WIN_ANSI_EXTRAS.get(char);
  if (mapped !== undefined) return mapped;

  // A character the encoder spells out (a tick becomes `[x]`) measures as its
  // spelling, so the wrapper and the drawn text still agree.
  const substitute = TRANSLITERATE.get(char);
  if (substitute !== undefined) {
    return substitute.length === 1 ? substitute.codePointAt(0) : 0x3f;
  }

  // An accented Latin letter is as wide as the letter under the accent.
  const base = char.normalize('NFD')[0];
  if (base !== char) {
    const baseCode = base.codePointAt(0);
    if (baseCode >= 0x20 && baseCode <= 0x7e) return baseCode;
  }

  return null;
}

/** Width in 1/1000 em, or null when this font has no entry for the character. */
function widthOf(char, font) {
  const { widths, mono } = FONTS[font];
  const byte = canonicalByte(char);
  if (byte !== null && widths.has(byte)) return widths.get(byte);
  // Courier is monospaced: every character is 0.6em, measured or not.
  return mono ? 600 : null;
}

/** Characters in `text` with no known width for `font` (measured as a guess). */
export function unmeasuredIn(text, font) {
  const missing = [];
  for (const char of String(text)) {
    if (widthOf(char, font) === null && !missing.includes(char)) missing.push(char);
  }
  return missing;
}

export function measureText(text, font, size) {
  let total = 0;
  for (const char of text) total += widthOf(char, font) ?? DEFAULT_WIDTH;
  return (total * size) / 1000;
}

export const measureRuns = (runs, size) =>
  runs.reduce((total, run) => total + measureText(run.text, run.font, size), 0);

/* ------------------------------------------------------- character encoding */

/**
 * Unicode -> WinAnsiEncoding byte. WinAnsi is Latin-1 plus the 0x80-0x9F block
 * where the typographic characters live, which is why a plain `codePoint & 0xFF`
 * is not enough: an em dash (U+2014) would land on a control byte.
 */
const WIN_ANSI_EXTRAS = new Map(
  Object.entries({
    '\u20ac': 0x80,
    '\u201a': 0x82,
    '\u0192': 0x83,
    '\u201e': 0x84,
    '\u2026': 0x85,
    '\u2020': 0x86,
    '\u2021': 0x87,
    '\u02c6': 0x88,
    '\u2030': 0x89,
    '\u0160': 0x8a,
    '\u2039': 0x8b,
    '\u0152': 0x8c,
    '\u017d': 0x8e,
    '\u2018': 0x91,
    '\u2019': 0x92,
    '\u201c': 0x93,
    '\u201d': 0x94,
    '\u2022': 0x95,
    '\u2013': 0x96,
    '\u2014': 0x97,
    '\u02dc': 0x98,
    '\u2122': 0x99,
    '\u0161': 0x9a,
    '\u203a': 0x9b,
    '\u0153': 0x9c,
    '\u017e': 0x9e,
    '\u0178': 0x9f,
  }),
);

/**
 * Characters with no glyph in the standard-14 fonts at all, spelled out instead.
 * The report source is kept free of these (the test asserts nothing is
 * substituted), but a stray tick in a table should render as ASCII rather than
 * vanish.
 */
const TRANSLITERATE = new Map(
  Object.entries({
    '\u2192': '->',
    '\u21d2': '=>',
    '\u2264': '<=',
    '\u2265': '>=',
    '\u2260': '!=',
    '\u2713': '[x]',
    '\u2705': '[x]',
    '\u274c': '[ ]',
    '\u2011': '-',
    '\u00a0': ' ',
    '\u2009': ' ',
    '\u200a': ' ',
    '\u2002': ' ',
    '\u2003': ' ',
    '\u200b': '',
    '\u200d': '',
    '\ufe0f': '',
  }),
);

/**
 * @returns {{ text: string, replaced: string[] }} `text` holds one byte per char
 *   (latin1-safe), `replaced` names whatever could not be represented.
 */
export function toWinAnsi(input) {
  const replaced = [];
  let out = '';

  for (const char of String(input)) {
    const code = char.codePointAt(0);

    if (code === 0x0a) {
      out += '\n';
      continue;
    }
    if (code === 0x09) {
      out += '    ';
      continue;
    }

    const substitute = TRANSLITERATE.get(char);
    if (substitute !== undefined) {
      out += substitute;
      continue;
    }

    const extra = WIN_ANSI_EXTRAS.get(char);
    if (extra !== undefined) {
      out += String.fromCharCode(extra);
      continue;
    }

    // Latin-1 proper. 0x7f-0x9f are controls in Unicode but graphic in WinAnsi,
    // and no real text uses them, so they are treated as unrepresentable.
    if (code >= 0x20 && code <= 0x7e) {
      out += char;
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += char;
      continue;
    }

    if (!replaced.includes(char)) replaced.push(char);
    out += '?';
  }

  return { text: out, replaced };
}

/** Escape a latin1 string for a PDF literal `( )` string. */
export function escapePdfString(text) {
  return text.replace(/([\\()])/g, '\\$1').replace(/[\r\n]/g, ' ');
}

/* --------------------------------------------------------- inline Markdown */

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;
const CODE = /`([^`]+)`/;
const BOLD = /\*\*([^*]+)\*\*/;
const ITALIC = /\*([^*]+)\*/;

/**
 * Split one line into styled runs. Code is matched first so that any markup
 * inside backticks stays literal, and links before bold so a bolded label still
 * becomes a link.
 */
export function parseInline(text, base = 'helv') {
  const runs = [];
  let rest = String(text);

  while (rest) {
    const candidates = [
      { match: LINK.exec(rest), kind: 'link' },
      { match: CODE.exec(rest), kind: 'code' },
      { match: BOLD.exec(rest), kind: 'bold' },
      { match: ITALIC.exec(rest), kind: 'italic' },
    ].filter((candidate) => candidate.match);

    if (candidates.length === 0) {
      runs.push({ text: rest, font: base });
      break;
    }

    // Leftmost match wins; `**` before `*` at the same index, which the ordering
    // above gives us because both regexes start at the same offset.
    const best = candidates.reduce((a, b) => (b.match.index < a.match.index ? b : a));

    if (best.match.index > 0) {
      runs.push({ text: rest.slice(0, best.match.index), font: base });
    }

    const [, first, second] = best.match;
    if (best.kind === 'link') {
      runs.push({ text: first, font: base, link: second, underline: true, color: 'link' });
      if (base === 'helvB') runs[runs.length - 1].font = 'helvB';
    } else if (best.kind === 'code') {
      runs.push({ text: first, font: 'cour', size: 0.92, color: 'code' });
    } else if (best.kind === 'bold') {
      runs.push({ text: first, font: base === 'helv' ? 'helvB' : base });
    } else {
      runs.push({ text: first, font: base === 'helv' ? 'helvO' : base });
    }

    rest = rest.slice(best.match.index + best.match[0].length);
  }

  return runs.filter((run) => run.text !== '');
}

/* -------------------------------------------------------------- block parse */

const DIRECTIVE = /^:::\s*(\w+)\s*$/;
const DIRECTIVE_END = /^:::\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^\s*```\s*(\S*)\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
// A pipe is required, or a plain `---` horizontal rule reads as a table
// separator and then renders as a paragraph.
const TABLE_SEPARATOR = /^\s*(?=[^\n]*\|)[\s:|-]*-[\s:|-]*\s*$/;
const BOLD_ONLY = /^\*\*(.+)\*\*$/;

/**
 * Parse the supported Markdown subset into blocks. Unknown lines become
 * paragraphs, so nothing is dropped on the floor.
 */
export function parseBlocks(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const pushParagraph = (buffer) => {
    if (buffer.length > 0) blocks.push({ type: 'paragraph', text: buffer.join(' ') });
    buffer.length = 0;
  };

  let paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i])) i += 1;
      i += 1;
      continue;
    }

    const directive = DIRECTIVE.exec(line);
    if (directive) {
      pushParagraph(paragraph);
      const name = directive[1].toLowerCase();
      const body = [];
      i += 1;
      // A bare `:::` closes. Another `::: name` also ends it, so a missing
      // closer swallows one block instead of the rest of the document.
      while (i < lines.length && !DIRECTIVE_END.test(lines[i]) && !DIRECTIVE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const terminated = i < lines.length && DIRECTIVE_END.test(lines[i]);
      if (terminated) i += 1;
      if (name === 'pagebreak') blocks.push({ type: 'pagebreak' });
      else if (name === 'cover')
        blocks.push({ type: 'cover', lines: body, unterminated: !terminated });
      else
        blocks.push({ type: 'code', text: body.join('\n'), lang: name, unterminated: !terminated });
      continue;
    }

    if (DIRECTIVE_END.test(line)) {
      // A stray closer with no opener: ignore rather than render `:::`.
      pushParagraph(paragraph);
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      pushParagraph(paragraph);
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[1] });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      pushParagraph(paragraph);
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (RULE.test(line) && !TABLE_SEPARATOR.test(line)) {
      pushParagraph(paragraph);
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      pushParagraph(paragraph);
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map(alignmentOf);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    // One list parser for both kinds, because the continuation line is the same
    // problem either way: an item that wraps in the source has to stay one item,
    // or the renderer draws the rest of it as a paragraph against the left
    // margin, at body spacing, in the middle of the list.
    if (BULLET.test(line) || ORDERED.test(line)) {
      pushParagraph(paragraph);
      const { items, next } = parseList(lines, i);
      blocks.push({ type: 'list', items });
      i = next;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      pushParagraph(paragraph);
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1].trim());
        i += 1;
      }
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }

    if (line.trim() === '') {
      pushParagraph(paragraph);
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  pushParagraph(paragraph);
  return blocks;
}

const indentOf = (spaces) => Math.min(2, Math.floor(spaces.replace(/\t/g, '  ').length / 2));

/**
 * Consume one list, bulleted or ordered or mixed, from `start`.
 * @returns {{ items: Array<{text: string, indent: number, number: string|null}>, next: number }}
 */
function parseList(lines, start) {
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);

    if (bullet) {
      items.push({ text: bullet[2].trim(), indent: indentOf(bullet[1]), number: null });
    } else if (ordered) {
      items.push({ text: ordered[3].trim(), indent: indentOf(ordered[1]), number: ordered[2] });
    } else if (/^\s+\S/.test(line) && items.length > 0) {
      // A wrapped line inside the previous item.
      items[items.length - 1].text += ` ${line.trim()}`;
    } else {
      break;
    }

    i += 1;
  }

  return { items, next: i };
}

const splitRow = (line) =>
  TABLE_ROW.exec(line)[1]
    .split('|')
    .map((cell) => cell.trim())
    .map((cell) => {
      const bold = BOLD_ONLY.exec(cell);
      return bold ? { text: bold[1], bold: true } : { text: cell };
    });

const alignmentOf = (cell) => {
  const text = cell.text.trim();
  if (text.startsWith(':') && text.endsWith(':')) return 'center';
  if (text.endsWith(':')) return 'right';
  return 'left';
};

/* ---------------------------------------------------------------- wrapping */

/**
 * Split styled runs into lines that fit `maxWidth`, measuring with the real
 * advance widths of each run's own font. A single word wider than the line is
 * broken rather than allowed to overflow, because an overflowing line runs off
 * the page edge where nobody sees it.
 */
export function wrapRuns(runs, maxWidth, size) {
  if (runs.length === 0) return [{ runs: [], width: 0 }];

  const lines = [];
  let current = [];
  let width = 0;

  const flush = () => {
    lines.push({ runs: current, width });
    current = [];
    width = 0;
  };

  const addPiece = (run, text) => {
    const pieceWidth = measureText(text, run.font, size);
    if (width + pieceWidth > maxWidth && width > 0) flush();
    current.push({ ...run, text });
    width += pieceWidth;
  };

  for (const run of runs) {
    const tokens = run.text.split(/(\s+)/).filter((token) => token !== '');

    for (const token of tokens) {
      const tokenWidth = measureText(token, run.font, size);

      if (/\s/.test(token)) {
        // Whitespace survives only in the middle of a line: not at the start of
        // one (where it would indent a line that is not indented), and not past
        // the right edge (where it would make the line measure wider than its
        // own box, for no visible reason).
        if (width > 0 && width + tokenWidth <= maxWidth) {
          current.push({ ...run, text: token });
          width += tokenWidth;
        }
        continue;
      }

      if (tokenWidth <= maxWidth) {
        addPiece(run, token);
        continue;
      }

      // Too long for an empty line: break it character by character.
      let piece = '';
      let pieceWidth = 0;
      for (const char of token) {
        const charWidth = measureText(char, run.font, size);
        if (width + pieceWidth + charWidth > maxWidth && width + pieceWidth > 0) {
          if (piece) addPiece(run, piece);
          // Only break the line if something is on it — flushing an empty line
          // would put a stray blank line in the middle of a paragraph.
          if (current.length > 0) flush();
          piece = '';
          pieceWidth = 0;
        }
        piece += char;
        pieceWidth += charWidth;
      }
      if (piece) addPiece(run, piece);
    }
  }

  flush();
  return lines;
}

/* ------------------------------------------------------------------ layout */

export const PAGE = {
  width: 595.276, // A4, in points
  height: 841.89,
  margin: { top: 76, right: 68, bottom: 68, left: 68 },
};

const STYLE = {
  bodySize: 10.5,
  bodyLead: 14.6,
  paraSpace: 7,
  h: {
    1: { size: 19, lead: 24, before: 4, after: 12 },
    2: { size: 14.5, lead: 19, before: 17, after: 7 },
    3: { size: 11.6, lead: 15, before: 12, after: 5 },
    4: { size: 10.5, lead: 14, before: 10, after: 4 },
  },
  listIndent: 16,
  listLead: 14.2,
  codeSize: 8,
  codeLead: 10.6,
  tableSize: 8.8,
  tableLead: 11.4,
  tablePad: 5,
  quoteIndent: 18,
};

const COLOR = {
  text: '0 0 0',
  muted: '0.42 0.42 0.42',
  rule: '0.78 0.78 0.78',
  link: '0.04 0.28 0.66',
  code: '0.12 0.16 0.24',
  accent: '0.08 0.25 0.55',
};

class Layout {
  constructor() {
    this.pages = [];
    this.ops = null;
    this.links = [];
    this.newPage();
    this.replaced = [];
    this.unmeasured = [];
    this.truncated = [];
  }

  get contentWidth() {
    return PAGE.width - PAGE.margin.left - PAGE.margin.right;
  }

  get bottom() {
    return PAGE.margin.bottom;
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE.height - PAGE.margin.top;
  }

  ensure(height) {
    if (this.y - height < this.bottom) this.newPage();
  }

  advance(height) {
    this.y -= height;
  }

  text(font, size, x, y, text, color = 'text') {
    const { text: encoded, replaced } = toWinAnsi(text);
    for (const char of replaced) if (!this.replaced.includes(char)) this.replaced.push(char);
    for (const char of unmeasuredIn(encoded, font)) {
      if (!this.unmeasured.includes(char)) this.unmeasured.push(char);
    }
    this.ops.push({
      op: 'text',
      font,
      size,
      x,
      y,
      text: encoded,
      color: COLOR[color] ?? color,
    });
    return encoded;
  }

  rect(x, y, w, h, fill) {
    this.ops.push({ op: 'rect', x, y, w, h, fill });
  }

  /** Record a clickable rectangle against the page it was drawn on. */
  link(x, y, w, h, url) {
    this.links.push({ page: this.pages.length - 1, x, y, w, h, url });
  }
}

/** Draw a run sequence at `x` for one line. */
function drawRuns(layout, runs, x, size, { align = 'left', maxWidth = layout.contentWidth } = {}) {
  const width = measureRuns(runs, size);
  if (align === 'center') x += Math.max(0, (maxWidth - width) / 2);
  if (align === 'right') x += Math.max(0, maxWidth - width);

  let cursor = x;
  for (const run of runs) {
    const fontSize = size * (run.size ?? 1);
    const text = run.text;
    layout.text(run.font, fontSize, cursor, layout.y, text, run.color ?? 'text');
    const runWidth = measureText(text, run.font, fontSize);

    if (run.underline) {
      layout.rect(cursor, layout.y - 2.1, runWidth, 0.5, COLOR.link);
      if (run.link) layout.link(cursor, layout.y - 2.1, runWidth, fontSize + 2, run.link);
    }

    cursor += runWidth;
  }

  return cursor;
}

/**
 * Draw wrapped lines one at a time, breaking the page between lines rather than
 * before the block — a paragraph longer than one page then flows instead of
 * running off the bottom edge.
 */
function drawLines(layout, lines, x, size, lead) {
  for (const line of lines) {
    layout.ensure(lead);
    drawRuns(layout, line.runs, x, size);
    layout.advance(lead);
  }
}

function drawParagraph(layout, text, base = 'helv') {
  const runs = parseInline(text, base);
  const lines = wrapRuns(runs, layout.contentWidth, STYLE.bodySize);
  const spaceBefore = layout.ops.length === 0 ? 0 : STYLE.paraSpace;
  layout.ensure(STYLE.bodyLead + spaceBefore);
  layout.advance(spaceBefore);

  // A paragraph split across a page keeps its left edge.
  drawLines(layout, lines, PAGE.margin.left, STYLE.bodySize, STYLE.bodyLead);
}

function drawHeading(layout, level, text) {
  const style = STYLE.h[level];
  const runs = parseInline(text, 'helvB');

  layout.ensure(style.before + style.lead + 30);
  layout.advance(style.before);

  const lines = wrapRuns(runs, layout.contentWidth, style.size);
  for (const line of lines) {
    layout.ensure(style.lead);
    drawRuns(layout, line.runs, PAGE.margin.left, style.size);
    layout.advance(style.lead);
  }
  layout.advance(style.after);

  if (level === 1) layout.rect(PAGE.margin.left, layout.y + 4, 54, 2, COLOR.accent);
}

function drawList(layout, items) {
  for (const item of items) {
    const indent = STYLE.listIndent + (item.indent ?? 0) * 14;
    const marker = item.number ? `${item.number}.` : '\u2022';
    const markerWidth = 13;
    const runs = parseInline(item.text);
    const lines = wrapRuns(runs, layout.contentWidth - indent - markerWidth, STYLE.bodySize);

    layout.ensure(STYLE.listLead);
    layout.text('helv', STYLE.bodySize, PAGE.margin.left + indent, layout.y, marker, 'muted');

    for (const line of lines) {
      layout.ensure(STYLE.listLead);
      drawRuns(layout, line.runs, PAGE.margin.left + indent + markerWidth, STYLE.bodySize);
      layout.advance(STYLE.listLead);
    }
  }
  layout.advance(3);
}

function drawQuote(layout, text) {
  const runs = parseInline(text, 'helvO');
  const indent = STYLE.quoteIndent;
  const lines = wrapRuns(runs, layout.contentWidth - indent, STYLE.bodySize);
  layout.ensure(STYLE.bodyLead + STYLE.paraSpace);
  layout.advance(STYLE.paraSpace);

  const top = layout.y + STYLE.bodyLead - 3;
  for (const line of lines) {
    layout.ensure(STYLE.bodyLead);
    drawRuns(layout, line.runs, PAGE.margin.left + indent, STYLE.bodySize);
    layout.advance(STYLE.bodyLead);
  }
  layout.rect(PAGE.margin.left + 5, layout.y + 3, 2, top - layout.y - 3, COLOR.rule);
  layout.advance(4);
}

function drawCode(layout, text) {
  const lines = text.split('\n');
  const size = STYLE.codeSize;
  const indent = 8;

  for (const line of lines) {
    const width = measureText(line, 'cour', size);
    const y = () => layout.y;

    layout.ensure(STYLE.codeLead);
    if (width > layout.contentWidth - indent) {
      // Shrink to fit rather than run off the page; if even 6pt is not enough,
      // record it so the test can fail instead of the reader finding out.
      const shrunk = size * ((layout.contentWidth - indent) / width);
      if (shrunk >= 6) {
        layout.text('cour', shrunk, PAGE.margin.left + indent, y(), line, 'code');
      } else {
        const keep = Math.floor(line.length * ((layout.contentWidth - indent) / width)) - 1;
        layout.text(
          'cour',
          size,
          PAGE.margin.left + indent,
          y(),
          `${line.slice(0, keep)}...`,
          'code',
        );
        if (!layout.truncated.includes(line)) layout.truncated.push(line);
      }
    } else {
      layout.text('cour', size, PAGE.margin.left + indent, y(), line, 'code');
    }
    layout.rect(PAGE.margin.left, layout.y - 2, 2, STYLE.codeLead - 1, '0.86 0.88 0.92');
    layout.advance(STYLE.codeLead);
  }
  layout.advance(6);
}

/**
 * Column widths, in two steps: every column first gets the width of its longest
 * single word, so no word is broken mid-word, and whatever is left is shared out
 * in proportion to how much text each column actually holds. Equal columns would
 * leave a two-word "id" column as wide as the paragraph beside it; scaling by
 * longest-cell alone does the same thing, because one long cell distorts the
 * ratio for every column.
 */
export function tableColumns(block, available) {
  const pad = STYLE.tablePad * 2;
  const cellsOf = (column) => [
    block.header[column].text,
    ...block.rows.map((row) => (row[column] ?? { text: '' }).text),
  ];

  const columns = block.header.map((_, column) => cellsOf(column));

  // The floor: wide enough for the longest word, plus padding.
  const need = columns.map((cells) => Math.max(...cells.map(longestToken)) + pad);

  // The weight: average cell length, so the column holding prose takes the
  // slack and the column holding "A1" does not.
  const weight = columns.map((cells) => {
    const mean = cells.reduce((sum, cell) => sum + cell.length, 0) / cells.length;
    return Math.max(4, mean);
  });

  const totalNeed = need.reduce((sum, value) => sum + value, 0);
  const slack = available - totalNeed;

  if (slack <= 0) {
    // Too narrow to honour every word: shrink in proportion and let the wrapper
    // break the few words that no longer fit.
    return need.map((value) => (value / totalNeed) * available);
  }

  const totalWeight = weight.reduce((sum, value) => sum + value, 0);
  return need.map((value, index) => value + slack * (weight[index] / totalWeight));
}

function longestToken(text) {
  return text
    .split(/\s+/)
    .reduce((longest, token) => Math.max(longest, measureText(token, 'helv', STYLE.tableSize)), 0);
}

function drawTable(layout, block, available = layout.contentWidth) {
  const widths = tableColumns(block, available);
  const size = STYLE.tableSize;

  const layoutRow = (cells, { bold }) => {
    const cellLines = cells.map((cell, column) => {
      const runs = parseInline(cell.text, bold ? 'helvB' : 'helv');
      return wrapRuns(runs, widths[column] - STYLE.tablePad * 2, size);
    });
    const height = Math.max(...cellLines.map((lines) => lines.length)) * STYLE.tableLead;

    layout.ensure(height + 4);
    const top = layout.y;

    let x = PAGE.margin.left;
    cellLines.forEach((lines, column) => {
      const align = block.align[column] ?? 'left';
      let lineY = top;
      for (const line of lines) {
        layout.y = lineY;
        drawRuns(layout, line.runs, x + STYLE.tablePad, size, {
          align,
          maxWidth: widths[column] - STYLE.tablePad * 2,
        });
        lineY -= STYLE.tableLead;
      }
      x += widths[column];
    });

    layout.y = top - height;
    layout.rect(PAGE.margin.left, layout.y - 1, available, 0.5, COLOR.rule);
    layout.advance(2);
  };

  layoutRow(block.header, { bold: true });
  for (const row of block.rows) {
    const cells = block.header.map((_, column) => row[column] ?? { text: '' });
    layoutRow(cells, { bold: false });
  }
  layout.advance(8);
}

function drawCover(layout, lines) {
  const blocks = parseBlocks(lines.join('\n'));
  const center = PAGE.margin.left;

  // A cover is a page of its own: the title page is not a section that happens
  // to start mid-page.
  if (layout.ops.length > 0) layout.newPage();
  layout.advance(150);

  for (const block of blocks) {
    if (block.type === 'heading') {
      const size = block.level === 1 ? 30 : 15;
      const runs = parseInline(block.text, block.level === 1 ? 'helvB' : 'helv');
      const wrapped = wrapRuns(runs, layout.contentWidth, size);
      for (const line of wrapped) {
        drawRuns(layout, line.runs, center, size, { align: 'center' });
        layout.advance(size * 1.35);
      }
      layout.advance(block.level === 1 ? 10 : 6);
      if (block.level === 1) {
        layout.rect(PAGE.width / 2 - 40, layout.y + 6, 80, 2.5, COLOR.accent);
        layout.advance(14);
      }
      continue;
    }

    if (block.type === 'list') {
      for (const item of block.items) {
        const runs = parseInline(item.text, 'helv');
        drawRuns(layout, runs, center, 10.5, { align: 'center' });
        layout.advance(15);
      }
      continue;
    }

    // Anything else (a paragraph, and anything the subset does not model) is
    // centred as text rather than dropped.
    const runs = parseInline(block.text ?? '', 'helv');
    const wrapped = wrapRuns(runs, layout.contentWidth, 11);
    for (const line of wrapped) {
      drawRuns(layout, line.runs, center, 11, { align: 'center' });
      layout.advance(16);
    }
  }
}

/* -------------------------------------------------------------- PDF writing */

/**
 * Two spellings, because the text is encoded exactly once. A raw string (a
 * document title) is converted and escaped; a string already produced by
 * `Layout.text` is only escaped — converting twice would push an em dash (0x97)
 * through the encoder a second time, where it is not a legal code point and would
 * come out as `?`.
 */
const encodeRaw = (text) => escapePdfString(toWinAnsi(text).text);
const escapeEncoded = (text) => escapePdfString(text);

/** A footer drawn after layout, so it never competes with content for space. */
function withFooters(layout, title) {
  return layout.pages.map((page, index) => {
    const y = PAGE.margin.bottom - 34;
    const label = `${title}  ·  page ${index + 1} of ${layout.pages.length}`;
    const runs = [{ text: label, font: 'helv' }];
    const width = measureRuns(runs, 8);

    return [
      ...page,
      {
        op: 'rect',
        x: PAGE.margin.left,
        y: y + 12,
        w: layout.contentWidth,
        h: 0.5,
        fill: COLOR.rule,
      },
      {
        op: 'text',
        font: 'helv',
        size: 8,
        x: (PAGE.width - width) / 2,
        y,
        text: label,
        color: COLOR.muted,
      },
    ];
  });
}

function buildPdf(pages, links, title) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  // Bucket the clickable rectangles by the page they were drawn on.
  const linksByPage = pages.map(() => []);
  for (const link of links) {
    if (linksByPage[link.page]) linksByPage[link.page].push(link);
  }

  const fontIds = {};
  const catalogId = add('');
  const pagesId = add('');

  for (const [key, font] of Object.entries(FONTS)) {
    fontIds[key] = add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${font.label} /Encoding /WinAnsiEncoding >>`,
    );
  }

  const pageIds = [];

  pages.forEach((ops, index) => {
    const stream = ops
      .map((op) => {
        if (op.op === 'text') {
          return `BT ${op.color} rg /${FONTS[op.font].pdf} ${op.size.toFixed(2)} Tf 1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)} Tm (${escapeEncoded(op.text)}) Tj ET`;
        }
        return `${op.fill} rg ${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.w.toFixed(2)} ${op.h.toFixed(2)} re f`;
      })
      .join('\n');

    const compressed = zlib.deflateSync(Buffer.from(stream, 'latin1'));

    const annotations = linksByPage[index].map(
      (link) =>
        `<< /Type /Annot /Subtype /Link /Rect [${link.x0.toFixed(2)} ${link.y0.toFixed(2)} ${link.x1.toFixed(2)} ${link.y1.toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI (${encodeRaw(link.url)}) >> >>`,
    );

    const contentId = add(`__STREAM__${compressed.toString('base64')}`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width.toFixed(2)} ${PAGE.height.toFixed(2)}] ` +
        `/Resources << /Font << ${Object.entries(fontIds)
          .map(([key, id]) => `/${FONTS[key].pdf} ${id} 0 R`)
          .join(' ')} >> >> ` +
        `/Contents ${contentId} 0 R` +
        (annotations.length > 0 ? ` /Annots [${annotations.join(' ')}]` : '') +
        ` >>`,
    );
    pageIds.push(pageId);
  });

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets = [];

  const chunks = [];
  for (let i = 0; i < objects.length; i += 1) {
    const body = objects[i];
    offsets.push(Buffer.byteLength(out + chunks.join(''), 'latin1'));

    let text;
    if (typeof body === 'string' && body.startsWith('__STREAM__')) {
      const data = Buffer.from(body.slice('__STREAM__'.length), 'base64');
      text =
        `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n` +
        data.toString('latin1') +
        `\nendstream`;
    } else {
      text = body;
    }

    chunks.push(`${i + 1} 0 obj\n${text}\nendobj\n`);
  }

  out += chunks.join('');
  const xrefOffset = Buffer.byteLength(out, 'latin1');

  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info << /Title (${encodeRaw(title)}) /Producer (scripts/report-pdf.mjs) >> >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------ entry points */

/**
 * Render Markdown to a PDF buffer.
 * @returns {{ pdf: Buffer, pages: number, stats: object }}
 */
export function renderMarkdown(markdown, { title = 'Project report' } = {}) {
  const blocks = parseBlocks(markdown);
  const layout = new Layout();

  for (const block of blocks) {
    switch (block.type) {
      case 'cover':
        drawCover(layout, block.lines);
        layout.newPage();
        break;
      case 'heading':
        drawHeading(layout, block.level, block.text);
        break;
      case 'paragraph':
        drawParagraph(layout, block.text);
        break;
      case 'list':
        drawList(layout, block.items);
        break;
      case 'quote':
        drawQuote(layout, block.text);
        break;
      case 'code':
        drawCode(layout, block.text);
        break;
      case 'table':
        drawTable(layout, block);
        break;
      case 'rule':
        layout.ensure(10);
        layout.advance(6);
        layout.rect(PAGE.margin.left, layout.y, layout.contentWidth, 0.5, COLOR.rule);
        layout.advance(10);
        break;
      case 'pagebreak':
        layout.newPage();
        break;
      default:
        drawParagraph(layout, block.text ?? JSON.stringify(block));
    }
  }

  // A trailing empty page (from a final directive) is dropped.
  if (layout.pages.length > 1 && layout.pages[layout.pages.length - 1].length === 0) {
    layout.pages.pop();
  }

  const pages = withFooters(layout, title);
  const links = layout.links.map((link) => ({
    ...link,
    x0: link.x,
    y0: link.y - 1,
    x1: link.x + link.w,
    y1: link.y + link.h,
  }));

  return {
    pdf: buildPdf(pages, links, title),
    pages: pages.length,
    stats: {
      blocks: blocks.length,
      replaced: layout.replaced,
      unmeasured: layout.unmeasured,
      truncated: layout.truncated,
      unterminated: blocks.filter((block) => block.unterminated).length,
    },
  };
}

/**
 * Every page's content stream, inflated, in page order.
 *
 * The stream is read by its declared `/Length` rather than by scanning for the
 * `endstream` keyword: compressed data is arbitrary bytes, and the nine ASCII
 * characters `endstream` can appear inside it — which is not a theoretical
 * worry, it happened, and one page silently failed to inflate. A PDF says how
 * long its stream is; reading it any other way is guessing.
 */
export function contentStreams(pdf) {
  const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf, 'latin1');
  const source = buffer.toString('latin1');
  const streams = [];
  const header = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;

  let match = header.exec(source);
  while (match) {
    const start = match.index + match[0].length;
    const length = Number(match[1]);
    const raw = Buffer.from(source.slice(start, start + length), 'latin1');

    try {
      streams.push(zlib.inflateSync(raw).toString('latin1'));
    } catch {
      // An unreadable stream is left out rather than guessed at; the caller's
      // page count check is what notices.
    }

    header.lastIndex = start + length;
    match = header.exec(source);
  }

  return streams;
}

/**
 * Read the document back as lines of text, in reading order.
 *
 * The words are reassembled rather than returned one `Tj` at a time, because
 * the layout emits a separate operation per token (that is what makes kerning
 * and mixed fonts work), so the raw stream is one word per call. Grouping by
 * page and baseline and ordering by x is the inverse of the layout, which makes
 * this a real round trip: it catches escaping and encoding bugs, not just a
 * missing glyph.
 */
export function extractText(pdf) {
  const lines = [];

  for (const content of contentStreams(pdf)) {
    const byBaseline = new Map();
    for (const line of content.split('\n')) {
      const op = /^BT .* Tm \(((?:\\.|[^)\\])*)\) Tj ET$/.exec(line);
      const at = /^BT .* 1 0 0 1 ([\d.]+) ([\d.]+) Tm /.exec(line);
      if (!op || !at) continue;

      const y = at[2];
      if (!byBaseline.has(y)) byBaseline.set(y, []);
      byBaseline.get(y).push({ x: Number(at[1]), text: op[1].replace(/\\([\\()])/g, '$1') });
    }

    const baselines = [...byBaseline.keys()].sort((a, b) => Number(b) - Number(a));
    for (const baseline of baselines) {
      const text = byBaseline
        .get(baseline)
        .sort((a, b) => a.x - b.x)
        .map((piece) => piece.text)
        .join('');
      if (text.trim() !== '') lines.push(text);
    }
  }

  return lines;
}

export function countPages(pdf) {
  const source = (Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf, 'latin1')).toString('latin1');
  const match = source.match(/\/Type \/Pages\b[\s\S]*?\/Count (\d+)/);
  return match ? Number(match[1]) : 0;
}

function main(argv) {
  const [input = 'docs/report.md', output = 'docs/report.pdf'] = argv;
  const source = readFileSync(path.resolve(REPO_ROOT, input), 'utf8');
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Project report';

  const { pdf, pages, stats } = renderMarkdown(source, { title });
  writeFileSync(path.resolve(REPO_ROOT, output), pdf);

  const problems = [];
  if (stats.replaced.length > 0) {
    problems.push(`no glyph for ${stats.replaced.map((char) => JSON.stringify(char)).join(', ')}`);
  }
  if (stats.unmeasured.length > 0) {
    problems.push(
      `no width known for ${stats.unmeasured.map((char) => JSON.stringify(char)).join(', ')}`,
    );
  }
  if (stats.truncated.length > 0) problems.push(`${stats.truncated.length} code line(s) truncated`);
  if (stats.unterminated > 0) {
    problems.push(`${stats.unterminated} directive block(s) never closed with \`:::\``);
  }

  console.log(
    `${output}: ${pages} pages, ${(pdf.length / 1024).toFixed(1)} KB, ${stats.blocks} blocks`,
  );
  for (const problem of problems) console.warn(`warning: ${problem}`);

  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
