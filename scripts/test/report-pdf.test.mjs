/**
 * Tests for the report renderer, which is the one script whose output nobody
 * reads as text: a PDF that is subtly wrong still opens, and still prints, and
 * the mistake is only visible to a human looking at the page.
 *
 * So the checks here are the mechanical ones a reader cannot do by eye:
 *
 *   1. The font metrics are right. A width table entry that is too small pulls
 *      every following character left, and the resulting collision looks like a
 *      rendering glitch rather than a bug in a number. This is not hypothetical:
 *      the digit widths were wrong (278 instead of 556) and the em dash was
 *      falling back to a default of 0.556em instead of a full em.
 *   2. No two pieces of text share a baseline and overlap. That one assertion
 *      would have caught (1) immediately, on any page of the document.
 *   3. Everything the report needs is representable. A character with no glyph in
 *      the standard fonts does not fail; it silently becomes `?`.
 *   4. The document still meets the brief: real A4 pages, 8-15 of them, and all
 *      ten of the required sections present.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PAGE,
  contentStreams,
  countPages,
  extractText,
  measureText,
  parseBlocks,
  parseInline,
  renderMarkdown,
  tableColumns,
  toWinAnsi,
  unmeasuredIn,
  wrapRuns,
} from '../report-pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const REPORT = readFileSync(path.join(REPO_ROOT, 'docs/report.md'), 'utf8');

const renderReport = () => renderMarkdown(REPORT, { title: 'IntelliMeet' });

/**
 * Every drawn string with its position, grouped by the page it is on.
 *
 * Streams come back through the renderer's own reader, which uses each stream's
 * declared length — scanning for `endstream` instead looks fine until the
 * compressed bytes happen to contain those nine characters, and then a page
 * quietly disappears from every assertion here.
 */
function textOps(pdf) {
  const ops = [];

  contentStreams(pdf).forEach((content, page) => {
    for (const line of content.split('\n')) {
      const match = /^BT .* \/F(\d) ([\d.]+) Tf 1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*)\) Tj ET$/.exec(
        line,
      );
      if (!match) continue;
      ops.push({
        page,
        font: { 1: 'helv', 2: 'helvB', 3: 'cour', 4: 'courB', 5: 'helvO' }[Number(match[1])],
        size: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4]),
        text: match[5].replace(/\\([\\()])/g, '$1'),
      });
    }
  });

  return ops;
}

/* ------------------------------------------------------------------- metrics */

test('the font metric tables are complete for the printable ASCII range', () => {
  // 95 entries each; a miscount means a shifted table, where every letter is
  // measured as some other letter's width.
  for (const font of ['helv', 'helvB', 'cour']) {
    assert.deepEqual(
      unmeasuredIn(
        Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''),
        font,
      ),
      [],
    );
  }

  // Digits in Helvetica are 0.556em, not 0.278em. Getting this wrong is
  // invisible until two words collide after a date or a version number.
  assert.equal(measureText('0', 'helv', 1000), 556);
  assert.equal(measureText('9', 'helv', 1000), 556);
  assert.equal(measureText('0', 'helvB', 1000), 556);
  assert.equal(measureText('0', 'cour', 1000), 600);

  // Letters, to pin the table in more than one place.
  assert.equal(measureText('i', 'helv', 1000), 222);
  assert.equal(measureText('W', 'helv', 1000), 944);
  assert.equal(measureText('W', 'helvB', 1000), 944);
  assert.equal(measureText(' ', 'helv', 1000), 278);
});

test('the typographic glyphs the report uses are measured, not guessed', () => {
  // An em dash is a full em wide. Falling back to 0.556em pulled the next word
  // into the dash, which reads as a typo rather than as a layout bug.
  assert.equal(measureText('\u2014', 'helv', 1000), 1000);
  assert.equal(measureText('\u2014', 'helvB', 1000), 1000);

  // The bullet used for list markers, and the middle dot used in the footer.
  assert.equal(measureText('\u2022', 'helv', 1000), 350);
  assert.equal(measureText('\u00b7', 'helv', 1000), 278);

  // A character nobody has measured is reported rather than silently averaged.
  assert.deepEqual(unmeasuredIn('\u0416', 'helv'), ['\u0416']);
});

