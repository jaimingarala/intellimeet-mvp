// Shared WebRTC helpers: ICE server configuration + reliable signalling.

// Public STUN is enough to discover a peer's address, but it cannot relay
// media. Two peers behind strict/symmetric NATs can only reach each other
// through TURN, so production deployments should point the VITE_TURN_* vars
// below at a relay (coturn, Twilio, Metered, ...).
const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];

function parseUrlList(value) {
  return String(value || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * Build the `iceServers` list for a new RTCPeerConnection from Vite env vars:
 *   VITE_STUN_URLS      comma-separated (default: Google's public STUN)
 *   VITE_TURN_URLS      comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
 *   VITE_TURN_USERNAME  TURN credential username
 *   VITE_TURN_CREDENTIAL TURN credential password
 *
 * These values ship to the browser, so they are not secret. For a public TURN
 * server prefer short-lived credentials minted by the backend (coturn's
 * `use-auth-secret` REST API) over a long-lived static password.
 */
export function getIceServers() {
  const stunUrls = parseUrlList(import.meta.env.VITE_STUN_URLS);
  const iceServers = [{ urls: stunUrls.length ? stunUrls : DEFAULT_STUN_URLS }];

  const turnUrls = parseUrlList(import.meta.env.VITE_TURN_URLS);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME || undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL || undefined,
    });
  }

  return iceServers;
}

/** Whether a TURN relay is configured at all. */
export function hasTurnConfigured() {
  return parseUrlList(import.meta.env.VITE_TURN_URLS).length > 0;
}

/**
 * Which candidates ICE is allowed to use.
 *
 *   VITE_ICE_TRANSPORT_POLICY=relay
 *
 * restricts gathering to relay candidates, so media can only ever travel
 * through the configured TURN server. That is what turns "the call connected"
 * into "the call connected *through TURN*" — proof of the relay path without
 * inspecting packets. Leave it unset for normal use, where a direct peer-to-peer
 * path is cheaper and lower latency; `relay` requires working TURN credentials.
 */
export function getIceTransportPolicy() {
  const raw = String(import.meta.env.VITE_ICE_TRANSPORT_POLICY || '')
    .trim()
    .toLowerCase();
  return raw === 'relay' ? 'relay' : 'all';
}

/**
 * Read the live candidate pair off a connection and say whether media is going
 * through a relay. Returns null until ICE has nominated a pair.
 */
export async function describeSelectedPath(pc) {
  const stats = await pc.getStats();

  let pair = null;
  stats.forEach((report) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId) || pair;
    }
  });
  if (!pair) {
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
        pair = report;
      }
    });
  }
  if (!pair) return null;

  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  const localType = local?.candidateType;
  const remoteType = remote?.candidateType;

  return {
    relayed: localType === 'relay' || remoteType === 'relay',
    localType,
    remoteType,
  };
}

// Ice candidates are only valid to add once the remote description is set.
// In a mesh call they routinely arrive early -- the offerer trickles its
// candidates while the answerer is still applying the offer -- so they have to
// be buffered per connection instead of dropped.
function candidateQueue(pc) {
  if (!pc.pendingIceCandidates) {
    pc.pendingIceCandidates = [];
  }
  return pc.pendingIceCandidates;
}

/**
 * Apply a remote SDP (offer or answer) and then drain any ICE candidates that
 * arrived while we were waiting for it.
 */
export async function applyRemoteDescription(pc, sdp) {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPendingIceCandidates(pc);
}

/**
 * Add a remote ICE candidate, or queue it until the remote description lands.
 */
export async function addOrQueueIceCandidate(pc, candidateInit) {
  const candidate = new RTCIceCandidate(candidateInit);
  if (!pc.remoteDescription) {
    candidateQueue(pc).push(candidate);
    return;
  }
  await pc.addIceCandidate(candidate);
}

/**
 * Add every buffered candidate in arrival order. Safe to call repeatedly.
 */
export async function flushPendingIceCandidates(pc) {
  if (!pc.pendingIceCandidates?.length) return;

  const queued = pc.pendingIceCandidates;
  pc.pendingIceCandidates = [];

  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      // A single bad candidate shouldn't abort the rest of the queue.
      console.error('Failed to add queued ICE candidate', err);
    }
  }
}
