/**
 * `src/lib/webrtc.js`, which is the client file where a bug costs the most and
 * says the least.
 *
 * ICE servers come from build-time env vars, so a typo in `VITE_TURN_URLS` or a
 * missing relay shows up as "the call just didn't connect" on someone else's
 * machine, with no error anywhere. The candidate queue is the other half: in a
 * mesh call an offer's candidates arrive while the answerer is still applying the
 * offer, and dropping them is exactly the difference between a working call and a
 * call that hangs at "connecting".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  addOrQueueIceCandidate,
  applyRemoteDescription,
  describeSelectedPath,
  flushPendingIceCandidates,
  getIceServers,
  getIceTransportPolicy,
  hasTurnConfigured,
} from '../src/lib/webrtc.js';

/** A stand-in for an RTCStatsReport, which is a Map with forEach. */
function fakeStats(reports) {
  const byId = new Map(reports.map((report) => [report.id, report]));
  return { forEach: (fn) => byId.forEach(fn), get: (id) => byId.get(id) };
}

/** The smallest fake RTCPeerConnection the queue helpers touch. */
function fakePeerConnection({ remoteDescription = null } = {}) {
  return {
    remoteDescription,
    added: [],
    setRemoteDescription(description) {
      this.remoteDescription = description;
      this.applied = description;
    },
    async addIceCandidate(candidate) {
      this.added.push(candidate);
    },
  };
}