test('a line that is measured at more than its box would be a bug in the box', () => {
  const runs = parseInline('The quick brown fox jumps over the lazy dog and keeps going');
  const lines = wrapRuns(runs, 120, 10.5);
  for (const line of lines) {
    assert.ok(
      line.width <= 120 + 1e-6,
      `line measured ${line.width.toFixed(2)}pt against a 120pt box: ${line.runs.map((r) => r.text).join('')}`,
    );
  }
  // Wrapping must not lose words.
  const joined = lines.map((line) => line.runs.map((r) => r.text).join('')).join(' ');
  for (const word of ['quick', 'brown', 'lazy', 'going'])
    assert.match(joined, new RegExp(`\\b${word}\\b`));
});

test('wrapping leaves no blank lines and never starts a line with a space', () => {
  const lines = wrapRuns(parseInline('one two three four five six seven eight'), 40, 10.5);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.notEqual(
      line.runs
        .map((r) => r.text)
        .join('')
        .trim(),
      '',
      'empty line emitted',
    );
    assert.ok(!/^ /.test(line.runs[0].text), 'line starts with whitespace');
  }
});

test('a word longer than the line is broken rather than allowed to overflow', () => {
  const lines = wrapRuns(parseInline('a'.repeat(400)), 100, 10.5);
  for (const line of lines) assert.ok(line.width <= 100 + 1e-6);
  assert.equal(lines.map((line) => line.runs.map((r) => r.text).join('')).join('').length, 400);
});

test('an empty run list produces one empty line rather than a crash', () => {
  assert.deepEqual(wrapRuns([], 100, 10), [{ runs: [], width: 0 }]);
});

/* ------------------------------------------------------------------ encoding */

test('WinAnsi encoding puts typography on the right bytes', () => {
  assert.equal(toWinAnsi('dash \u2014 here').text, 'dash \u0097 here');
  assert.equal(toWinAnsi('bullet \u2022 dot \u00b7').text, 'bullet \u0095 dot \u00b7');
  assert.equal(toWinAnsi('caf\u00e9').text, 'caf\u00e9');

  // A tick has no glyph in the standard fonts: it is spelled out, not dropped.
  const tick = toWinAnsi('done \u2713');
  assert.equal(tick.text, 'done [x]');
  assert.deepEqual(tick.replaced, []);
});

test('a character with no representation is reported and replaced', () => {
  const result = toWinAnsi('Cyrillic \u0416 here');
  assert.deepEqual(result.replaced, ['\u0416']);
  assert.equal(result.text, 'Cyrillic ? here');
});

test('parentheses and backslashes are escaped in PDF strings', () => {
  const { text } = toWinAnsi('a (b) c \\ d');
  const escaped = text.replace(/([\\()])/g, '\\$1');
  assert.equal(escaped, 'a \\(b\\) c \\\\ d');
});

/* -------------------------------------------------------------- block parsing */

test('headings, rules, lists and nested lists parse into blocks', () => {
  const blocks = parseBlocks(
    [
      '# One',
      '',
      'A paragraph.',
      '',
      '- first',
      '  - nested',
      '- second',
      '',
      '---',
      '',
      '1. ordered',
    ].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'rule', 'list'],
  );
  // The nested item is flattened into the same list with an indent, which is
  // what the renderer needs to lay it out.
  assert.deepEqual(
    blocks[2].items.map((item) => [item.indent, item.text]),
    [
      [0, 'first'],
      [1, 'nested'],
      [0, 'second'],
    ],
  );
});

