/**
 * Fragmented-MP4 fallback for browsers without WebCodecs.
 *
 * The relay sends Annex-B H.264 and raw Opus packets, which Media Source
 * Extensions cannot consume directly. This file builds the smallest valid
 * fragmented MP4 around them:
 *
 *   ftyp + moov (one avc1 track, one Opus track)
 *   moof + mdat per access unit / Opus packet
 *
 * Video and audio live in separate SourceBuffers on the same MediaSource, so
 * the browser keeps them on one timeline. Timestamps are relative to the first
 * media frame the player sees.
 */

const VIDEO_TIMESCALE = 90000;
const AUDIO_TIMESCALE = 48000;
const VIDEO_MIME = 'video/mp4; codecs="avc1.42E01E"';
const AUDIO_MIME = 'audio/mp4; codecs="opus"';

export class MsePlayer {
  static supported() {
    if (typeof window === "undefined" || typeof window.MediaSource !== "function") return false;
    return MediaSource.isTypeSupported(VIDEO_MIME) ||
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f"') ||
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"');
  }

  constructor({ video, onAudioInfo, onStatus, onError }) {
    this.video = video;
    this.onAudioInfo = onAudioInfo;
    this.onStatus = onStatus;
    this.onError = onError;

    this.mediaSource = null;
    this.objectURL = null;
    this.videoBuffer = null;
    this.audioBuffer = null;
    this.audioSupported = false;

    this.videoConfig = null;
    this.originMs = null;
    this.started = false;
    this.starting = false;
    this.closed = false;

    this.videoQueue = [];
    this.audioQueue = [];
    this.prebuffer = [];
    this.videoAppending = false;
    this.audioAppending = false;
    this.sequence = 0;

    this.lastVideoMs = null;
    this.lastAudioMs = null;
    this.lastVideoBase = -1;
    this.lastAudioBase = -1;
    this.lastSeekCheck = 0;
    this.lastCleanup = 0;

    this.muted = true;
    this.volume = 0.75;
    if (this.video) {
      this.video.muted = true;
      this.video.volume = 0;
    }
  }

  /** Must be called with the SPS/PPS used by the next keyframe. */
  configureVideo({ sps, pps, width, height, codec }) {
    if (!sps || !pps || !width || !height) return false;
    const signature = `${width}x${height}:${codec}`;
    if (this.videoConfig) {
      if (this.videoConfig.signature !== signature) {
        this.onError?.(new Error("The stream changed resolution; waiting for a new keyframe."));
        this.videoConfig = null;
        return false;
      }
      return true;
    }
    this.videoConfig = {
      sps,
      pps,
      width,
      height,
      codec: codec || "avc1.42E01E",
      signature,
    };
    return true;
  }

  pushVideo(payload, timestampMs, keyframe) {
    if (this.closed) return;
    if (!this.videoConfig) return;
    if (!this.started) {
      this.prebuffer.push({ kind: "video", payload, timestampMs, keyframe });
      this.trimPrebuffer();
      this.start();
      return;
    }
    this.appendVideo(payload, timestampMs, keyframe);
  }

  pushAudio(payload, timestampMs) {
    if (this.closed) return;
    if (!this.started) {
      this.prebuffer.push({ kind: "audio", payload, timestampMs });
      this.trimPrebuffer();
      this.start();
      return;
    }
    this.appendAudio(payload, timestampMs);
  }

  trimPrebuffer() {
    // At most a couple of seconds of audio can arrive before the first video
    // keyframe. Keeping more only adds latency.
    if (this.prebuffer.length > 150) this.prebuffer.splice(0, this.prebuffer.length - 150);
  }