// Vitest resolves `import.meta.env` through Vite, which means it reads
// `client/.env` — so a developer with a relay configured locally would get
// different answers than CI. Every case states the environment it is about.
beforeEach(() => {
  for (const name of [
    'VITE_STUN_URLS',
    'VITE_TURN_URLS',
    'VITE_TURN_USERNAME',
    'VITE_TURN_CREDENTIAL',
    'VITE_ICE_TRANSPORT_POLICY',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ICE server configuration', () => {
  test('falls back to public STUN when nothing is configured', () => {
    const servers = getIceServers();

    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({ urls: ['stun:stun.l.google.com:19302'] });
    expect(hasTurnConfigured()).toBe(false);
  });

  test('reads a comma-separated STUN list, trimming blanks', () => {
    vi.stubEnv('VITE_STUN_URLS', ' stun:one.example:3478 , ,stun:two.example:3478 ');

    expect(getIceServers()[0].urls).toEqual(['stun:one.example:3478', 'stun:two.example:3478']);
  });

  test('a configured relay is advertised with its credentials', () => {
    vi.stubEnv('VITE_TURN_URLS', 'turn:relay.example:3478,turns:relay.example:5349');
    vi.stubEnv('VITE_TURN_USERNAME', 'demo-user');
    vi.stubEnv('VITE_TURN_CREDENTIAL', 'demo-credential');

    const [, turn] = getIceServers();

    expect(hasTurnConfigured()).toBe(true);
    expect(turn.urls).toEqual(['turn:relay.example:3478', 'turns:relay.example:5349']);
    expect(turn.username).toBe('demo-user');
    expect(turn.credential).toBe('demo-credential');
  });

  test('a relay with no credentials keeps the entry, with the fields unset', () => {
    // Worth pinning: an unauthenticated TURN URL is a misconfiguration that looks
    // like a working configuration, and the entry still has to be well-formed.
    vi.stubEnv('VITE_TURN_URLS', 'turn:relay.example:3478');

    const [, turn] = getIceServers();

    expect(turn.urls).toEqual(['turn:relay.example:3478']);
    expect(turn.username).toBeUndefined();
    expect(turn.credential).toBeUndefined();
  });

  test('the transport policy is relay only when it says so', () => {
    expect(getIceTransportPolicy()).toBe('all');

    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', 'relay');
    expect(getIceTransportPolicy()).toBe('relay');

    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', ' RELAY ');
    expect(getIceTransportPolicy()).toBe('relay');

    // A typo must not silently force every call through the relay.
    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', 'relayed');
    expect(getIceTransportPolicy()).toBe('all');
  });
});

describe('describing the selected path', () => {
  const transport = { id: 'T', type: 'transport', selectedCandidatePairId: 'P' };
  const pair = {
    id: 'P',
    type: 'candidate-pair',
    localCandidateId: 'L',
    remoteCandidateId: 'R',
  };

  test('reports the relay when the local candidate is one', async () => {
    const pc = {
      getStats: async () =>
        fakeStats([
          transport,
          pair,
          { id: 'L', type: 'local-candidate', candidateType: 'relay' },
          { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
        ]),
    };

    expect(await describeSelectedPath(pc)).toEqual({
      relayed: true,
      localType: 'relay',
      remoteType: 'srflx',
    });
  });

  test('reports the relay when only the far side is one', async () => {
    const pc = {
      getStats: async () =>
        fakeStats([
          transport,
          pair,
          { id: 'L', type: 'local-candidate', candidateType: 'host' },
          { id: 'R', type: 'remote-candidate', candidateType: 'relay' },
        ]),
    };

    expect(await describeSelectedPath(pc)).toEqual({
      relayed: true,
      localType: 'host',
      remoteType: 'relay',
    });
  });

  test('a direct path is not a relay', async () => {
    const pc = {
      getStats: async () =>
        fakeStats([
          transport,
          pair,
          { id: 'L', type: 'local-candidate', candidateType: 'host' },
          { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
        ]),
    };

    expect(await describeSelectedPath(pc)).toEqual({
      relayed: false,
      localType: 'host',
      remoteType: 'srflx',
    });
  });

  test('falls back to the nominated pair when the transport has no pointer', async () => {
    const pc = {
      getStats: async () =>
        fakeStats([
          {
            id: 'P',
            type: 'candidate-pair',
            nominated: true,
            state: 'succeeded',
            localCandidateId: 'L',
            remoteCandidateId: 'R',
          },
          { id: 'L', type: 'local-candidate', candidateType: 'relay' },
          { id: 'R', type: 'remote-candidate', candidateType: 'relay' },
        ]),
    };

    expect((await describeSelectedPath(pc)).relayed).toBe(true);
  });

  test('says nothing at all until ICE has nominated a pair', async () => {
    const pc = {
      getStats: async () => fakeStats([{ id: 'P', type: 'candidate-pair', state: 'in-progress' }]),
    };

    expect(await describeSelectedPath(pc)).toBe(null);
  });
});

describe('ICE candidates that arrive before the remote description', () => {
  test('a candidate with nowhere to go is queued, not dropped', async () => {
    const pc = fakePeerConnection();

    await addOrQueueIceCandidate(pc, { candidate: 'one' });

    expect(pc.added).toEqual([]);
    expect(pc.pendingIceCandidates).toHaveLength(1);
    expect(pc.pendingIceCandidates[0].candidate).toBe('one');
  });

  test('a candidate with a remote description goes straight in', async () => {
    const pc = fakePeerConnection({ remoteDescription: { type: 'offer', sdp: 'v=0' } });

    await addOrQueueIceCandidate(pc, { candidate: 'one' });

    expect(pc.added.map((c) => c.candidate)).toEqual(['one']);
    expect(pc.pendingIceCandidates).toBeUndefined();
  });

  test('applying a remote description drains the queue in arrival order', async () => {
    const pc = fakePeerConnection();

    await addOrQueueIceCandidate(pc, { candidate: 'first' });
    await addOrQueueIceCandidate(pc, { candidate: 'second' });
    await applyRemoteDescription(pc, { type: 'offer', sdp: 'v=0' });

    expect(pc.applied).toEqual({ type: 'offer', sdp: 'v=0' });
    expect(pc.added.map((c) => c.candidate)).toEqual(['first', 'second']);
    expect(pc.pendingIceCandidates).toEqual([]);
  });

  test('one candidate the browser refuses does not abort the rest', async () => {
    // The real failure this guards: a stale candidate from a previous
    // negotiation rejects, and stopping there would lose every candidate behind
    // it — a call that never connects, with one console line nobody reads.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pc = fakePeerConnection();
    await addOrQueueIceCandidate(pc, { candidate: 'good-1' });
    await addOrQueueIceCandidate(pc, { candidate: 'bad' });
    await addOrQueueIceCandidate(pc, { candidate: 'good-2' });

    pc.addIceCandidate = async (candidate) => {
      if (candidate.candidate === 'bad') throw new Error('Invalid candidate');
      pc.added.push(candidate);
    };
    await flushPendingIceCandidates(pc);

    expect(pc.added.map((c) => c.candidate)).toEqual(['good-1', 'good-2']);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][0]).toMatch(/queued ICE candidate/);
  });

  test('flushing an empty queue is a no-op, and flushing twice adds nothing twice', async () => {
    const pc = fakePeerConnection();
    await flushPendingIceCandidates(pc);
    expect(pc.added).toEqual([]);

    await addOrQueueIceCandidate(pc, { candidate: 'once' });
    await flushPendingIceCandidates(pc);
    await flushPendingIceCandidates(pc);

    expect(pc.added.map((c) => c.candidate)).toEqual(['once']);
  });
});
