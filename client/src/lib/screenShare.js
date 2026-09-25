/**
 * Swapping the outgoing video track, and back.
 *
 * A screen share is not a second video stream in this app. A mesh connection has
 * exactly one video sender per peer, and sharing means pointing that sender at the
 * display track instead of the camera — which is what makes it cheap:
 * `replaceTrack` needs no renegotiation, so the picture changes on the other side
 * without a re-offer, a re-answer, or a flicker in the connection.
 *
 * The failure this module exists to prevent: one peer whose `replaceTrack` throws
 * (typically a connection that is already closing) aborting the loop, so the
 * remaining peers keep showing a camera while the sharer sees their own screen.
 */

/**
 * The sender carrying video on this connection, if it has one.
 *
 * A peer connection that negotiated while the camera was off has no video sender
 * at all; it picks the new track up when it is created, so it is skipped rather
 * than treated as a failure.
 */
export function videoSender(pc) {
  const senders = pc?.getSenders?.() || [];
  return senders.find((sender) => sender.track?.kind === 'video') || null;
}

/**
 * Point every connection's video sender at `track`.
 *
 * Returns what happened rather than throwing, because the interesting case is
 * partial success: the room should still be told that sharing started, and the
 * caller can say how many peers actually see it.
 *
 * Not called `useVideoTrack` on purpose — a plain function with a `use` prefix
 * looks like a React hook to the linter, to React's own tooling, and to whoever
 * reads the call site next.
 */
export async function switchOutgoingVideo(peerConnections, track) {
  const entries = Object.entries(peerConnections || {});

  const results = await Promise.all(
    entries.map(async ([socketId, pc]) => {
      const sender = videoSender(pc);
      if (!sender) return { socketId, swapped: false };

      try {
        await sender.replaceTrack(track);
        return { socketId, swapped: true };
      } catch (err) {
        return { socketId, swapped: false, error: err };
      }
    }),
  );

  return {
    swapped: results.filter((result) => result.swapped).length,
    // Negotiated no video, so there was nothing to replace.
    skipped: results.filter((result) => !result.swapped && !result.error).map((r) => r.socketId),
    failed: results.filter((result) => result.error).map((r) => r.socketId),
  };
}

/** Release a captured display stream — the browser's own "Stop sharing" path too. */
export function stopTracks(stream) {
  (stream?.getTracks?.() || []).forEach((track) => track.stop());
}
