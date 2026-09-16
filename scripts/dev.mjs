#!/usr/bin/env node
/**
 * Starts the whole stack with one command: MongoDB (starting a local mongod only
 * if nothing is already listening), the API, and the Vite dev server.
 *
 * Why this exists: MongoDB has to be up before the API, and the API and client
 * each need to know the other's port — which is also why a second copy of the
 * stack fighting over port 5000 used to mean hand-editing env files. The launcher
 * resolves both ports, wires them into the two processes, and gives the terminal
 * one prefixed output stream and one Ctrl+C.
 *
 * Dependency-free on purpose, for the same reason roomCode.js is: nothing should
 * need installing before the app can start.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const clientDir = path.join(root, 'client');
const mongoDataDir = path.join(root, '.data', 'mongodb');

const DEFAULT_API_PORT = 5000;
const DEFAULT_WEB_PORT = 5173;

// --- console helpers ---------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const color = {
  mongo: (s) => paint('36', s),
  api: (s) => paint('35', s),
  web: (s) => paint('32', s),
  ok: (s) => paint('32', s),
  warn: (s) => paint('33', s),
  dim: (s) => paint('2', s),
};

const say = (line = '') => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- small utilities ---------------------------------------------------------

/** Minimal KEY=value reader — enough for these .env files, and no dependency. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Can we bind this port? Mirrors what Express/Vite will try to do. */
function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

/** Is something already accepting connections there? */
function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitUntilListening(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await canConnect(host, port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  return false;
}

/**
 * A usable fixed port, or null. `PORT=0` is a real thing to inherit from a
 * shell, and it means "any free port" to a server — but the client has to be
 * told a specific one, so the launcher needs a port it can actually name.
 */
function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function pickPort(preferred, label) {
  if (await canListen(preferred)) return preferred;
  for (let candidate = preferred + 1; candidate < preferred + 50; candidate += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(candidate)) {
      say(`${color.warn('!')} port ${preferred} is taken — using ${candidate} for the ${label}`);
      return candidate;
    }
  }
  throw new Error(`no free port near ${preferred} for the ${label}`);
}

function findMongod() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mongod'], {
    encoding: 'utf8',
  });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  // Windows installs aren't always on PATH; take the newest version present.
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\MongoDB\\Server';
    if (existsSync(base)) {
      for (const version of readdirSync(base).sort().reverse()) {
        const candidate = path.join(base, version, 'bin', 'mongod.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// --- child processes ---------------------------------------------------------

const children = [];
let mongodChild = null;
let shuttingDown = false;

function prefixStream(stream, tag) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) say(`${tag} ${line}`);
  });
  stream.on('end', () => {
    if (buffered) say(`${tag} ${buffered}`);
  });
}