  start() {
    if (this.started || this.starting || this.closed) return;
    if (!this.videoConfig) return;
    const source = new MediaSource();
    this.mediaSource = source;
    this.objectURL = URL.createObjectURL(source);
    this.video.src = this.objectURL;
    this.video.muted = this.muted;
    this.video.volume = this.muted ? 0 : this.volume;

    const onOpen = () => {
      try {
        const mime = `video/mp4; codecs="${this.videoConfig.codec}"`;
        this.videoBuffer = source.addSourceBuffer(MediaSource.isTypeSupported(mime) ? mime : VIDEO_MIME);
        this.videoBuffer.mode = "segments";
        this.videoBuffer.addEventListener("updateend", () => this.pumpVideo());
        this.videoBuffer.addEventListener("error", () => this.fail(new Error("The video buffer rejected the stream.")));

        this.audioSupported = MediaSource.isTypeSupported(AUDIO_MIME);
        if (this.audioSupported) {
          this.audioBuffer = source.addSourceBuffer(AUDIO_MIME);
          this.audioBuffer.mode = "segments";
          this.audioBuffer.addEventListener("updateend", () => this.pumpAudio());
          this.audioBuffer.addEventListener("error", () => {
            this.audioSupported = false;
            this.audioBuffer = null;
            this.onAudioInfo?.({ unsupported: true });
          });
          this.onAudioInfo?.({ sampleRate: 48000, channels: 2 });
        } else {
          this.onAudioInfo?.({ unsupported: true });
        }

        this.appendInit();
        this.started = true;
        this.starting = false;
        this.onStatus?.("Live (compatibility mode)", "connected");

        for (const item of this.prebuffer) {
          if (item.kind === "video") this.appendVideo(item.payload, item.timestampMs, item.keyframe);
          else this.appendAudio(item.payload, item.timestampMs);
        }
        this.prebuffer = [];

        const playing = this.video.play();
        if (playing && typeof playing.catch === "function") {
          // Muted autoplay normally succeeds. If the browser still blocks it,
          // keep the stream attached and let the normal controls handle it.
          playing.catch(() => {});
        }
      } catch (error) {
        this.starting = false;
        this.fail(error);
      }
    };

    this.starting = true;
    if (source.readyState === "open") onOpen();
    else source.addEventListener("sourceopen", onOpen, { once: true });
  }

  appendInit() {
    const config = this.videoConfig;
    this.appendVideoBytes(buildInitSegment({
      width: config.width,
      height: config.height,
      sps: config.sps,
      pps: config.pps,
      audio: this.audioSupported,
    }));
    if (this.audioSupported) this.appendAudioBytes(buildInitSegment({ audioOnly: true }));
  }

  appendVideo(payload, timestampMs, keyframe) {
    const base = this.baseTime(timestampMs, "video");
    if (base < 0) return;
    const duration = this.sampleDuration(timestampMs, "video", 33.33);
    const sample = annexBToLengthPrefixed(payload);
    const flags = keyframe ? 0x02000000 : 0x01010000;
    const fragment = buildFragment(1, base, duration, sample, flags, VIDEO_TIMESCALE, ++this.sequence);
    this.appendVideoBytes(fragment);
    this.schedulePlaybackCheck();
  }

  appendAudio(payload, timestampMs) {
    const base = this.baseTime(timestampMs, "audio");
    if (base < 0) return;
    const duration = this.sampleDuration(timestampMs, "audio", 20);
    const fragment = buildFragment(2, base, duration, payload, 0, AUDIO_TIMESCALE, ++this.sequence);
    this.appendAudioBytes(fragment);
  }

  baseTime(timestampMs, kind) {
    if (this.originMs === null) this.originMs = timestampMs;
    const relative = Math.max(0, timestampMs - this.originMs);
    const timescale = kind === "video" ? VIDEO_TIMESCALE : AUDIO_TIMESCALE;
    let base = Math.round(relative * timescale / 1000);
    if (kind === "video") {
      base = Math.max(base, this.lastVideoBase + 1);
      this.lastVideoBase = base;
    } else {
      base = Math.max(base, this.lastAudioBase + 1);
      this.lastAudioBase = base;
    }
    return base;
  }

  sampleDuration(timestampMs, kind, fallbackMs) {
    const last = kind === "video" ? this.lastVideoMs : this.lastAudioMs;
    let duration = last === null ? fallbackMs : timestampMs - last;
    if (!Number.isFinite(duration) || duration <= 0) duration = fallbackMs;
    duration = Math.min(Math.max(duration, 1), 1000);
    if (kind === "video") this.lastVideoMs = timestampMs;
    else this.lastAudioMs = timestampMs;
    return Math.round(duration * (kind === "video" ? VIDEO_TIMESCALE : AUDIO_TIMESCALE) / 1000);
  }

  appendVideoBytes(bytes) {
    this.videoQueue.push(bytes);
    this.pumpVideo();
  }

