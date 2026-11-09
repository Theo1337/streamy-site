import { annexBToAVCC, buildAVCDecoderConfig, codecStringFromSPS, inspectAccessUnit } from "./annexb.js";

/**
 * Shared playout clock for one stream.
 *
 * Publishers stamp frames with Unix milliseconds, which may come from another
 * machine and therefore another clock. Only differences between timestamps are
 * used, so that offset cancels out.
 *
 * `origin` is fixed for the lifetime of the player and is what decoder chunk
 * timestamps are expressed against. `anchor` is the pair "this timestamp is
 * shown at this wall-clock instant"; moving it lets playback skip ahead when
 * latency has grown, without invalidating the timestamps of frames that are
 * already inside the decoder.
 */
export class MediaClock {
  constructor() {
    this.origin = null;
    this.anchorTimestamp = null;
    this.anchorWall = null;
    // A small jitter buffer absorbs network jitter without adding a second of
    // latency. Audio and video start from this same instant.
    this.delay = 120;
  }

  set(timestampMs) {
    if (this.origin === null && Number.isFinite(timestampMs) && timestampMs > 0) {
      this.origin = timestampMs;
      this.anchorTimestamp = timestampMs;
      this.anchorWall = performance.now() + this.delay;
    }
  }

  /** Decoder timestamp for a publisher timestamp, in microseconds. */
  encode(timestampMs) {
    this.set(timestampMs);
    return Math.max(0, Math.round((timestampMs - this.origin) * 1000));
  }

  /** Wall-clock instant at which a publisher timestamp should be shown. */
  due(timestampMs) {
    this.set(timestampMs);
    if (this.anchorTimestamp === null) return performance.now();
    return this.anchorWall + (timestampMs - this.anchorTimestamp);
  }

  /** Same, for a decoder timestamp in microseconds. */
  dueChunk(timestampUs) {
    if (this.anchorTimestamp === null) return performance.now();
    return this.anchorWall + timestampUs / 1000 - (this.anchorTimestamp - this.origin);
  }

  /**
   * Moves the playout point to timestampMs.
   *
   * Called when the stream has fallen behind: queued pictures are discarded and
   * the next ones are shown just after they arrive, trading a shorter jitter
   * buffer for getting back to the live edge.
   */
  rebase(timestampMs, delay = this.delay) {
    this.set(timestampMs);
    this.anchorTimestamp = timestampMs;
    this.anchorWall = performance.now() + delay;
  }
}

export class WebCodecsPlayer {
  constructor({ canvas, clock, onAudioInfo, onFallback }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.clock = clock;
    this.onAudioInfo = onAudioInfo;
    this.onFallback = onFallback;

    this.videoDecoder = null;
    this.videoConfigured = false;
    this.configuredSPS = null;
    this.configuredPPS = null;
    this.sps = null;
    this.pps = null;
    this.awaitingKeyframe = true;
    this.frameQueue = [];
    this.lastTimestamp = null;
    this.raf = null;
    this.closed = false;

    this.audioDecoder = null;
    this.audioContext = null;
    this.gain = null;
    this.volume = 0.75;
    this.muted = true;
    this.audioBaseCtx = null;

    this.raf = requestAnimationFrame(() => this.render());
  }

  static supported() {
    return typeof window.VideoDecoder === "function" && typeof window.AudioDecoder === "function";
  }

  pushVideo(payload, timestampMs, keyframe) {
    if (this.closed) return;
    const info = inspectAccessUnit(payload);
    if (info.sps) this.sps = info.sps;
    if (info.pps) this.pps = info.pps;
    this.clock.set(timestampMs);
    this.lastTimestamp = timestampMs;

    // How far in the past this picture was supposed to be shown. A growing
    // value means the pipeline is queueing (network, relay, or this tab), and
    // playing the backlog would only add latency. A very large value means the
    // tab or the connection stalled, and only a fresh IDR can restart decoding.
    const late = performance.now() - this.clock.due(timestampMs);
    if (late > 1500 && !keyframe) {
      this.resetVideo();
      this.clock.rebase(timestampMs);
      return;
    }
    if (late > 800) this.resync(timestampMs);

    if (this.awaitingKeyframe && !keyframe) return;
    if (!this.sps || !this.pps) {
      if (!keyframe) return;
      this.awaitingKeyframe = true;
      return;
    }
    if (!this.videoConfigured || !sameBytes(this.sps, this.configuredSPS) || !sameBytes(this.pps, this.configuredPPS)) {
      try {
        this.configureVideo();
      } catch (error) {
        this.awaitingKeyframe = true;
        this.onFallback?.(error);
        return;
      }
    }
    if (this.awaitingKeyframe && !keyframe) return;
    this.awaitingKeyframe = false;

    const avcc = annexBToAVCC(payload);
    const timestampUs = this.clock.encode(timestampMs);
    const chunk = new EncodedVideoChunk({
      type: keyframe ? "key" : "delta",
      timestamp: timestampUs,
      data: avcc,
    });
    try {
      this.videoDecoder.decode(chunk);
    } catch (error) {
      this.awaitingKeyframe = true;
      this.onFallback?.(error);
    }
  }

  pushAudio(payload, timestampMs) {
    if (this.closed) return;
    this.clock.set(timestampMs);
    if (!this.audioDecoder) {
      try {
        this.configureAudio();
      } catch (error) {
        this.onFallback?.(error);
        return;
      }
    }
    const timestampUs = this.clock.encode(timestampMs);
    const chunk = new EncodedAudioChunk({
      type: "key",
      timestamp: timestampUs,
      data: payload,
    });
    try {
      this.audioDecoder.decode(chunk);
    } catch {
      // A single malformed Opus packet is not worth tearing down video for.
    }
  }

