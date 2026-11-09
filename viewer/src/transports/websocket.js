import { codecStringFromSPS, inspectAccessUnit, parseSPSDimensions } from "./annexb.js";
import { MsePlayer } from "./mse.js";
import { MediaClock, WebCodecsPlayer } from "./webcodecs.js";
import { Transport } from "./transport.js";

const HEADER_SIZE = 10;
const KIND_VIDEO = 0x01;
const KIND_AUDIO = 0x02;
const FLAG_KEYFRAME = 0x01;

/**
 * Activity mode: a WebSocket relay fans the host's encoded H.264 and Opus
 * packets out to every viewer. The transport hides whether the browser decodes
 * them with WebCodecs (canvas) or the MSE fallback (shared <video>).
 */
export class WebSocketTransport extends Transport {
  constructor({ room, relayURL, canvas, video, activity = false }) {
    super();
    this.room = room;
    this.relayURL = relayURL;
    this.canvas = canvas;
    this.video = video;
    this.activity = activity;

    this.socket = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;
    this.closedByUser = false;

    this.clock = null;
    this.player = null;
    this.mode = null;
    this.preferWebCodecs = WebCodecsPlayer.supported();
    this.fallbackPending = false;

    this.sps = null;
    this.pps = null;
    this.width = 0;
    this.height = 0;
    this.codec = null;

    this.awaitingKeyframe = true;
    this.lastVideoTimestamp = 0;
  }