  appendAudioBytes(bytes) {
    if (!this.audioBuffer) return;
    this.audioQueue.push(bytes);
    this.pumpAudio();
  }

  pumpVideo() {
    if (!this.videoBuffer || this.videoBuffer.updating) return;
    const next = this.videoQueue.shift();
    if (!next) return;
    try {
      this.videoBuffer.appendBuffer(next);
    } catch (error) {
      this.fail(error);
    }
  }

  pumpAudio() {
    if (!this.audioBuffer || this.audioBuffer.updating) return;
    const next = this.audioQueue.shift();
    if (!next) return;
    try {
      this.audioBuffer.appendBuffer(next);
    } catch {
      this.audioQueue = [];
    }
  }

  /** Keep playback close to the live edge; MSE otherwise drifts behind. */
  schedulePlaybackCheck() {
    const now = performance.now();
    if (now - this.lastSeekCheck < 500) return;
    this.lastSeekCheck = now;

    const ranges = this.video.buffered;
    if (!ranges.length) return;
    const end = ranges.end(ranges.length - 1);
    const start = ranges.start(0);
    // Half a second of slack absorbs network jitter; beyond that, watching the
    // buffer drain would just mean watching the stream get later and later.
    if (end - this.video.currentTime > 0.7) {
      this.video.currentTime = Math.max(start, end - 0.2);
    } else if (this.video.currentTime < start) {
      this.video.currentTime = start;
    }

    if (now - this.lastCleanup > 10000 && this.video.currentTime > 30) {
      this.lastCleanup = now;
      const removeTo = this.video.currentTime - 15;
      if (removeTo > start) {
        this.remove(this.videoBuffer, 0, removeTo);
        if (this.audioBuffer) this.remove(this.audioBuffer, 0, removeTo);
      }
    }
  }

  remove(buffer, start, end) {
    if (!buffer || buffer.updating || buffer.removed) return;
    try {
      buffer.remove(start, end);
    } catch {
      // Removing an empty range is harmless.
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.video) this.video.volume = this.muted ? 0 : this.volume;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.video) {
      this.video.muted = this.muted;
      this.video.volume = this.muted ? 0 : this.volume;
    }
  }

  fail(error) {
    if (this.closed) return;
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  close() {
    this.closed = true;
    this.videoQueue = [];
    this.audioQueue = [];
    this.prebuffer = [];
    try { this.videoBuffer?.abort(); } catch {}
    try { this.audioBuffer?.abort(); } catch {}
    if (this.mediaSource && this.mediaSource.readyState === "open") {
      try { this.mediaSource.endOfStream(); } catch {}
    }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      try { this.video.load(); } catch {}
    }
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.objectURL = null;
    this.mediaSource = null;
    this.videoBuffer = null;
    this.audioBuffer = null;
  }
}

/* ------------------------------------------------------------------ */
/* fMP4 boxes                                                          */
/* ------------------------------------------------------------------ */

function buildInitSegment({ width = 0, height = 0, sps = null, pps = null, audio = false, audioOnly = false }) {
  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso6"), str("mp41"), str("avc1"));
  const tracks = [];
  if (!audioOnly) tracks.push(videoTrak(width, height, sps, pps));
  if (audio || audioOnly) tracks.push(audioTrak());
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(0),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    matrix(), new Uint8Array(24), u32(tracks.length + 1));
  return concat(ftyp, box("moov", mvhd, ...tracks));
}

function videoTrak(width, height, sps, pps) {
  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0),
    u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
    matrix(), u32(width * 65536), u32(height * 65536));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(VIDEO_TIMESCALE), u32(0),
    u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), str("vide"), new Uint8Array(12), strZ("VideoHandler"));
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const avcC = buildAvcC(sps, pps);
  const avc1 = box("avc1",
    new Uint8Array(6), u16(1),
    u16(0), u16(0), u32(0), u32(0), u32(0),
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    new Uint8Array(32), u16(0x0018), u16(0xffff),
    avcC);
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stbl = box("stbl", stsd,
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)));
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("trak", tkhd, mdia);
}

