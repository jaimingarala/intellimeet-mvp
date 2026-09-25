#!/usr/bin/env node
/**
 * Turn a CI job's test output into the Markdown block that goes on the run page.
 *
 * Why this exists: GitHub serves job *logs* only to an authenticated request, but
 * a step summary is public alongside the run. So the numbers a reviewer actually
 * wants — how many tests ran, how many failed, and what the coverage is — are
 * readable from the run page with no token and no download, including on a red
 * run, which is exactly when someone is looking.
 *
 * It parses rather than measures: the job runs the tests, `tee`s the output to a
 * file, and this reads that file. It has no dependencies because the `scripts`
 * CI job deliberately installs nothing, and it writes to stdout so the workflow
 * does the `>> "$GITHUB_STEP_SUMMARY"` plumbing and this stays testable.
 *
 * Usage: node scripts/ci-summary.mjs <server|client|scripts> <logfile>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const number = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Vitest paints its summary lines with ANSI escapes even when its output is
 * piped to a file, which puts an escape sequence where a line anchor expects to
 * find the start of one. Stripping first is what makes the parse work on the
 * real log rather than only on a fixture.
 */
const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

/**
 * The coverage floors, read from the place that enforces them rather than
 * restated here: a summary that disagrees with the gate is worse than no summary.
 * The client's floors live in a JS config that cannot be imported without
 * installing Vitest, so it is read as text and the summary degrades to no floor
 * column if that ever stops matching.
 */
