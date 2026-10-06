/**
 * Guards the promise that a fresh clone can be configured from the example
 * files, which is the difference between "easy local setup" as a claim and as a
 * fact.
 *
 * Both failure directions are silent in the ordinary workflow:
 *
 *   - A variable the code reads but the example file does not mention is one a
 *     reader sets to the wrong value, or never sets, and the symptom is a
 *     feature quietly not working.
 *   - A variable the example file mentions but nothing reads looks deliberate:
 *     someone will spend an afternoon configuring it. (`CLIENT_ORIGIN` for a
 *     variable that was renamed, `LOG_FORMAT` for one whose reader moved.)
 *
 * So this walks the source for environment reads and compares the two sets in
 * both directions. It reads the files as text, because parsing JavaScript to
 * find out what it reads is exactly the kind of cleverness that gets it wrong.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Read in every environment, set by the platform or the shell rather than by
 * anyone editing a `.env`: `NODE_ENV` is what a host sets, `NO_COLOR` is a
 * convention for terminal output, and the tooling's own variables (`API_URL`,
 * `DEMO_*`, `TURN_AUTH_SECRET`) are passed on the command line because they
 * describe *where to point at*, not how this application runs.
 */
const NOT_A_SETTING = new Set([
  'NODE_ENV',
  'NO_COLOR',
  'API_URL',
  'DEMO_API_URL',
  'DEMO_CLIENT_URL',
  'TURN_AUTH_SECRET',
]);

/** Vite's own build-time values, replaced at compile time and never configured. */
const VITE_BUILT_IN = new Set(['MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

/**
 * Names the server reads. `process.env.X` is the direct form; `env.X` is the
 * form the pure configuration helpers take, where `env = process.env` is the
 * default argument — so any file that mentions `process.env` has its `env.`
 * accesses counted too. `envFlag('NAME')` carries the name as a string, because
 * that is how a boolean knob is read.
 */
export function serverEnvReads(root = REPO_ROOT) {
  const reads = new Map();

  for (const file of walk(path.join(root, 'server/src'))) {
    const source = readFileSync(file, 'utf8');
    const keep = (name) => {
      if (!reads.has(name)) reads.set(name, path.relative(root, file).split(path.sep).join('/'));
    };

    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keep(match[1]);
    for (const match of source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) keep(match[1]);
    for (const match of source.matchAll(/envFlag\(\s*['"]([A-Z0-9_]+)['"]/g)) keep(match[1]);

    if (source.includes('process.env')) {
      for (const match of source.matchAll(/(?<!process)\benv\.([A-Z][A-Z0-9_]+)/g)) keep(match[1]);
    }
  }

  return reads;
}

/** Names the client reads, which Vite inlines at build time. */
export function clientEnvReads(root = REPO_ROOT) {
  const reads = new Map();

  for (const file of walk(path.join(root, 'client/src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
      const name = match[1];
      if (!reads.has(name)) reads.set(name, path.relative(root, file).split(path.sep).join('/'));
    }
  }

  return reads;
}

/** Keys assigned in an example file, ignoring the commented-out examples. */
export function documented(file) {
  const names = new Set();

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }

  return names;
}

function compare(kind, reads, examples, ignore) {
  const documentedNames = documented(path.join(REPO_ROOT, examples));
  const undocumented = [...reads.keys()].filter(
    (name) => !documentedNames.has(name) && !ignore.has(name),
  );
  const unused = [...documentedNames].filter((name) => !reads.has(name));

  assert.deepEqual(
    undocumented.map((name) => `${name} (read in ${reads.get(name)})`),
    [],
    `${kind}: these are read by the code but missing from ${examples}`,
  );
  assert.deepEqual(unused, [], `${kind}: these are in ${examples} but nothing reads them`);
}

test('every server variable the code reads is documented, and the rest are not', () => {
  compare('server', serverEnvReads(), 'server/.env.example', NOT_A_SETTING);
});

test('every client variable the code reads is documented, and the rest are not', () => {
  compare('client', clientEnvReads(), 'client/.env.example', VITE_BUILT_IN);
});

test('the server example covers the deployment surface the README promises', () => {
  // Named individually rather than wholesale, because these are the settings a
  // deployment gets wrong, and the example file is where they are explained.
  const names = documented(path.join(REPO_ROOT, 'server/.env.example'));

  for (const name of [
    'MONGO_URI',
    'JWT_SECRET',
    'CLIENT_ORIGIN',
    'APP_BASE_URL',
    'TRUST_PROXY',
    'ADMIN_TOKEN',
    'MAIL_WEBHOOK_URL',
    'DEMO_LOGIN_ENABLED',
    'GUEST_RETENTION_ENABLED',
  ]) {
    assert.ok(names.has(name), `server/.env.example no longer documents ${name}`);
  }
});

test('each example file explains what it lists rather than only listing it', () => {
  for (const file of ['server/.env.example', 'client/.env.example']) {
    const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    const assignments = lines.filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line.trim()));
    const comments = lines.filter((line) => line.trim().startsWith('#'));

    assert.ok(
      comments.length >= assignments.length,
      `${file} has ${assignments.length} settings but only ${comments.length} lines of explanation`,
    );
  }
});
