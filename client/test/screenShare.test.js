/**
 * `src/lib/screenShare.js` — the track swapping behind "Share screen".
 *
 * The interesting cases are the awkward ones a demo rarely reaches: a peer whose
 * connection has no video sender because it negotiated while the camera was off,
 * and a peer whose connection is already closing. Both must leave the rest of the
 * room working, because the alternative is a sharer whose own preview shows the
 * screen while half the room still sees their webcam.
 */
import { describe, expect, test, vi } from 'vitest';

import { stopTracks, switchOutgoingVideo, videoSender } from '../src/lib/screenShare.js';

function sender(kind, { failWith } = {}) {
  return {
    track: { kind },
    replaceTrack: failWith
      ? vi.fn(async () => {
          throw failWith;
        })
      : vi.fn(async () => {}),
  };
}

const pcWith = (senders) => ({ getSenders: () => senders });

const SCREEN = { kind: 'video', id: 'screen-track' };

describe('finding the video sender', () => {
  test('skips the audio sender', () => {
    const video = sender('video');
    const pc = pcWith([sender('audio'), video]);

    expect(videoSender(pc)).toBe(video);
  });

  test('is null for a connection that negotiated no video', () => {
    expect(videoSender(pcWith([sender('audio')]))).toBe(null);
    // A connection we don't own yet, or a closed one, must not throw here.
    expect(videoSender(null)).toBe(null);
    expect(videoSender({})).toBe(null);
  });
});

describe('pointing every connection at another track', () => {
  test('replaces the video track on every peer', async () => {
    const first = sender('video');
    const second = sender('video');
    const peers = { a: pcWith([sender('audio'), first]), b: pcWith([second]) };

    const result = await switchOutgoingVideo(peers, SCREEN);

    expect(result).toEqual({ swapped: 2, skipped: [], failed: [] });
    expect(first.replaceTrack).toHaveBeenCalledWith(SCREEN);
    expect(second.replaceTrack).toHaveBeenCalledWith(SCREEN);
  });

  test('leaves the audio sender alone', async () => {
    const audio = sender('audio');
    const peers = { a: pcWith([audio, sender('video')]) };

    await switchOutgoingVideo(peers, SCREEN);

    expect(audio.replaceTrack).not.toHaveBeenCalled();
  });

  test('a peer with no video sender is skipped, not failed', async () => {
    const peers = { audioOnly: pcWith([sender('audio')]), normal: pcWith([sender('video')]) };

    const result = await switchOutgoingVideo(peers, SCREEN);

    expect(result.swapped).toBe(1);
    expect(result.skipped).toEqual(['audioOnly']);
    expect(result.failed).toEqual([]);
  });

  test('one peer that refuses does not stop the others', async () => {
    const closing = sender('video', { failWith: new Error('InvalidStateError') });
    const healthy = sender('video');
    const peers = { closing: pcWith([closing]), healthy: pcWith([healthy]) };

    const result = await switchOutgoingVideo(peers, SCREEN);

    expect(result.failed).toEqual(['closing']);
    expect(result.swapped).toBe(1);
    expect(healthy.replaceTrack).toHaveBeenCalledWith(SCREEN);
  });

  test('no peers at all is a no-op, not an error', async () => {
    // This is the normal case: someone shares their screen alone in a room.
    expect(await switchOutgoingVideo({}, SCREEN)).toEqual({ swapped: 0, skipped: [], failed: [] });
    expect(await switchOutgoingVideo(undefined, SCREEN)).toEqual({
      swapped: 0,
      skipped: [],
      failed: [],
    });
  });
});

describe('releasing the captured display', () => {
  test('stops every track', () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    const stream = { getTracks: () => [first, second] };

    stopTracks(stream);

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  test('tolerates having nothing to stop', () => {
    expect(() => stopTracks(null)).not.toThrow();
    expect(() => stopTracks({})).not.toThrow();
  });
});
