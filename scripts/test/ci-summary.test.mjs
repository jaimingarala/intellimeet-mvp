import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatSummary,
  parseNodeTest,
  parseVitest,
  readFloors,
  stripAnsi,
} from '../ci-summary.mjs';

/** Real `node --test` output with `--experimental-test-coverage`, trimmed. */
const SERVER_LOG = `
# tests 179
# suites 0
# pass 179
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16766.88
# start of coverage report
# ---------------------------------------------------------------------------
# file                | line % | branch % | funcs % | uncovered lines
# ---------------------------------------------------------------------------
# src/config         |        |          |         |
#   limits.js         | 100.00 |   100.00 |  100.00 |
# ---------------------------------------------------------------------------
# all files           |  91.78 |    86.23 |   94.01 |
# ---------------------------------------------------------------------------
# end of coverage report
`;

/** Real Vitest output, trimmed. */
const CLIENT_LOG = `
 RUN  v3.2.4 /home/runner/work/intellimeet-mvp/client

 Test Files  4 passed (4)
      Tests  40 passed (40)
   Start at  10:04:05
   Duration  910ms (transform 231ms, setup 0ms)

 % Coverage report from v8
-----------------|---------|----------|---------|---------|-------------------
File             | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-----------------|---------|----------|---------|---------|-------------------
All files        |     100 |    95.32 |     100 |     100 |
-----------------|---------|----------|---------|---------|-------------------
`;

/** `node --test` on the scripts suite, which runs without coverage. */
const SCRIPTS_LOG = `
# tests 19
# pass 19
# fail 0
# duration_ms 421.5
`;

test('reads the server counts, duration and coverage', () => {
  const result = parseNodeTest(SERVER_LOG);

  assert.equal(result.tests, 179);
  assert.equal(result.passed, 179);
  assert.equal(result.failed, 0);
  assert.equal(result.durationMs, 16766.88);
  assert.deepEqual(result.coverage, { lines: 91.78, branches: 86.23, functions: 94.01 });
});

test('takes coverage from the all-files row, not a per-file row', () => {
  const result = parseNodeTest(SERVER_LOG.replace(/100\.00/g, '12.34'));
  assert.equal(result.coverage.lines, 91.78);
});

test('reads Vitest counts and remaps its coverage columns', () => {
  const result = parseVitest(CLIENT_LOG);

  assert.equal(result.tests, 40);
  assert.equal(result.passed, 40);
  assert.equal(result.failed, 0);
  assert.equal(result.filesPassed, 4);
  assert.equal(result.durationMs, 910);
  // Vitest prints Stmts | Branch | Funcs | Lines, so lines is the *fourth* column.
  assert.deepEqual(result.coverage, { lines: 100, branches: 95.32, functions: 100 });
});

test('tells a seconds-long Vitest run from a millisecond one', () => {
  const result = parseVitest(CLIENT_LOG.replace('Duration  910ms', 'Duration  1.68s'));
  assert.equal(result.durationMs, 1680);
});

