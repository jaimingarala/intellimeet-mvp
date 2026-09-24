require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const { logDeploymentWarnings, trustProxySetting } = require('./config/deployment');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const meetingRoutes = require('./routes/meetings');
const { registerSocketHandlers } = require('./socket');
const { startGuestRetention, retentionMs, intervalMs } = require('./services/guestRetention');

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',');

// Behind a platform proxy every request arrives *from* the proxy, so without
// this `req.ip` is the proxy's address: the IP-keyed rate limiters then share
// one budget across every visitor, and about thirty demo clicks in fifteen
// minutes is enough to stop the demo path answering. On by default in
// production, overridable with TRUST_PROXY — see config/deployment.js.
app.set('trust proxy', trustProxySetting());

app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'intellimeet-api', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/admin', adminRoutes);

// 404 + error handling
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, credentials: true },
});
registerSocketHandlers(io);

const PORT = process.env.PORT || 5000;

async function start() {
  // Say what is wrong with this deployment in the boot log, where deploy output
  // is actually read, rather than letting a visitor be the one to find out.
  // Silent outside production, and never fatal: a health check that fails takes
  // the whole demo down, which is worse than the misconfiguration it reports.
  logDeploymentWarnings();

  await connectDB();
  server.listen(PORT, () => {
    console.log(`[server] IntellMeet API + Socket.io listening on port ${PORT}`);
  });

  // Throwaway demo guests accumulate one user + one room per visit; sweep them.
  // Started after listen so tests can boot the real entry point without the
  // sweep querying their in-memory models (GUEST_RETENTION_ENABLED=false).
  if (startGuestRetention()) {
    console.log(
      `[guestRetention] guest data older than ${retentionMs() / 3_600_000}h is removed every ${
        intervalMs() / 60_000
      }min`
    );
  }
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
