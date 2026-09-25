require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const { allowedOrigins, logDeploymentWarnings, trustProxySetting } = require('./config/deployment');
const { log } = require('./lib/logger');
const {
  errorHandler,
  notFoundHandler,
  requestContext,
  requestLogger,
} = require('./middleware/observability');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const meetingRoutes = require('./routes/meetings');
const { registerSocketHandlers } = require('./socket');
const { startGuestRetention, retentionMs, intervalMs } = require('./services/guestRetention');

const app = express();
const server = http.createServer(app);

// A wildcard is stripped here rather than passed to CORS — see
// config/deployment.js `allowedOrigins`, which also warns about it at boot.
const CLIENT_ORIGIN = allowedOrigins().origins;

// Behind a platform proxy every request arrives *from* the proxy, so without
// this `req.ip` is the proxy's address: the IP-keyed rate limiters then share
// one budget across every visitor, and about thirty demo clicks in fifteen
// minutes is enough to stop the demo path answering. On by default in
// production, overridable with TRUST_PROXY — see config/deployment.js.
app.set('trust proxy', trustProxySetting());

// Before everything else, so the id exists by the time anything can fail and the
// timing covers the whole request.
app.use(requestContext());
app.use(requestLogger());

app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'intellimeet-api', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/admin', adminRoutes);

// 404 + the single error handler: one shape for every failure, one log line for
// every request, and a stack that stays in the log instead of the response.
app.use(notFoundHandler);
app.use(errorHandler);

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
    log.info('API + Socket.io listening', { port: Number(PORT) });
  });

  // Throwaway demo guests accumulate one user + one room per visit; sweep them.
  // Started after listen so tests can boot the real entry point without the
  // sweep querying their in-memory models (GUEST_RETENTION_ENABLED=false).
  if (startGuestRetention()) {
    log.info('guest retention sweep started', {
      olderThanHours: retentionMs() / 3_600_000,
      everyMinutes: intervalMs() / 60_000,
    });
  }
}

start().catch((err) => {
  log.error('server failed to start', { err });
  process.exit(1);
});