export function readFloors(kind, root = REPO_ROOT) {
  const none = { lines: null, branches: null, functions: null };

  try {
    if (kind === 'server') {
      const { scripts = {} } = JSON.parse(
        readFileSync(path.join(root, 'server/package.json'), 'utf8'),
      );
      const script = scripts['test:coverage'] || '';
      const flag = (name) => {
        const match = script.match(new RegExp(`--test-coverage-${name}=(\\d+(?:\\.\\d+)?)`));
        return number(match?.[1] ?? null);
      };
      return { lines: flag('lines'), branches: flag('branches'), functions: flag('functions') };
    }

    if (kind === 'client') {
      const config = readFileSync(path.join(root, 'client/vitest.config.js'), 'utf8');
      const threshold = (name) => {
        const match = config.match(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)`));
        return number(match?.[1] ?? null);
      };
      return {
        lines: threshold('lines'),
        branches: threshold('branches'),
        functions: threshold('functions'),
      };
    }
  } catch {
    // Unreadable or reshaped config: report the numbers without the floors.
  }
  return none;
}

/** `node --test` output: the same shape with or without `--experimental-test-coverage`. */
export function parseNodeTest(text) {
  const counts = (label) => {
    const match = text.match(new RegExp(`^# ${label} (\\d+)`, 'm'));
    return number(match?.[1] ?? null);
  };

  // Node's coverage table: `# all files  | line % | branch % | funcs %`.
  const coverageLine = text.match(
    /^#\s+all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m,
  );

  // A float: the runner reports `# duration_ms 16766.88`, and truncating it to
  // whole milliseconds would round 421.5ms down to 421ms.
  const durationMs = text.match(/^# duration_ms ([\d.]+)/m)?.[1];

  return {
    tests: counts('tests'),
    passed: counts('pass'),
    failed: counts('fail'),
    skipped: counts('skipped'),
    durationMs: number(durationMs ?? null),
    coverage: coverageLine
      ? {
          lines: number(coverageLine[1]),
          branches: number(coverageLine[2]),
          functions: number(coverageLine[3]),
        }
      : null,
    failures: [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim()),
  };
}

/** Vitest's summary block, which reports the same things in different words. */
export function parseVitest(text) {
  const summary = text.match(/^\s*Tests\s+(.+)$/m)?.[1] || '';
  const countIn = (word) => number(summary.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? null);

  const files = text.match(/^\s*Test Files\s+(.+)$/m)?.[1] || '';
  // Vitest prints `910ms` or `1.68s`, then a parenthetical breakdown of where
  // the time went, so the line is matched without anchoring its end.
  const duration = text.match(/^\s*Duration\s+([\d.]+)(ms|s)\b/m);
  const durationMs = duration ? number(duration[1]) * (duration[2] === 's' ? 1000 : 1) : null;

  // `All files | % Stmts | % Branch | % Funcs | % Lines`.
  const coverageLine = text.match(
    /^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m,
  );

  return {
    tests: number(summary.match(/\((\d+)\)/)?.[1] ?? null),
    passed: countIn('passed') ?? (/no tests/.test(summary) ? 0 : null),
    failed: countIn('failed') ?? 0,
    skipped: countIn('skipped') ?? 0,
    filesPassed: number(files.match(/(\d+) passed/)?.[1] ?? null),
    filesFailed: number(files.match(/(\d+) failed/)?.[1] ?? null),
    durationMs,
    coverage: coverageLine
      ? {
          lines: number(coverageLine[4]),
          branches: number(coverageLine[2]),
          functions: number(coverageLine[3]),
        }
      : null,
    // `FAIL  test/export.test.js > naming the exported file > does not repeat...`
    failures: [...text.matchAll(/^\s*FAIL\s+(.+?)\s*>\s*(.+)$/gm)].map(
      ([, file, name]) => `${file.trim()} > ${name.trim()}`,
    ),
  };
}

const money = (n, suffix = '') => (n === null ? '?' : `${n}${suffix}`);

function duration(ms) {
  if (ms === null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function coverageTable(coverage, floors) {
  // A floor we could not read is not a floor of zero: show no column rather
  // than a comparison the reader would trust and the gate does not enforce.
  const known = (value) => (Number.isFinite(value) ? value : null);
  const row = (name, value, floor) =>
    `| ${name} | ${money(value, '%')} |${known(floor) === null ? '' : ` ${floor}%`} |`;
  const hasFloors = [floors.lines, floors.branches, floors.functions].some(
    (floor) => known(floor) !== null,
  );

  return [
    `| Metric | Coverage |${hasFloors ? ' Floor |' : ''}`,
    `| --- | --- |${hasFloors ? ' --- |' : ''}`,
    row('Lines', coverage.lines, floors.lines),
    row('Branches', coverage.branches, floors.branches),
    row('Functions', coverage.functions, floors.functions),
  ].join('\n');
}

function failureList(failures) {
  const shown = failures.slice(0, 10);
  const more = failures.length - shown.length;
  const lines = shown.map((name) => `- \`${name}\``);
  if (more > 0) lines.push(`- …and ${more} more`);
  return `**Failing**\n\n${lines.join('\n')}`;
}

/**
 * The Markdown for one job. A log with nothing recognisable in it says so rather
 * than reporting zeroes: a crashed job that "passed 0 tests" is a lie a summary
 * should not tell.
 */
export function formatSummary(kind, text, { floors = readFloors(kind) } = {}) {
  const label = { server: 'Server', client: 'Client', scripts: 'Scripts' }[kind];
  if (!label) throw new Error(`unknown job kind: ${kind}`);

  const plain = stripAnsi(text);
  const result = kind === 'client' ? parseVitest(plain) : parseNodeTest(plain);
  const counted = result.tests !== null || result.passed !== null;

  if (!counted && result.failures.length === 0) {
    return [
      `### ${label} — no test summary in the output`,
      '',
      'The job did not reach a test summary, which usually means it failed before the',
      'suite ran (an install or config error, or a crash at import time). Open the job log.',
      '',
    ].join('\n');
  }

  // A run that died mid-flight can name its failures without ever printing a
  // summary line. Report what it did say rather than calling the whole thing blank.
  if (!counted) {
    return [
      `### ${label} — the run ended before a summary line, ${result.failures.length} failing`,
      '',
      failureList(result.failures),
      '',
    ].join('\n');
  }

  const bits = [];
  if (result.tests !== null) bits.push(`${result.tests} test${result.tests === 1 ? '' : 's'}`);
  if (result.passed !== null) bits.push(`${result.passed} passed`);
  if (result.failed) bits.push(`${result.failed} failed`);
  if (result.skipped) bits.push(`${result.skipped} skipped`);
  const elapsed = duration(result.durationMs);
  if (elapsed) bits.push(elapsed);

  const sections = [`### ${label} — ${bits.join(' · ')}`, ''];

  if (kind === 'client' && (result.filesPassed !== null || result.filesFailed !== null)) {
    sections.push(
      `Test files: ${result.filesPassed ?? 0} passed${result.filesFailed ? `, ${result.filesFailed} failed` : ''}.`,
      '',
    );
  }

  if (result.failures.length > 0) sections.push(failureList(result.failures), '');

  if (result.coverage) {
    sections.push(coverageTable(result.coverage, floors), '');
  } else {
    sections.push('_No coverage table in this job._', '');
  }

  return sections.join('\n');
}

function main() {
  const [kind, logPath] = process.argv.slice(2);

  if (!kind || !logPath) {
    console.error('usage: node scripts/ci-summary.mjs <server|client|scripts> <logfile>');
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    // The job may have failed before anything was written. Say so in the summary
    // rather than failing the summary step on top of it.
    console.log(`### Job produced no log at \`${logPath}\`\n`);
    return;
  }

  console.log(formatSummary(kind, text));
}

// Only run when invoked, so the suite can import the parsers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
