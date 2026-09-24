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
  const [removed, setRemoved] = useState(null); // { banned } once the host evicts us
  const [linkCopied, setLinkCopied] = useState(false);
  const [peerDiagnostics, setPeerDiagnostics] = useState({}); // socketId -> { state, relayed, ... }

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({}); // socketId -> RTCPeerConnection
  const candidateTypesRef = useRef({}); // socketId -> Set of host/srflx/relay seen

  // Env-derived, so it never changes for the life of the page.
  const relayOnly = getIceTransportPolicy() === 'relay';
  const relayWithoutTurn = relayOnly && !hasTurnConfigured();

  const updateDiagnostics = useCallback((socketId, patch) => {
    setPeerDiagnostics((prev) => ({ ...prev, [socketId]: { ...prev[socketId], ...patch } }));
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
          error: { code: event.errorCode, text: event.errorText || 'unknown', url: event.url || '' },
        });
        console.warn(
          `ICE candidate error (${event.errorCode}): ${event.errorText || 'unknown'} ${event.url || ''}`.trim()
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
    [updateDiagnostics]
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
          setPeers((prev) => (prev.find((p) => p.socketId === socketId) ? prev : [...prev, { socketId, name, stream: null }]));
        });
      });

      // A newcomer joined after us: we initiate the offer.
      socket.on('peer-joined', async ({ socketId, name }) => {
        setPeers((prev) => (prev.find((p) => p.socketId === socketId) ? prev : [...prev, { socketId, name, stream: null }]));
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
        setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
      });

      socket.on('chat-message', (message) => {
        setMessages((prev) => [...prev, message]);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, token]);

  // Evicted by the host: release the camera/mic and drop every peer connection.
  useEffect(() => {
    if (!removed) return;
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    candidateTypesRef.current = {};
    setPeerDiagnostics({});
    setLocalStream(null);
    setPeers([]);
    // A client-initiated disconnect won't be retried, which covers the case
    // where the server refused a rejoin but left the socket connected.
    socketRef.current?.disconnect();
  }, [removed]);

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    }
  }

  function toggleCam() {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setCamOn(track.enabled);
    }
  }

  function sendChat(text) {
    socketRef.current?.emit('chat-message', { roomCode, text });
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
            <h2>{removed.banned ? 'You have been removed from this meeting' : 'The host removed you from this meeting'}</h2>
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

        {loadError && <div className="form-error" style={{ margin: 16 }}>{loadError}</div>}

        {relayWithoutTurn && (
          <div className="form-error" style={{ margin: 16 }}>
            Relay-only mode is on (<code>VITE_ICE_TRANSPORT_POLICY=relay</code>) but no TURN server is
            configured, so peers cannot connect. Set <code>VITE_TURN_URLS</code>, or drop the policy.
          </div>
        )}
        {relayOnly && !relayWithoutTurn && (
          <div className="relay-note">
            Relay-only mode: every call is being routed through TURN. This is the proof run.
          </div>
        )}

        <VideoGrid
          localStream={localStream}
          localName={user?.name || 'You'}
          peers={peers}
          peerStatus={Object.fromEntries(
            peers.map((p) => [p.socketId, peerPathBadge(peerDiagnostics[p.socketId])])
          )}
        />

        <div className="controls-bar">
          <button className={`control-btn ${micOn ? '' : 'off'}`} onClick={toggleMic} title="Toggle microphone">
            {micOn ? '🎙️' : '🔇'}
          </button>
          <button className={`control-btn ${camOn ? '' : 'off'}`} onClick={toggleCam} title="Toggle camera">
            {camOn ? '🎥' : '📷'}
          </button>
          <button className="btn btn-danger" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>

      <div className="side-panel">
        <div className="side-tabs">
          <button className={`side-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
            Chat
          </button>
          <button className={`side-tab ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>
            AI Summary
          </button>
        </div>
        <div className="side-body">
          {tab === 'chat' ? (
            <ChatPanel messages={messages} onSend={sendChat} currentUserName={user?.name} />
          ) : (
            <SummaryPanel onGenerate={generateSummary} summary={summary} actionItems={actionItems} engine={engine} />
          )}
        </div>
      </div>
    </div>
  );
}
