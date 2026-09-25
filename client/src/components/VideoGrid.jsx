import { useEffect, useRef } from 'react';

function VideoTile({ stream, label, muted, status, media }) {
  const ref = useRef(null);
  const sharing = media?.screen === true;

  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);

  return (
    // `screen` stops the video from being cropped: a 16:9 desktop under
    // `object-fit: cover` in a 4:3 tile loses the sides of a slide, which is
    // exactly the part someone is trying to show.
    <div className={`video-tile${sharing ? ' screen' : ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      <span className="tile-label">{label}</span>
      {(media?.mic === false || sharing) && (
        <span className="tile-media">
          {media?.mic === false && (
            <span className="tile-flag" title="Microphone is off">
              🔇
            </span>
          )}
          {sharing && (
            <span className="tile-flag" title="Sharing their screen">
              🖥️
            </span>
          )}
        </span>
      )}
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

export default function VideoGrid({
  localStream,
  localName,
  localMedia,
  peers,
  peerMedia = {},
  peerStatus = {},
}) {
  return (
    <div className="video-grid">
      <VideoTile stream={localStream} label={`${localName} (you)`} muted media={localMedia} />
      {peers.map((p) => (
        <VideoTile
          key={p.socketId}
          stream={p.stream}
          label={p.name}
          muted={false}
          media={peerMedia[p.socketId]}
          status={peerStatus[p.socketId]}
        />
      ))}
    </div>
  );
}
