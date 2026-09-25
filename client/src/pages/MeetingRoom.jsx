import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext.jsx';
import VideoGrid from '../components/VideoGrid.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import SummaryPanel from '../components/SummaryPanel.jsx';
import {
  getIceServers,
  getIceTransportPolicy,
  hasTurnConfigured,
  describeSelectedPath,
  applyRemoteDescription,
  addOrQueueIceCandidate,
} from '../lib/webrtc.js';
import { stopTracks, switchOutgoingVideo } from '../lib/screenShare.js';

/**
 * What to show on a peer's tile: whether media is going direct, through the TURN
 * relay, or not at all. Seeing "via TURN" is the point of a relay-only smoke
 * test — it is the visible proof that the relay path carried the call.
 */
function peerPathBadge(diag) {
  if (!diag?.state) return { tone: 'pending', text: 'connecting', title: 'Gathering candidates…' };
  if (diag.state === 'failed' || diag.state === 'disconnected') {
    return {
      tone: 'bad',
      text: 'no path',
      title: diag.error
        ? `ICE error ${diag.error.code}: ${diag.error.text}`
        : 'ICE could not find a working path. A TURN server is required across strict NATs.',
    };
  }
  if (diag.state !== 'connected' && diag.state !== 'completed') {
    return { tone: 'pending', text: diag.state, title: 'ICE state' };
  }
  if (diag.relayed) {
    return {
      tone: 'relay',
      text: 'via TURN',
      title: `Relayed through TURN (local ${diag.localType}, remote ${diag.remoteType})`,
    };
  }
  return {
    tone: 'ok',
    text: 'direct',
    title: `Direct peer-to-peer (local ${diag.localType}, remote ${diag.remoteType})`,
  };
}