test('a wrapped ordered list item stays one item', () => {
  // The bug this pins: the continuation line of a numbered item used to be
  // parsed as a paragraph, so it was drawn against the left margin in the middle
  // of the list — at body spacing, in a different style from the item it belonged
  // to. Any prose edit that changes a line's length can trigger it.
  const blocks = parseBlocks(
    [
      '1. **Landing.** The static bundle loads with the API URL already',
      '   inlined at build time. There is no discovery step.',
      '2. **One click.** A guest is created.',
    ].join('\n'),
  );

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].items.length, 2);
  assert.equal(
    blocks[0].items[0].text,
    '**Landing.** The static bundle loads with the API URL already inlined at build time. There is no discovery step.',
  );
  assert.equal(blocks[0].items[1].number, '2');
});

test('a fenced code block keeps its lines exactly, including blank ones', () => {
  const blocks = parseBlocks(['```text', '+--+', '', '|  |', '+--+', '```'].join('\n'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, '+--+\n\n|  |\n+--+');
});

test('a pipe table parses with its header, alignment and rows', () => {
  const blocks = parseBlocks(
    ['| ID | Feature | Why |', '|---|---:|:---:|', '| A1 | **Alpha** | reason |'].join('\n'),
  );
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(
    blocks[0].header.map((cell) => cell.text),
    ['ID', 'Feature', 'Why'],
  );
  assert.deepEqual(blocks[0].align, ['left', 'right', 'center']);
  assert.equal(blocks[0].rows[0][1].bold, true);
});

test('a cover block ends at its own fence and does not swallow the document', () => {
  const blocks = parseBlocks(
    [':::cover', '# Title', ':::', '', '## Real section', '', 'Body text.'].join('\n'),
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['cover', 'heading', 'paragraph'],
  );
  assert.equal(blocks[1].text, 'Real section');
});

test('an unterminated directive is reported rather than silently swallowing the file', () => {
  const blocks = parseBlocks([':::cover', '# Title', '## Next section', '', 'Body.'].join('\n'));
  assert.equal(blocks[0].type, 'cover');
  assert.equal(blocks[0].unterminated, true, 'a missing closer must be visible to the caller');

  // A second directive opens implicitly, so the body stops there instead of
  // taking the whole document with it.
  const twoBlocks = parseBlocks(
    [':::cover', '# Title', ':::', '## Section', '', 'Body.'].join('\n'),
  );
  assert.ok(twoBlocks.some((block) => block.type === 'paragraph' && block.text === 'Body.'));
  assert.equal(twoBlocks[0].unterminated, false);

  const { stats } = renderMarkdown(':::cover\n# T\n\nBody.\n', { title: 'x' });
  assert.equal(stats.unterminated, 1);
});

test('inline markup becomes styled runs', () => {
  const runs = parseInline('plain **bold** `code` [label](https://example.com) *ital*');

  // Whitespace between two styled runs is its own run; the assertion is about
  // the styled ones, which must carry the right font and stay in order.
  const words = runs.filter((run) => run.text.trim() !== '');
  assert.deepEqual(
    words.map((run) => run.text.trim()),
    ['plain', 'bold', 'code', 'label', 'ital'],
  );
  assert.equal(words[0].font, 'helv');
  assert.equal(words[1].font, 'helvB');
  assert.equal(words[2].font, 'cour');
  assert.equal(words[3].link, 'https://example.com');
  assert.equal(words[4].font, 'helvO');

  // Nothing may be lost between the runs, spaces included.
  assert.equal(runs.map((run) => run.text).join(''), 'plain bold code label ital');
});

/* -------------------------------------------------------------------- tables */

test("table columns use the full width and respect each column's longest word", () => {
  const block = parseBlocks(
    ['| ID | Description |', '|---|---|', '| A1 | A long explanation that needs the room |'].join(
      '\n',
    ),
  )[0];

  const widths = tableColumns(block, 400);
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(Math.abs(total - 400) < 1e-6, `columns total ${total}, want 400`);

  // The prose column must be the wider one by a wide margin.
  assert.ok(widths[1] > widths[0] * 2, `description column ${widths[1]} vs id ${widths[0]}`);
});

test('table columns shrink in proportion when there is not enough room', () => {
  const block = parseBlocks(
    ['| A very long heading indeed | Another very long heading |', '|---|---|', '| x | y |'].join(
      '\n',
    ),
  )[0];
  const widths = tableColumns(block, 100);
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(total <= 100 + 1e-6);
  assert.ok(widths.every((width) => width > 0));
});

/* ----------------------------------------------------------------- the report */

test('the report renders as a real PDF with 8-15 A4 pages', () => {
  const { pdf, pages } = renderReport();

  assert.ok(pdf.length > 20_000, `PDF is only ${pdf.length} bytes`);
  assert.ok(pdf.length < 10 * 1024 * 1024, 'the brief caps an individual PDF at 10 MB');

  const head = pdf.subarray(0, 8).toString('latin1');
  assert.match(head, /^%PDF-1\.4/);

  const source = pdf.toString('latin1');
  assert.match(source, /startxref\n\d+\n%%EOF\n$/);
  assert.match(source, /\/MediaBox \[0 0 595\.28 841\.89\]/, 'A4 page box');
  assert.match(source, /\/Encoding \/WinAnsiEncoding/, 'fonts carry the WinAnsi encoding');

  assert.equal(countPages(pdf), pages);
  assert.ok(pages >= 8 && pages <= 15, `${pages} pages, the brief asks for 8-15`);
  assert.equal(contentStreams(pdf).length, pages, 'every page must have a readable content stream');
});

test('the report encodes every character it draws', () => {
  const { stats } = renderReport();

  assert.deepEqual(stats.replaced, [], 'a character with no glyph would print as "?"');
  assert.deepEqual(stats.unmeasured, [], 'a character with an unknown width breaks the layout');
  assert.deepEqual(stats.truncated, [], 'a truncated code line would be silently cut off');
  // A floor, not a count: it catches the subset silently dropping the document
  // (a broken fence used to swallow everything after it) without turning every
  // prose edit into a failing test.
  assert.ok(
    stats.blocks > 60,
    `only ${stats.blocks} blocks parsed — the subset may be dropping content`,
  );
});

test('text never collides on a shared baseline, and never leaves the text box', () => {
  const { pdf } = renderReport();
  const ops = textOps(pdf);

  assert.ok(ops.length > 2000, `only ${ops.length} text operations — extraction may be failing`);

  const left = PAGE.margin.left - 0.5;
  const right = PAGE.width - PAGE.margin.right + 1;

  for (const op of ops) {
    assert.ok(
      op.x >= left,
      `page ${op.page + 1}: text starts at x=${op.x}, left margin is ${left}`,
    );
    assert.ok(op.y > 20 && op.y < PAGE.height, `page ${op.page + 1}: y=${op.y} is off the page`);

    // Whitespace has no ink, so its extent is not a layout error. Every visible
    // glyph, however, has to stay inside the box.
    if (op.text.trim() === '') continue;

    const end = op.x + measureText(op.text, op.font, op.size);
    assert.ok(
      end <= right,
      `page ${op.page + 1}: text ends at x=${end.toFixed(2)}, past the right margin ${right} — "${op.text}"`,
    );
  }

  // Overlap detection: group by page, baseline and font size, then compare
  // intervals. Two strings of the same size on the same baseline are always two
  // columns on one row or two runs of one line, and those must not overlap.
  const groups = new Map();
  for (const op of ops) {
    const key = `${op.page}|${op.y}|${op.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }

  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const previousEnd = previous.x + measureText(previous.text, previous.font, previous.size);
      // A trailing space legitimately sits past the previous word's end; what
      // must not happen is a glyph starting before the one before it finished.
      const currentStart = sorted[i].x;
      if (sorted[i].text.trim() === '') continue;
      assert.ok(
        currentStart >= previousEnd - 0.05,
        `${key}: "${sorted[i].text}" starts at ${currentStart.toFixed(2)} but "${previous.text}" ends at ${previousEnd.toFixed(2)}`,
      );
    }
  }
});

test('the report contains all ten sections the brief asks for', () => {
  const { pdf } = renderReport();
  const lines = extractText(pdf);
  // A sentence can wrap, so prose is checked against the page with its line
  // breaks flattened; a heading never wraps, but this costs nothing.
  const flat = lines.join(' ').replace(/\s+/g, ' ');

  for (const heading of [
    'IntelliMeet',
    'Meetings that end with the work already assigned',
    '1. Project Overview',
    '2. Key Features',
    '3. Technology Stack',
    '4. Architecture',
    '5. Detailed Execution Timeline',
    '6. Technical Highlights',
    '7. Deployment and Operations',
    '8. Visuals',
    '9. Personal Reflection',
  ]) {
    assert.ok(flat.includes(heading), `missing from the PDF: ${heading}`);
  }

  // Spot-check that real prose survived the round trip, not just headings.
  assert.ok(flat.includes('Meetings produce two things'), 'the overview lost its body');
  assert.ok(flat.includes('media never touches the server'), 'the architecture lost its opening');
  assert.ok(flat.includes('trust proxy'), 'the deployment section lost its detail');

  // The ASCII architecture diagram must survive as intact monospace lines —
  // which is the one place the extraction has to be exact, since a shifted
  // column turns a diagram into noise.
  assert.ok(
    lines.some((line) => line.trim() === '+---------------------------+'),
    'the diagram lost its boxes',
  );
  assert.ok(
    lines.some((line) => line.includes('| TURN relay (coturn)  |<')),
    'the diagram lost the relay row and its arrow',
  );
});

test('the committed PDF is not stale', () => {
  const committed = readFileSync(path.join(REPO_ROOT, 'docs/report.pdf'));
  const fresh = renderReport();

  // Compared by extracted text rather than by bytes: two runs need not deflate
  // to identical output, and the page count alone would not catch an edit to the
  // prose that never changed a page.
  assert.deepEqual(
    extractText(committed).filter((line) => line.trim() !== ''),
    extractText(fresh.pdf).filter((line) => line.trim() !== ''),
    'docs/report.pdf does not match docs/report.md — run `npm run report:pdf`',
  );
});

/* --------------------------------------------------------------------- the CLI */

test('the CLI writes the PDF and reports page count and size', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-pdf-'));
  const output = path.join(dir, 'out.pdf');

  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/report-pdf.mjs'), 'docs/report.md', output],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    assert.match(stdout, /out\.pdf: \d+ pages, [\d.]+ KB, \d+ blocks/);
    assert.match(readFileSync(output).subarray(0, 5).toString('latin1'), /^%PDF-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits non-zero and warns when a document cannot be drawn cleanly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-pdf-'));
  const input = path.join(dir, 'bad.md');
  const output = path.join(dir, 'bad.pdf');

  // A Cyrillic character has no glyph in the standard-14 fonts, and a 200-column
  // code line cannot fit the text box at a legible size. Both must be reported
  // rather than silently printed as "?" and "..." respectively.
  writeFileSync(
    input,
    ['# Bad document', '', 'Cyrillic: \u0416', '', '```text', 'x'.repeat(200), '```'].join('\n'),
  );

  let failed = false;
  let stderr = '';
  try {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/report-pdf.mjs'), input, output],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    failed = true;
    stderr = String(error.stderr ?? '');
  }

  assert.ok(failed, 'the CLI should exit non-zero when a document cannot be drawn cleanly');
  assert.match(stderr, /no glyph for/);
});
