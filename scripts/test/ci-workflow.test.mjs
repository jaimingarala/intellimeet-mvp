/**
 * Guards on the CI workflow itself, because both of these fail *silently*:
 *
 * 1. A step that pipes the test command through `tee` without `set -o pipefail`
 *    reports `tee`'s exit status, which is always 0 — so a suite with failing
 *    tests leaves the job green. The pipeline is only honest with the flag.
 * 2. Capturing output without publishing a summary puts the numbers back behind
 *    an authenticated log fetch, which is the thing the summary exists to avoid.
 *
 * Both are checked by reading the workflow as text. That is enough here because
 * the file is ours and its shape is small; a real YAML parser would be a
 * dependency in a job that deliberately installs nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);

const LOG_NAME = /\$RUNNER_TEMP\/([\w-]+)\.log/;

/** Steps, split on the `      - ` that begins one. */
const steps = WORKFLOW.split(/\n(?= {6}- )/);

/** Job blocks, split on the two-space keys under `jobs:`. */
const jobs = WORKFLOW.split(/\n(?= {2}[a-z][\w-]*:\n)/);

test('every step that pipes test output outlives the pipeline with pipefail', () => {
  // Filtered on the pipeline, not on the log path: the publish step names the
  // same file without piping anything.
  const capturing = steps.filter((step) => /\| tee /.test(step));
  assert.equal(capturing.length, 3, 'expected the three test jobs to capture output');

  for (const step of capturing) {
    const name = step.match(/- name: (.+)/)?.[1] ?? step.slice(0, 60);
    assert.match(step, /set -o pipefail/, `${name} pipes through tee without pipefail`);
  }
});

test('every job that captures test output publishes it to the run page', () => {
  const capturing = jobs.filter((job) => LOG_NAME.test(job));
  assert.equal(capturing.length, 3, 'expected three test jobs to capture output');

  for (const job of capturing) {
    const name = job.match(/^ {2}([\w-]+):/m)?.[1] ?? 'unknown job';
    const log = job.match(LOG_NAME)[1];

    assert.match(
      job,
      /node scripts\/ci-summary\.mjs \w+ "\$RUNNER_TEMP\//,
      `${name} never runs ci-summary`,
    );
    assert.match(job, /if: always\(\)/, `${name} would skip its summary on the runs that need it`);
    assert.ok(
      job.includes(`"$RUNNER_TEMP/${log}.log" >> "$GITHUB_STEP_SUMMARY"`),
      `${name} does not append its summary to the run page`,
    );
  }
});

/**
 * The publish step writes to a file the runner controls, so it succeeds whether
 * or not it wrote anything useful: a parser handed a log it does not understand
 * exits zero after publishing "no test summary in the output", and the job stays
 * green with nothing on the page. Nothing in the run page reports that, which is
 * why the step has to check its own output — and why this pins the check.
 */
test('every publish step proves its block reached the summary file', () => {
  const publishing = steps.filter((step) => /- name: Publish summary/.test(step));
  assert.equal(publishing.length, 3, 'expected three publish steps');

  for (const step of publishing) {
    const kind = step.match(/ci-summary\.mjs (\w+)/)?.[1];
    assert.ok(kind, 'a publish step does not name the kind to parse');

    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    // A block, so the check runs after the write rather than instead of it.
    assert.match(
      step,
      /run: \|/,
      `${kind}: the publish step is not a block, so its check would not follow the write`,
    );
    assert.match(
      step,
      new RegExp(`grep -q '\\^### ${label}'`),
      `${kind}: nothing fails when the summary block is missing`,
    );
    assert.match(
      step,
      /exit 1/,
      `${kind}: the check does not fail the step when the block is missing`,
    );
  }
});

test('the summary is the job kind whose output was captured', () => {
  for (const job of jobs) {
    const log = job.match(LOG_NAME)?.[1];
    if (!log) continue;
    const kind = job.match(/ci-summary\.mjs (\w+)/)?.[1];
    assert.equal(kind, log.replace(/-tests$/, ''), 'a summary is parsed with the wrong parser');
  }
});
