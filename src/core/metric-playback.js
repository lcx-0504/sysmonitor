'use strict';

function playbackPosition(playback, now) {
  let target = playback.anchorTime + now - playback.anchorAt;
  if (playback.transition) {
    const { from, at, duration } = playback.transition;
    const progress = Math.max(0, Math.min(1, (now - at) / duration));
    target += (from - playback.anchorTime) * (1 - progress);
  }
  return target;
}

function displayPosition(playback, now) {
  if (!playback) return null;
  if (playback.heldAt !== null) return playback.heldAt;
  return Math.max(playback.floor, Math.min(playback.latestAt, playbackPosition(playback, now)));
}

module.exports = { playbackPosition, displayPosition };