export default function MeetingRoom() {
  const { roomCode } = useParams();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [meeting, setMeeting] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [peers, setPeers] = useState([]); // [{ socketId, name, stream }]
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState('chat');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [summary, setSummary] = useState('');
  const [actionItems, setActionItems] = useState([]);
  const [engine, setEngine] = useState('');
  const [loadError, setLoadError] = useState('');
  // The captured display, when this client is sharing. Kept separate from
  // `localStream` because it is what gets released, and because the local tile
  // has to be able to say which of the two it is showing.
  const [screenStream, setScreenStream] = useState(null);
  const [peerMedia, setPeerMedia] = useState({}); // socketId -> { mic, camera, screen }
  const [removed, setRemoved] = useState(null); // { banned } once the host evicts us
  const [linkCopied, setLinkCopied] = useState(false);
  const [peerDiagnostics, setPeerDiagnostics] = useState({}); // socketId -> { state, relayed, ... }

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({}); // socketId -> RTCPeerConnection
  const candidateTypesRef = useRef({}); // socketId -> Set of host/srflx/relay seen
  // The camera track, held separately from the outgoing stream: while a screen is
  // being shared the outgoing video is the display, and "toggle camera" has to
  // keep meaning the camera.
  const cameraTrackRef = useRef(null);
  const screenStreamRef = useRef(null);

  // Env-derived, so it never changes for the life of the page.
  const relayOnly = getIceTransportPolicy() === 'relay';
  const relayWithoutTurn = relayOnly && !hasTurnConfigured();

  const updateDiagnostics = useCallback((socketId, patch) => {
    setPeerDiagnostics((prev) => ({ ...prev, [socketId]: { ...prev[socketId], ...patch } }));
  }, []);

  /**
   * Tell the room what this client's media is doing.
   *
   * A remote track carries no display surface and a muted microphone looks
   * exactly like a quiet one, so the tiles can only be labelled correctly if the
   * peer they belong to says so. The flags are read off the live tracks rather
   * than off React state, which is a render behind by the time this is called.
   */
  const announceMedia = useCallback((extra = {}) => {
    socketRef.current?.emit('media-state', {
      mic: localStreamRef.current?.getAudioTracks()[0]?.enabled ?? false,
      camera: cameraTrackRef.current?.enabled ?? false,
      screen: Boolean(screenStreamRef.current),
      ...extra,
    });
  }, []);

  // Load meeting metadata (title, prior summary/chat) on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/meetings/room/${roomCode}`)
      .then(({ data }) => {
        if (cancelled) return;
        setMeeting(data);
        setMessages(data.chatMessages || []);
        setSummary(data.summary || '');
        setActionItems(data.actionItems || []);
      })
      .catch(() => setLoadError('Could not load this meeting. Check the room code.'));
    return () => {
      cancelled = true;
    };
  }, [roomCode]);

  const createPeerConnection = useCallback(
    (socketId, name) => {
      const pc = new RTCPeerConnection({
        iceServers: getIceServers(),
        // 'all' normally; 'relay' when proving the TURN path.
        iceTransportPolicy: getIceTransportPolicy(),
      });

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          // Track the kinds of candidate we gathered: a `relay` among them means
          // TURN is reachable, which is the other half of proving the relay path.
          const types = candidateTypesRef.current[socketId] || new Set();
          if (event.candidate.type) types.add(event.candidate.type);
          candidateTypesRef.current[socketId] = types;
          updateDiagnostics(socketId, { candidates: [...types], state: pc.iceConnectionState });

          socketRef.current?.emit('signal', {
            to: socketId,
            data: { type: 'candidate', candidate: event.candidate },
          });
        }
      };

      // Surface TURN/STUN failures instead of silently failing to connect — on
      // the tile, not just in the console, because whoever runs a cross-network
      // test is looking at the video, not the devtools.
      pc.onicecandidateerror = (event) => {
        updateDiagnostics(socketId, {
          error: {
            code: event.errorCode,
            text: event.errorText || 'unknown',
            url: event.url || '',
          },
        });
        console.warn(
          `ICE candidate error (${event.errorCode}): ${event.errorText || 'unknown'} ${event.url || ''}`.trim(),
        );
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        updateDiagnostics(socketId, { state });

        if (state === 'failed') {
          console.warn(`ICE connection to ${socketId} failed`);
        }

        if (state === 'connected' || state === 'completed') {
          // Which path won, direct or relayed? This is what the badge reports.
          describeSelectedPath(pc)
            .then((path) => {
              if (path) updateDiagnostics(socketId, path);
            })
            .catch(() => {
              // Stats are best-effort diagnostics; a failure here isn't fatal.
            });
        }
      };

      pc.ontrack = (event) => {
        setPeers((prev) => {
          const exists = prev.find((p) => p.socketId === socketId);
          const stream = event.streams[0];
          if (exists) {
            return prev.map((p) => (p.socketId === socketId ? { ...p, stream } : p));
          }
          return [...prev, { socketId, name, stream }];
        });
      };

      peerConnectionsRef.current[socketId] = pc;
      return pc;
    },
    [updateDiagnostics],
  );

  // Acquire camera/mic, then connect to Socket.io and wire up signaling.
  useEffect(() => {
    let cancelled = false;

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        cameraTrackRef.current = stream.getVideoTracks()[0] || null;
        setLocalStream(stream);
      } catch (err) {
        setLoadError('Could not access camera/microphone. You can still use chat.');
      }

      const socket = io(import.meta.env.VITE_API_URL || 'http://localhost:5000', {
        auth: { token },
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('join-room', { roomCode });
      });

      socket.on('room-users', ({ peers: existingPeers }) => {
        existingPeers.forEach(({ socketId, name }) => {
          setPeers((prev) =>
            prev.find((p) => p.socketId === socketId)
              ? prev
              : [...prev, { socketId, name, stream: null }],
          );
        });
        // Everyone already here needs to know how this client arrives: the mic
        // may be off, and a share may already be running.
        announceMedia();
      });

      // A newcomer joined after us: we initiate the offer.
      socket.on('peer-joined', async ({ socketId, name }) => {
        setPeers((prev) =>
          prev.find((p) => p.socketId === socketId)
            ? prev
            : [...prev, { socketId, name, stream: null }],
        );
        // The newcomer cannot see any of our media flags yet — the relay only
        // forwards to other sockets — so everybody already in the room repeats
        // their state for the person who just walked in.
        announceMedia();

        const pc = createPeerConnection(socketId, name);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: socketId, data: { type: 'offer', sdp: offer } });
        } catch (err) {
          console.error('offer creation failed', err);
        }
      });

      socket.on('signal', async ({ from, name, data }) => {
        let pc = peerConnectionsRef.current[from];
        if (!pc) {
          pc = createPeerConnection(from, name);
        }

        if (data.type === 'offer') {
          await applyRemoteDescription(pc, data.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer') {
          await applyRemoteDescription(pc, data.sdp);
        } else if (data.type === 'candidate') {
          try {
            // Buffered automatically if the offer/answer hasn't landed yet.
            await addOrQueueIceCandidate(pc, data.candidate);
          } catch (err) {
            console.error('ICE candidate error', err);
          }
        }
      });

      socket.on('peer-left', ({ socketId }) => {
        const pc = peerConnectionsRef.current[socketId];
        if (pc) {
          pc.close();
          delete peerConnectionsRef.current[socketId];
        }
        delete candidateTypesRef.current[socketId];
        setPeerDiagnostics((prev) => {
          const next = { ...prev };
          delete next[socketId];
          return next;
        });
        setPeerMedia((prev) => {
          const next = { ...prev };
          delete next[socketId];
          return next;
        });
        setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      });

      socket.on('chat-message', (message) => {
        setMessages((prev) => [...prev, message]);
      });

      // How each peer's media is doing, as they told us. Without it a tile cannot
      // tell a screen share from a webcam, or a muted microphone from silence.
      socket.on('media-state', (state) => {
        const { socketId, ...flags } = state;
        setPeerMedia((prev) => ({ ...prev, [socketId]: { ...prev[socketId], ...flags } }));
      });

      // Someone ticked an action item off, perhaps in another tab. The server
      // sends the whole list, including our own change, so every client ends up
      // on the same state rather than on its own optimistic guess.
      socket.on('action-item-updated', ({ actionItems: updated }) => {
        setActionItems(updated);
      });

      socket.on('removed-from-room', ({ banned }) => {
        // The server has already disconnected us; the client stops retrying when
        // the server closes the connection, so just shut the media down and show
        // the notice instead of leaving a dead video tile on screen.
        setRemoved({ banned });
      });

      socket.on('error-message', ({ error }) => setLoadError(error));
    }

    setup();

    return () => {
      cancelled = true;
      socketRef.current?.emit('leave-room');
      socketRef.current?.disconnect();
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      peerConnectionsRef.current = {};
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      // Releasing the capture is what turns the browser's "stop sharing" bar off.
      stopTracks(screenStreamRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, token]);

  // Evicted by the host: release the camera/mic and drop every peer connection.
  useEffect(() => {
    if (!removed) return;
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    stopTracks(screenStreamRef.current);
    localStreamRef.current = null;
    cameraTrackRef.current = null;
    screenStreamRef.current = null;
    candidateTypesRef.current = {};
    setPeerDiagnostics({});
    setLocalStream(null);
    setScreenStream(null);
    setPeerMedia({});
    setPeers([]);
    // A client-initiated disconnect won't be retried, which covers the case
    // where the server refused a rejoin but left the socket connected.
    socketRef.current?.disconnect();
  }, [removed]);

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    announceMedia({ mic: track.enabled });
  }

  function toggleCam() {
    // The camera track specifically: while a screen is being shared the outgoing
    // video is the display, so going through `localStream` here would mute the
    // share instead of the camera.
    const track = cameraTrackRef.current;
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
    announceMedia({ camera: track.enabled });
  }

  /**
   * Start sharing the screen: capture the display, put it into the outgoing
   * stream in place of the camera, and point every existing connection at it.
   *
   * The swap happens in the outgoing MediaStream rather than by adding a track to
   * each connection, which matters for the peer who joins *during* the share: the
   * stream keeps one msid, so the new connection carries the audio and the screen
   * together instead of a video track whose sound arrived under a different
   * stream id.
   */
  async function startScreenShare() {
    if (screenStreamRef.current) return;

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      // Dismissing the picker is a decision, not a failure — only say something
      // when the browser actually refused.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setLoadError('Could not start screen sharing.');
      }
      return;
    }

    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) {
      stopTracks(display);
      return;
    }

    let outgoing = localStreamRef.current;
    if (!outgoing) {
      // No camera or microphone (the user denied it): a share still works, it is
      // just video-only, so give it a stream of its own to travel in.
      outgoing = new MediaStream();
      localStreamRef.current = outgoing;
      setLocalStream(outgoing);
    }
    if (cameraTrackRef.current) outgoing.removeTrack(cameraTrackRef.current);
    outgoing.addTrack(screenTrack);

    screenStreamRef.current = display;
    setScreenStream(display);
    setLoadError('');

    const result = await switchOutgoingVideo(peerConnectionsRef.current, screenTrack);
    if (result.failed.length > 0 && result.swapped === 0) {
      setLoadError('Nobody else can see your screen — their connections could not be switched.');
    } else if (result.failed.length > 0) {
      console.warn(`screen share did not reach ${result.failed.length} peer(s)`);
    }

    // The browser's own "Stop sharing" button lives in the tab, not in our UI.
    screenTrack.onended = () => stopScreenShare();
    announceMedia({ screen: true });
  }

  /** Stop sharing and hand the camera back, if there is one. */
  function stopScreenShare() {
    const display = screenStreamRef.current;
    if (!display) return;

    const [screenTrack] = display.getVideoTracks();
    // Cleared first, so the browser's own `ended` handler can't re-enter.
    screenStreamRef.current = null;
    setScreenStream(null);
    if (screenTrack) {
      screenTrack.onended = null;
      localStreamRef.current?.removeTrack(screenTrack);
    }
    stopTracks(display);

    const camera = cameraTrackRef.current;
    if (camera) {
      localStreamRef.current?.addTrack(camera);
      switchOutgoingVideo(peerConnectionsRef.current, camera).then((result) => {
        if (result.failed.length > 0) {
          console.warn(`camera did not return for ${result.failed.length} peer(s)`);
        }
      });
    }

    announceMedia({ screen: false });
  }

  function sendChat(text) {
    socketRef.current?.emit('chat-message', { roomCode, text });
  }

  /**
   * Tick an action item off for the whole room.
   *
   * Optimistic, because a checkbox that waits for a round trip feels broken —
   * and self-correcting, because the server broadcasts the resulting list to
   * everyone including this client.
   */
  async function toggleActionItem(index, done) {
    const previous = actionItems;
    setActionItems((items) => items.map((item, i) => (i === index ? { ...item, done } : item)));

    try {
      await api.patch(`/meetings/${meeting._id}/action-items/${index}`, { done });
    } catch (err) {
      setActionItems(previous);
      setLoadError(err.response?.data?.error || 'Could not update that action item.');
    }
  }

  async function generateSummary(transcript) {
    if (!meeting) return;
    const { data } = await api.post(`/meetings/${meeting._id}/summarize`, { transcript });
    setSummary(data.summary);
    setActionItems(data.actionItems);
    setEngine(data.engine);
  }

  // Whoever opens this link becomes an anonymous guest in this room, so it is
  // the invite path now — worth making copyable rather than making people
  // select the address bar.
  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/room/${roomCode}`);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked (insecure context or denied) — the URL
      // in the address bar still works.
    }
  }

  async function handleLeave() {
    if (meeting && meeting.host === user.id) {
      try {
        await api.post(`/meetings/${meeting._id}/end`);
      } catch {
        // non-fatal
      }
    }
    navigate('/');
  }

  if (removed) {
    return (
      <div className="room-shell" style={{ flex: 1 }}>
        <div className="room-main">
          <div className="room-header">
            <div>
              <strong>{meeting?.title || 'Meeting'}</strong>
            </div>
            <span className="room-code">{roomCode}</span>
          </div>

          <div style={{ padding: 32, textAlign: 'center', margin: 'auto' }}>
            <h2>
              {removed.banned
                ? 'You have been removed from this meeting'
                : 'The host removed you from this meeting'}
            </h2>
            <p style={{ color: 'var(--muted, #9aa0a6)', marginBottom: 20 }}>
              {removed.banned
                ? 'The host banned you, so you cannot rejoin with this account unless they invite you again.'
                : 'Your camera and microphone have been turned off.'}
            </p>
            <button className="btn btn-primary" onClick={() => navigate('/')}>
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="room-shell" style={{ flex: 1 }}>
      <div className="room-main">
        <div className="room-header">
          <div>
            <strong>{meeting?.title || 'Meeting'}</strong>
          </div>
          <div className="room-invite">
            {user?.isGuest && (
              <button className="btn btn-mint" onClick={() => navigate('/claim')}>
                Save this session
              </button>
            )}
            <span className="room-code">{roomCode}</span>
            <button className="btn btn-secondary" onClick={copyInviteLink}>
              {linkCopied ? 'Link copied' : 'Copy invite link'}
            </button>
          </div>
        </div>

        {loadError && (
          <div className="form-error" style={{ margin: 16 }}>
            {loadError}
          </div>
        )}

        {relayWithoutTurn && (
          <div className="form-error" style={{ margin: 16 }}>
            Relay-only mode is on (<code>VITE_ICE_TRANSPORT_POLICY=relay</code>) but no TURN server
            is configured, so peers cannot connect. Set <code>VITE_TURN_URLS</code>, or drop the
            policy.
          </div>
        )}
        {relayOnly && !relayWithoutTurn && (
          <div className="relay-note">
            Relay-only mode: every call is being routed through TURN. This is the proof run.
          </div>
        )}

        <VideoGrid
          // While sharing, the local tile shows the display rather than the
          // camera: a sharer needs to see what the room sees.
          localStream={screenStream || localStream}
          localName={user?.name || 'You'}
          localMedia={{ mic: micOn, camera: camOn, screen: Boolean(screenStream) }}
          peers={peers}
          peerMedia={peerMedia}
          peerStatus={Object.fromEntries(
            peers.map((p) => [p.socketId, peerPathBadge(peerDiagnostics[p.socketId])]),
          )}
        />

        <div className="controls-bar">
          <button
            className={`control-btn ${micOn ? '' : 'off'}`}
            onClick={toggleMic}
            title="Toggle microphone"
          >
            {micOn ? '🎙️' : '🔇'}
          </button>
          <button
            className={`control-btn ${camOn ? '' : 'off'}`}
            onClick={toggleCam}
            title="Toggle camera"
          >
            {camOn ? '🎥' : '📷'}
          </button>
          <button
            className={`control-btn ${screenStream ? 'sharing' : ''}`}
            onClick={screenStream ? stopScreenShare : startScreenShare}
            title={screenStream ? 'Stop sharing your screen' : 'Share your screen'}
          >
            {screenStream ? '⏹️' : '🖥️'}
          </button>
          <button className="btn btn-danger" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>

      <div className="side-panel">
        <div className="side-tabs">
          <button
            className={`side-tab ${tab === 'chat' ? 'active' : ''}`}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            className={`side-tab ${tab === 'summary' ? 'active' : ''}`}
            onClick={() => setTab('summary')}
          >
            AI Summary
          </button>
        </div>
        <div className="side-body">
          {tab === 'chat' ? (
            <ChatPanel messages={messages} onSend={sendChat} currentUserName={user?.name} />
          ) : (
            <SummaryPanel
              onGenerate={generateSummary}
              summary={summary}
              actionItems={actionItems}
              engine={engine}
              onToggleItem={toggleActionItem}
            />
          )}
        </div>
      </div>
    </div>
  );
}
