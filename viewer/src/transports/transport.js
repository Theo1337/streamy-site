/**
 * The player talks to one of these, never to WebRTC or the relay directly.
 * Implementations emit:
 *   onVideo({ kind: "stream", stream })       browser WebRTC
 *   onVideo({ kind: "canvas", canvas })       decoded WebCodecs frames
 *   onVideo({ kind: "element", element })     MSE fallback on the shared <video>
 *   onStatus(text, state)
 *   onAudio({ sampleRate, channels })
 */
export class Transport {
  constructor() {
    this.videoListeners = new Set();
    this.audioListeners = new Set();
    this.statusListeners = new Set();
    this.closed = false;
  }

  onVideo(listener) {
    this.videoListeners.add(listener);
    return () => this.videoListeners.delete(listener);
  }

  onAudio(listener) {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emitVideo(value) {
    for (const listener of this.videoListeners) listener(value);
  }

  emitAudio(value) {
    for (const listener of this.audioListeners) listener(value);
  }

  emitStatus(text, state = "") {
    for (const listener of this.statusListeners) listener(text, state);
  }

  async connect() {
    throw new Error("Transport.connect is not implemented");
  }

  close() {
    this.closed = true;
  }
}