test('parses the coloured output Vitest really writes to a pipe', () => {
  // Copied from a real `vitest run --coverage 2>&1 | tee` log: Vitest paints its
  // summary even when nothing is attached to a terminal, so a line anchor only
  // matches once the escapes are gone. This is the bug the earlier fixture-only
  // suite could not see.
  const coloured = [
    '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m40 passed\u001b[39m\u001b[22m\u001b[90m (40)\u001b[39m',
    '\u001b[2m   Duration \u001b[22m \u001b[1m\u001b[32m1.44s\u001b[39m\u001b[22m\u001b[90m (tests 82ms)\u001b[39m',
    '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m4 passed\u001b[39m\u001b[22m\u001b[90m (4)\u001b[39m',
  ].join('\n');

  const summary = formatSummary('client', coloured, {
    floors: { lines: 95, branches: 90, functions: 95 },
  });

  assert.equal(stripAnsi(coloured).includes('\u001b'), false);
  assert.match(summary, /^### Client — 40 tests · 40 passed · 1\.4s/m);
  assert.match(summary, /Test files: 4 passed\./);
});

test('strips colour from a failure name too', () => {
  const summary = formatSummary(
    'client',
    '\u001b[31mFAIL\u001b[39m  test/webrtc.test.js > \u001b[1msignalling\u001b[22m > drop me\n',
  );
  assert.match(summary, /- `test\/webrtc\.test\.js > signalling > drop me`/);
});

test('a run that died mid-flight still names what failed', () => {
  // No `Tests …` line at all: Vitest was killed or crashed after a failure was
  // reported. The names are the only useful thing in the output, so they survive.
  const summary = formatSummary('client', 'FAIL  test/export.test.js > writing > escapes a pipe\n');

  assert.match(summary, /the run ended before a summary line, 1 failing/);
  assert.match(summary, /- `test\/export\.test\.js > writing > escapes a pipe`/);
  assert.doesNotMatch(summary, /failed before the/);
});

test('reports failures by name, for both runners', () => {
  const node = parseNodeTest(`
# tests 3
# pass 2
# fail 1
not ok 2 - requireAuth rejects a token for a deleted user
`);
  assert.deepEqual(node.failures, ['requireAuth rejects a token for a deleted user']);

  const vitest = parseVitest(`
 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 38 passed (40)
FAIL  test/export.test.js > naming the exported file > does not repeat the prefix
FAIL  test/webrtc.test.js > signalling > drops an oversized payload
`);
  assert.deepEqual(vitest.failures, [
    'test/export.test.js > naming the exported file > does not repeat the prefix',
    'test/webrtc.test.js > signalling > drops an oversized payload',
  ]);
});

test('summarises a green server run with its floors, read from the gate itself', () => {
  const summary = formatSummary('server', SERVER_LOG, {
    floors: { lines: 85, branches: 70, functions: 85 },
  });

  assert.match(summary, /^### Server — 179 tests · 179 passed · 16\.8s/m);
  assert.match(summary, /\| Lines \| 91\.78% \| 85% \|/);
  assert.match(summary, /\| Branches \| 86\.23% \| 70% \|/);
  assert.match(summary, /\| Functions \| 94\.01% \| 85% \|/);
  assert.doesNotMatch(summary, /Failing/);
});

test('the floors it prints are the ones the coverage script enforces', () => {
  // Guards the drift this design exists to prevent: enabling the check below
  // means a floor that moves in package.json moves in the summary with it.
  const floors = readFloors('server');
  assert.deepEqual(floors, { lines: 85, branches: 70, functions: 85 });
  assert.deepEqual(readFloors('client'), { lines: 95, branches: 90, functions: 95 });
});

test('a failing server run leads with the failures', () => {
  const summary = formatSummary(
    'server',
    SERVER_LOG.replace('# pass 179', '# pass 178').replace('# fail 0', '# fail 1') +
      'not ok 7 - POST /api/meetings rejects a title of 121 characters\n',
  );

  assert.match(summary, /### Server — 179 tests · 178 passed · 1 failed/);
  assert.match(
    summary,
    /Failing\*\*\n\n- `POST \/api\/meetings rejects a title of 121 characters`/,
  );
});

test('caps the failure list so one broken helper cannot flood the summary', () => {
  const failures = Array.from({ length: 14 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  const summary = formatSummary(
    'server',
    `# tests 14\n# pass 0\n# fail 14\n${failures.join('\n')}\n`,
  );

  assert.equal(summary.match(/^- `/gm).length, 10);
  assert.match(summary, /…and 4 more/);
});

test('summarises the client run with its test files', () => {
  const summary = formatSummary('client', CLIENT_LOG, {
    floors: { lines: 95, branches: 90, functions: 95 },
  });

  assert.match(summary, /^### Client — 40 tests · 40 passed · 910ms/m);
  assert.match(summary, /Test files: 4 passed\./);
  assert.match(summary, /\| Lines \| 100% \| 95% \|/);
  assert.match(summary, /\| Branches \| 95\.32% \| 90% \|/);
});

test('the scripts job reports counts without inventing a coverage table', () => {
  const summary = formatSummary('scripts', SCRIPTS_LOG);

  assert.match(summary, /^### Scripts — 19 tests · 19 passed · 422ms/m);
  assert.match(summary, /_No coverage table in this job\._/);
  assert.doesNotMatch(summary, /\| Metric \|/);
});

test('omits the floor column when the floors cannot be read', () => {
  const summary = formatSummary('server', SERVER_LOG, { floors: {} });

  assert.match(summary, /\| Metric \| Coverage \|\n\| --- \| --- \|/);
  assert.match(summary, /\| Lines \| 91\.78% \|/);
  assert.doesNotMatch(summary, /% \| 85% \|/);
});

test('a job that never reached the suite says so instead of reporting zeroes', () => {
  const crashed = `
npm error code ELIFECYCLE
npm error command failed
npm error Lifecycle script \`test:coverage\` failed with error:
`;
  const summary = formatSummary('server', crashed);

  assert.match(summary, /no test summary in the output/);
  assert.match(summary, /failed before the\s+suite ran/);
  assert.doesNotMatch(summary, /\b0 passed\b/);
});

test('a missing config is not a crash', () => {
  assert.deepEqual(readFloors('server', '/nonexistent'), {
    lines: null,
    branches: null,
    functions: null,
  });
  assert.deepEqual(readFloors('scripts'), { lines: null, branches: null, functions: null });
});

test('rejects a kind it cannot label', () => {
  assert.throws(() => formatSummary('mystery', SERVER_LOG), /unknown job kind: mystery/);
});

test('the command CI runs publishes a summary, and survives a missing log', () => {
  const script = fileURLToPath(new URL('../ci-summary.mjs', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-summary-'));
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  try {
    const log = path.join(dir, 'server-tests.log');
    writeFileSync(log, SERVER_LOG);
    // This is the exact shape of the workflow step, minus the redirection.
    assert.match(run('server', log), /^### Server — 179 tests · 179 passed/);

    // A job with no log at all still gets a step summary, and the step still passes.
    assert.match(run('server', path.join(dir, 'absent.log')), /Job produced no log at/);

    assert.throws(() => run(), /usage: node scripts\/ci-summary\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
