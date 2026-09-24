import { useEffect, useRef } from 'react';

function VideoTile({ stream, label, muted, status }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <span className="tile-label">{label}</span>
      {status && (
        // Says whether this peer's media is direct or relayed — the visible
        // answer a cross-network smoke test is looking for.
        <span className={`tile-status tile-status-${status.tone}`} title={status.title}>
          {status.text}
        </span>
      )}
    </div>
  );
}

export default function VideoGrid({ localStream, localName, peers, peerStatus = {} }) {
  return (
    <div className="video-grid">
      <VideoTile stream={localStream} label={`${localName} (you)`} muted />
      {peers.map((p) => (
        <VideoTile
          key={p.socketId}
          stream={p.stream}
          label={p.name}
          muted={false}
          status={peerStatus[p.socketId]}
        />
      ))}
    </div>
  );
}