/** SIGTERM doesn't reach grandchildren (node --watch, npm) on Windows, so kill the tree. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function startProcess({ label, tag, command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const prefix = tag(label.padEnd(5));
  prefixStream(child.stdout, prefix);
  prefixStream(child.stderr, prefix);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    say('');
    if (code === 0) {
      say(`${color.warn('!')} ${label} exited — stopping the rest of the stack.`);
      shutdown(0);
    } else {
      say(`${color.warn('!')} ${label} stopped unexpectedly (code ${code}, signal ${signal}).`);
      shutdown(1);
    }
  });

  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (children.length || mongodChild) say(color.dim('Shutting down…'));
  for (const child of children) killTree(child);
  if (mongodChild) killTree(mongodChild);
  setTimeout(() => process.exit(exitCode), 400).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// --- MongoDB -----------------------------------------------------------------

function parseMongoUri(uri) {
  if (!uri) return { kind: 'missing' };
  if (!uri.startsWith('mongodb://')) return { kind: 'remote' }; // mongodb+srv:// (Atlas)
  const match = uri.match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/);
  if (!match) return { kind: 'remote' };
  const hosts = match[1].split(',');
  if (hosts.length > 1) return { kind: 'remote' };
  const [host, port] = hosts[0].split(':');
  if (!/^(127\.0\.0\.1|localhost)$/.test(host)) return { kind: 'remote', host };
  return { kind: 'local', host, port: Number(port || 27017) };
}

async function ensureMongo(uri) {
  const mongo = parseMongoUri(uri);

  if (mongo.kind === 'missing') {
    say(`${color.warn('!')} server/.env has no MONGO_URI — the API will fail to start.`);
    return;
  }
  if (mongo.kind === 'remote') {
    say(
      `${color.mongo('mongo')} using the MongoDB from server/.env (remote${
        mongo.host ? `: ${mongo.host}` : ''
      })`
    );
    return;
  }

  if (await canConnect(mongo.host, mongo.port)) {
    say(`${color.mongo('mongo')} already running at ${mongo.host}:${mongo.port}`);
    return;
  }

  const mongod = findMongod();
  if (!mongod) {
    say('');
    say(`✖ MongoDB isn't reachable at ${mongo.host}:${mongo.port}, and no \`mongod\` binary was found.`);
    say('  Either start MongoDB (or the "MongoDB Server" service), or point MONGO_URI in');
    say('  server/.env at a hosted cluster (e.g. MongoDB Atlas).');
    say('');
    process.exit(1);
  }

  say(`${color.mongo('mongo')} nothing on ${mongo.host}:${mongo.port} — starting mongod`);
  say(color.dim(`      data: ${path.relative(root, mongoDataDir)}`));
  mkdirSync(mongoDataDir, { recursive: true });
  const mongodLog = path.join(mongoDataDir, 'mongod.log');

  mongodChild = startProcess({
    label: 'mongo',
    tag: color.mongo,
    command: mongod,
    args: [
      '--dbpath',
      mongoDataDir,
      '--port',
      String(mongo.port),
      '--bind_ip',
      mongo.host,
      '--quiet',
      // mongod is chatty enough to bury the other two processes; send it to a
      // file and just tell the user where it is.
      '--logpath',
      mongodLog,
    ],
    cwd: root,
  });

  if (!(await waitUntilListening(mongo.host, mongo.port, 30000))) {
    say(
      `${color.warn('!')} mongod did not start listening within 30s — see ${path.relative(
        root,
        mongodLog
      )}`
    );
    shutdown(1);
    return;
  }
  say(`${color.mongo('mongo')} mongod ready ${color.dim(`(log: ${path.relative(root, mongodLog)})`)}`);
}

// --- preflight ---------------------------------------------------------------

function ensureEnvFile(dir, note) {
  const file = path.join(dir, '.env');
  if (existsSync(file)) return;
  const example = path.join(dir, '.env.example');
  if (!existsSync(example)) return;
  copyFileSync(example, file);
  say(`${color.warn('!')} created ${path.relative(root, file)} from .env.example — ${note}`);
}

function requireInstalled(dir) {
  if (existsSync(path.join(dir, 'node_modules'))) return true;
  say('');
  say(`✖ ${path.relative(root, dir)}/node_modules is missing.`);
  say('  Run: npm run setup');
  say('');
  process.exit(1);
  return false;
}

// --- main --------------------------------------------------------------------

async function main() {
  say('');
  say(`  ${paint('1', 'IntellMeet')} ${color.dim('— starting MongoDB, the API and the client')}`);
  say('');

  ensureEnvFile(serverDir, 'set a real JWT_SECRET before this goes anywhere public.');
  ensureEnvFile(clientDir, 'only needed if you also run the client on its own.');
  requireInstalled(serverDir);
  requireInstalled(clientDir);

  const fileEnv = readEnvFile(path.join(serverDir, '.env'));
  // Real environment variables win over the file, exactly like dotenv does, so
  // `MONGO_URI=... npm run dev` can point at another database for a one-off run.
  const mongoUri = process.env.MONGO_URI || fileEnv.MONGO_URI;
  if (process.env.PORT !== undefined && !parsePort(process.env.PORT)) {
    say(
      `${color.warn('!')} ignoring PORT=${process.env.PORT} from the shell — the client has to be ` +
        'told a specific port, so the launcher picks one it can name'
    );
  }
  const preferredApiPort = parsePort(process.env.PORT) ?? parsePort(fileEnv.PORT) ?? DEFAULT_API_PORT;
  const preferredWebPort = parsePort(fileEnv.WEB_PORT) ?? DEFAULT_WEB_PORT;

  await ensureMongo(mongoUri);

  const apiPort = await pickPort(preferredApiPort, 'API');
  const webPort = await pickPort(preferredWebPort, 'client');

  // The client needs the API's real port, and the API needs the client's origin
  // for CORS — passing both here is what removes the manual port juggling.
  const apiOrigin = `http://localhost:${apiPort}`;
  const webOrigin = `http://localhost:${webPort}`;

  startProcess({
    label: 'api',
    tag: color.api,
    command: process.execPath, // node --watch replaces nodemon, and is one process to kill
    args: ['--watch', 'src/index.js'],
    cwd: serverDir,
    env: { PORT: String(apiPort), CLIENT_ORIGIN: webOrigin },
  });

  startProcess({
    label: 'web',
    tag: color.web,
    command: process.execPath,
    args: [path.join(clientDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(webPort), '--strictPort'],
    cwd: clientDir,
    env: { VITE_API_URL: apiOrigin },
  });

  if (!(await waitUntilListening('127.0.0.1', apiPort, 20000))) {
    say(`${color.warn('!')} the API did not come up on ${apiOrigin} — see its output above.`);
    shutdown(1);
    return;
  }

  say('');
  say(`  ${color.dim('API')}      ${apiOrigin}/api/health`);
  say(`  ${color.dim('Web')}      ${webOrigin}`);
  say(
    `  ${color.dim('MongoDB')}  ${
      mongoUri ? mongoUri.replace(/\/\/[^@]*@/, '//***@').replace(/\?.*$/, '') : 'not configured'
    }`
  );
  say(`  ${color.dim('─'.repeat(46))}`);
  say(`  ${color.ok('ready')} ${color.dim('— press Ctrl+C to stop everything')}`);
  say('');
}

main().catch((err) => {
  say(`${color.warn('!')} ${err.message}`);
  shutdown(1);
});
