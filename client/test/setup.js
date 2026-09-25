/**
 * The two WebRTC globals `src/lib/webrtc.js` constructs.
 *
 * A browser provides them; Node does not, and pulling in jsdom for two
 * constructors would be a much larger dependency for the same result. They keep
 * their init dictionary on the instance so a test can assert which description
 * was applied without needing a real peer connection.
 */
class FakeRTCSessionDescription {
  constructor(init = {}) {
    Object.assign(this, init);
  }
}

class FakeRTCIceCandidate {
  constructor(init = {}) {
    Object.assign(this, init);
  }
}

globalThis.RTCSessionDescription = FakeRTCSessionDescription;
globalThis.RTCIceCandidate = FakeRTCIceCandidate;