function audioTrak() {
  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(2), u32(0), u32(0),
    u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0),
    matrix(), u32(0), u32(0));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(AUDIO_TIMESCALE), u32(0),
    u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), str("soun"), new Uint8Array(12), strZ("SoundHandler"));
  const smhd = fullBox("smhd", 0, 0, u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const dOps = box("dOps", u8(0), u8(2), u16(312), u32(48000), u16(0), u8(0));
  const opus = box("Opus",
    new Uint8Array(6), u16(1),
    u16(0), u16(0), u32(0),
    u16(2), u16(16), u16(0), u16(0), u32(48000 * 65536),
    dOps);
  const stsd = fullBox("stsd", 0, 0, u32(1), opus);
  const stbl = box("stbl", stsd,
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)));
  const minf = box("minf", smhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("trak", tkhd, mdia);
}

function buildFragment(trackID, baseTime, duration, sample, flags, timescale, sequence) {
  const mfhd = fullBox("mfhd", 0, 0, u32(sequence));
  const tfhd = fullBox("tfhd", 0, 0x020000, u32(trackID));
  const tfdt = fullBox("tfdt", 1, 0, u64(baseTime));
  const trun = () => fullBox("trun", 0, 0x000701, u32(1), u32(0),
    u32(duration), u32(sample.length), u32(flags));
  // The data offset is relative to the start of the moof. Rebuild once the
  // final size is known (box headers are included in that size).
  let moof = box("moof", mfhd, box("traf", tfhd, tfdt, trun()));
  const dataOffset = moof.length + 8;
  const trunWithOffset = fullBox("trun", 0, 0x000701, u32(1), u32(dataOffset),
    u32(duration), u32(sample.length), u32(flags));
  moof = box("moof", mfhd, box("traf", tfhd, tfdt, trunWithOffset));
  const mdat = box("mdat", sample);
  return concat(moof, mdat);
}

function buildAvcC(sps, pps) {
  const spsBytes = stripEmulationPrevention(sps);
  const ppsBytes = stripEmulationPrevention(pps);
  return box("avcC",
    u8(1), u8(spsBytes[1] ?? 0x42), u8(spsBytes[2] ?? 0xe0), u8(spsBytes[3] ?? 0x1f),
    u8(0xff), u8(0xe1), u16(spsBytes.length), spsBytes,
    u8(1), u16(ppsBytes.length), ppsBytes);
}

function stripEmulationPrevention(nal) {
  if (!nal) return new Uint8Array(0);
  const bytes = nal instanceof Uint8Array ? nal : new Uint8Array(nal);
  const out = new Uint8Array(bytes.length);
  let zeros = 0;
  let offset = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[offset++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, offset);
}

function annexBToLengthPrefixed(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const starts = [];
  for (let i = 0; i + 2 < bytes.length;) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push({ index: i, length: 3 });
      i += 3;
    } else if (i + 3 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      starts.push({ index: i, length: 4 });
      i += 4;
    } else {
      i += 1;
    }
  }
  const nals = [];
  let size = 0;
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : bytes.length;
    const nalStart = start.index + start.length;
    if (nalStart >= end) continue;
    nals.push(bytes.subarray(nalStart, end));
    size += 4 + (end - nalStart);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    const length = nal.length;
    out[offset] = (length >>> 24) & 0xff;
    out[offset + 1] = (length >>> 16) & 0xff;
    out[offset + 2] = (length >>> 8) & 0xff;
    out[offset + 3] = length & 0xff;
    out.set(nal, offset + 4);
    offset += 4 + length;
  }
  return out;
}

function matrix() {
  return concat(
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  );
}

function box(type, ...parts) {
  const payload = concat(...parts);
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  writeType(out, 4, type);
  out.set(payload, 8);
  return out;
}

function fullBox(type, version, flags, ...parts) {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >>> 16) & 0xff;
  header[2] = (flags >>> 8) & 0xff;
  header[3] = flags & 0xff;
  return box(type, header, ...parts);
}

function u8(value) {
  return new Uint8Array([value & 0xff]);
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function str(value) {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

function strZ(value) {
  return concat(str(value), u8(0));
}

function writeType(target, offset, type) {
  for (let i = 0; i < 4; i++) target[offset + i] = type.charCodeAt(i) & 0xff;
}

function concat(...parts) {
  let size = 0;
  for (const part of parts) {
    if (part) size += part.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    if (!part) continue;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
