import { useEffect, useRef } from 'react';

function VideoTile({ stream, label, muted }) {
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
    </div>
  );
}

export default function VideoGrid({ localStream, localName, peers }) {
  return (
    <div className="video-grid">
      <VideoTile stream={localStream} label={`${localName} (you)`} muted />
      {peers.map((p) => (
        <VideoTile key={p.socketId} stream={p.stream} label={p.name} muted={false} />
      ))}
    </div>
  );
}