  watchURL() {
    if (this.activity) {
      // Discord's proxy URL mapping sends /relay to the VPS. A relative URL is
      // mandatory here: discordsays.com cannot resolve the relay host itself.
      const base = new URL(`/.proxy/relay/v1/watch/${encodeURIComponent(this.room)}`, location.origin);
      base.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return base.toString();
    }
    const base = new URL(this.relayURL || location.origin);
    if (base.protocol === "https:") base.protocol = "wss:";
    if (base.protocol === "http:") base.protocol = "ws:";
    if (base.protocol !== "wss:" && base.protocol !== "ws:") {
      throw new Error("The relay URL must use ws or wss.");
    }
    const prefix = this.relayURL ? "" : "/.proxy/relay";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${prefix}/v1/watch/${encodeURIComponent(this.room)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }

  async connect() {
    this.closedByUser = false;
    this.clearReconnect();
    this.closeSocket();
    this.resetPlayback();
    this.emitStatus("Connecting to the relay", "pending");

    let url;
    try {
      url = this.watchURL();
    } catch (error) {
      this.fail(error);
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.fail(error);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      try {
        socket.send(JSON.stringify({ v: 1, type: "hello", role: "viewer" }));
        this.emitStatus("Joining the stream", "pending");
        this.startPing(socket);
      } catch (error) {
        this.fail(error);
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") this.handleControl(event.data);
      else this.handleMedia(event.data);
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.emitStatus("Relay connection failed", "error");
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.stopPing();
      this.socket = null;
      this.resetPlayback();
      if (this.closedByUser) return;

      switch (event.code) {
        case 4001:
          this.emitStatus("Host ended the stream; waiting for a new one", "pending");
          this.scheduleReconnect();
          break;
        case 4003:
          this.emitStatus("This stream is full", "error");
          this.scheduleReconnect(15000);
          break;
        case 4004:
          this.emitStatus("This connection fell behind; reconnecting", "pending");
          this.scheduleReconnect(1500);
          break;
        case 4008:
          this.emitStatus("The relay rejected this viewer", "error");
          break;
        default:
          this.emitStatus("Stream disconnected; reconnecting", "pending");
          this.scheduleReconnect();
      }
    });
  }

  handleControl(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.v !== 1) {
      this.fail(new Error(`Unsupported relay protocol version: ${message.v}`));
      return;
    }
    switch (message.type) {
      case "ready":
        this.emitStatus("Waiting for the host to go live", "pending");
        break;
      case "error":
        if (message.code === "publisher-gone" || message.code === "room-in-use") {
          this.emitStatus("Waiting for the host to go live", "pending");
        } else {
          this.emitStatus(message.message || "The relay rejected the connection", "error");
        }
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  handleMedia(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_SIZE) return;
    const view = new DataView(buffer);
    const kind = view.getUint8(0);
    const flags = view.getUint8(1);
    const timestamp = Number(view.getBigUint64(2, false));
    const payload = new Uint8Array(buffer, HEADER_SIZE);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;

    if (kind === KIND_VIDEO) {
      this.receiveVideo(payload, timestamp, (flags & FLAG_KEYFRAME) !== 0);
    } else if (kind === KIND_AUDIO) {
      this.receiveAudio(payload, timestamp);
    }
  }

  receiveVideo(payload, timestamp, keyframeFlag) {
    const info = inspectAccessUnit(payload);
    if (info.sps) {
      this.sps = info.sps;
      const dimensions = parseSPSDimensions(info.sps);
      if (dimensions.width > 0 && dimensions.height > 0) {
        this.width = dimensions.width;
        this.height = dimensions.height;
      }
      this.codec = codecStringFromSPS(info.sps);
    }
    if (info.pps) this.pps = info.pps;

    const keyframe = keyframeFlag || info.hasIDR;
    if (this.awaitingKeyframe && !keyframe) return;
    if (timestamp < this.lastVideoTimestamp - 1000) {
      // The publisher restarted its capture; the next IDR re-establishes a
      // clean reference.
      this.awaitingKeyframe = true;
      this.resetPlayback();
      return;
    }

    if (!this.ensurePlayer()) return;
    this.clock.set(timestamp);

    // Clock skew between the publisher and this machine makes an absolute
    // "this frame is old" test useless. Lateness relative to the stream's own
    // playout point is what matters: if this frame was due seconds ago, the
    // tab or the network stalled and the deltas in between are worthless.
    if (!keyframe && performance.now() - this.clock.due(timestamp) > 2500) {
      this.awaitingKeyframe = true;
      if (this.mode === "webcodecs") {
        this.player?.resetVideo?.();
      } else {
        this.resetPlayback();
      }
      return;
    }
    if (keyframe) {
      this.awaitingKeyframe = false;
      this.reconnectAttempt = 0;
    }
    this.lastVideoTimestamp = timestamp;

    if (this.mode === "webcodecs") {
      this.player.pushVideo(payload, timestamp, keyframe);
    } else if (this.mode === "mse") {
      const configured = this.player.configureVideo({
        sps: this.sps,
        pps: this.pps,
        width: this.width,
        height: this.height,
        codec: this.codec,
      });
      if (!configured) return;
      this.player.pushVideo(payload, timestamp, keyframe);
    }
  }

  receiveAudio(payload, timestamp) {
    if (!this.ensurePlayer()) return;
    this.clock.set(timestamp);
    this.player.pushAudio(payload, timestamp);
  }

  ensurePlayer() {
    if (this.player) return true;
    if (!this.canvas || !this.video) return false;

    if (this.preferWebCodecs && !this.fallbackPending) {
      this.clock = this.clock || new MediaClock();
      this.player = new WebCodecsPlayer({
        canvas: this.canvas,
        clock: this.clock,
        onAudioInfo: (info) => this.emitAudio(info),
        onFallback: (error) => this.fallbackToMSE(error),
      });
      this.mode = "webcodecs";
      this.emitVideo({ kind: "canvas", canvas: this.canvas });
      this.emitStatus("Live", "connected");
      return true;
    }

    if (!MsePlayer.supported()) {
      this.fail(new Error("This browser supports neither WebCodecs H.264 nor MSE H.264 playback. Use a current Chrome, Edge, Safari or Firefox."));
      return false;
    }
    this.clock = this.clock || new MediaClock();
    this.player = new MsePlayer({
      video: this.video,
      onAudioInfo: (info) => this.emitAudio(info),
      onStatus: (text, state) => this.emitStatus(text, state),
      onError: (error) => this.fail(error),
    });
    this.mode = "mse";
    this.emitVideo({ kind: "element", element: this.video });
    this.emitStatus("Live (compatibility mode)", "connected");
    return true;
  }

  fallbackToMSE(error) {
    if (this.fallbackPending || this.mode !== "webcodecs") {
      if (this.mode === "webcodecs") this.fail(error);
      return;
    }
    console.warn("WebCodecs failed; switching to MSE", error);
    this.fallbackPending = true;
    this.awaitingKeyframe = true;
    this.emitStatus("Switching to the compatibility player", "pending");
    this.resetPlayback();
    this.preferWebCodecs = false;
  }

  resetPlayback() {
    if (this.player) {
      try { this.player.close(); } catch {}
    }
    this.player = null;
    this.mode = null;
    this.clock = null;
    this.awaitingKeyframe = true;
    this.lastVideoTimestamp = 0;
  }

  reconnect() {
    this.reconnectAttempt = 0;
    this.fallbackPending = false;
    this.preferWebCodecs = WebCodecsPlayer.supported();
    this.clearReconnect();
    return this.connect();
  }

  setVolume(value) {
    this.player?.setVolume?.(value);
  }

  setMuted(muted) {
    this.player?.setMuted?.(muted);
  }

  startPing(socket) {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: "ping", t: Date.now() }));
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(delayOverride) {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = delayOverride ?? Math.min(1000 * 2 ** Math.min(this.reconnectAttempt, 5), 30000);
    this.reconnectAttempt += 1;
    if (!delayOverride) {
      this.emitStatus(`Reconnecting in ${Math.round(delay / 1000)} seconds…`, "pending");
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  closeSocket() {
    this.stopPing();
    const old = this.socket;
    this.socket = null;
    if (old && old.readyState < WebSocket.CLOSING) old.close(1000, "leaving");
  }

  fail(error) {
    this.emitStatus("Could not play the stream", "error");
    this.emitAudio({ error: error instanceof Error ? error.message : String(error) });
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    this.closeSocket();
    this.resetPlayback();
    this.closed = true;
  }
}