  configureVideo() {
    const description = buildAVCDecoderConfig(this.sps, this.pps);
    const codec = codecStringFromSPS(this.sps);
    if (this.videoDecoder) {
      try { this.videoDecoder.close(); } catch {}
    }
    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.queueFrame(frame),
      error: (error) => {
        console.warn("VideoDecoder decode error, resyncing on next keyframe:", error);
        this.resetVideo();
      },
    });
    this.videoDecoder.configure({
      codec,
      description,
      optimizeForLatency: true,
    });
    this.configuredSPS = this.sps ? this.sps.slice() : null;
    this.configuredPPS = this.pps ? this.pps.slice() : null;
    this.videoConfigured = true;
  }

  queueFrame(frame) {
    if (this.closed) {
      frame.close();
      return;
    }
    const due = this.clock.dueChunk(frame.timestamp);
    const now = performance.now();
    if (due < now - 2000) {
      frame.close();
      return;
    }
    this.frameQueue.push({ frame, due });
    // Bounded jitter buffer. Drop only frames that are excessively old.
    while (this.frameQueue.length && this.frameQueue[0].due < now - 800) {
      this.frameQueue.shift().frame.close();
    }
    if (this.frameQueue.length > 4) {
      while (this.frameQueue.length > 2) this.frameQueue.shift().frame.close();
    }
  }

  render() {
    if (this.closed) return;
    const now = performance.now();
    // Draw only the newest picture that became due. Drawing every queued frame
    // would burn a whole tick of CPU after a hitch and make motion look like it
    // is replaying in fast-forward.
    let latest = null;
    while (this.frameQueue.length && this.frameQueue[0].due <= now + 5) {
      if (latest) latest.frame.close();
      latest = this.frameQueue.shift();
    }
    if (latest) {
      this.draw(latest.frame);
      latest.frame.close();
    }
    this.raf = requestAnimationFrame(() => this.render());
  }

  /**
   * Drops queued pictures and moves the playout point to timestampMs.
   *
   * Pictures already inside the decoder come out with older timestamps, so
   * queueFrame discards them as late; the first new one plays almost
   * immediately.
   */
  resync(timestampMs) {
    this.clock.rebase(timestampMs, this.clock.delay);
    while (this.frameQueue.length > 1) {
      this.frameQueue.shift().frame.close();
    }
  }

  draw(frame) {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(frame, 0, 0, width, height);
  }

  configureAudio() {
    this.audioContext = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    this.gain = this.audioContext.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.audioContext.destination);
    this.audioBaseCtx = this.audioContext.currentTime - performance.now() / 1000;
    this.onAudioInfo?.({ sampleRate: this.audioContext.sampleRate, channels: 2 });

    this.audioDecoder = new AudioDecoder({
      output: (data) => this.playAudio(data),
      error: () => {},
    });
    this.audioDecoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      description: buildOpusHead(2),
    });
    void this.audioContext.resume();
  }

  playAudio(data) {
    try {
      const channels = data.numberOfChannels;
      const frames = data.numberOfFrames;
      const buffer = this.audioContext.createBuffer(channels, frames, data.sampleRate);
      for (let channel = 0; channel < channels; channel++) {
        const samples = new Float32Array(frames);
        try {
          data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
        } catch {
          data.copyTo(samples, { planeIndex: channel });
        }
        buffer.copyToChannel(samples, channel);
      }
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      const playAt = this.audioBaseCtx + this.clock.dueChunk(data.timestamp) / 1000;
      const now = this.audioContext.currentTime;
      if (playAt < now - 0.2) {
        // Too late to be useful; playing it would push audio further behind.
        return;
      }
      source.start(Math.max(playAt, now + 0.005));
    } catch {
      // Ignore a bad AudioData object.
    } finally {
      data.close();
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
    if (this.audioContext?.state === "suspended") void this.audioContext.resume();
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
    if (!this.muted && this.audioContext?.state === "suspended") void this.audioContext.resume();
  }

  resetVideo() {
    this.awaitingKeyframe = true;
    for (const item of this.frameQueue) item.frame.close();
    this.frameQueue = [];
    if (this.videoDecoder) {
      if (this.videoDecoder.state === "closed") {
        this.videoConfigured = false;
        try { this.configureVideo(); } catch {}
      } else {
        try { this.videoDecoder.reset(); } catch {}
        try { this.videoDecoder.configure(this.decoderConfig()); } catch {}
      }
    }
  }

  decoderConfig() {
    return {
      codec: codecStringFromSPS(this.sps),
      description: buildAVCDecoderConfig(this.sps, this.pps),
      optimizeForLatency: true,
    };
  }

  close() {
    this.closed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const item of this.frameQueue) item.frame.close();
    this.frameQueue = [];
    try { this.videoDecoder?.close(); } catch {}
    try { this.audioDecoder?.close(); } catch {}
    try { void this.audioContext?.close(); } catch {}
  }
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * OpusHead from RFC 7845. Chrome's AudioDecoder wants it as the codec
 * description for raw Opus packets; a minimal 19-byte, mapping-family-0 header
 * is enough for the stereo output the desktop app produces.
 */
function buildOpusHead(channels) {  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1; // version
  head[9] = channels;
  // pre-skip, little-endian (312 samples is the common encoder default)
  head[10] = 312 & 0xff;
  head[11] = (312 >> 8) & 0xff;
  // input sample rate, little-endian
  head[12] = 48000 & 0xff;
  head[13] = (48000 >> 8) & 0xff;
  head[14] = (48000 >> 16) & 0xff;
  head[15] = (48000 >> 24) & 0xff;
  // output gain (0) and mapping family (0) are already zero
  return head;
}
