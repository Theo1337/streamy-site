import { Transport } from "./transport.js";

const DEFAULT_SIGNAL_URL = "wss://streamy-signal.thenightserver.workers.dev";

/**
 * Browser mode: the original Cloudflare-signaled, peer-to-peer WebRTC path.
 * It is unchanged in behaviour; only its callbacks now go through Transport.
 */
export class WebRtcTransport extends Transport {
  constructor({ room, token, signalURL, iceServers }) {
    super();
    this.room = room;
    this.token = token;
    this.signalURL = signalURL || DEFAULT_SIGNAL_URL;
    this.iceServers = iceServers || [];
    this.socket = null;
    this.peer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.pingTimer = null;
  }

  async connect() {
    this.closedByUser = false;
    this.clearReconnect();
    this.closeSocket();
    this.resetPeer();
    this.emitStatus("Connecting to room", "pending");

    if (!/^[A-Za-z0-9_-]{16}$/.test(this.room) || !/^[A-Za-z0-9_-]{43}$/.test(this.token)) {
      this.fail(new Error("The room link has an invalid room ID or token."));
      return;
    }

    let url;
    try {
      url = new URL(this.signalURL);
    } catch {
      this.fail(new Error("The signaling server URL is invalid."));
      return;
    }
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      this.fail(new Error("The signaling URL must use WebSocket (ws or wss)."));
      return;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/room/${encodeURIComponent(this.room)}/ws`;
    url.search = "";
    url.hash = "";

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.fail(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let stableTimer = null;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      try {
        this.send({ v: 1, type: "hello", role: "viewer", token: this.token });
        this.startPing(socket);
        stableTimer = setTimeout(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) this.reconnectAttempt = 0;
        }, 30000);
        this.emitStatus("Joining room", "pending");
      } catch (error) {
        this.fail(error);
      }
    });

    socket.addEventListener("message", (event) => {
      void this.handleMessage(socket, event.data);
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.emitStatus("Signaling connection failed", "error");
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      clearTimeout(stableTimer);
      this.stopPing();
      this.socket = null;
      this.resetPeer();
      if (event.code === 4001) {
        this.emitStatus("Host ended the stream", "error");
        return;
      }
      if (event.code !== 1000 && !this.closedByUser) {
        this.emitStatus("Signaling disconnected", "error");
        this.scheduleReconnect();
      }
    });
  }

  close() {
    this.closedByUser = true;
    this.clearReconnect();
    this.stopPing();
    this.closeSocket();
    this.resetPeer();
    this.closed = true;
  }

  async handleMessage(source, raw) {
    let incoming;
    try {
      incoming = JSON.parse(raw);
    } catch {
      this.fail(new Error("The signaling server sent invalid JSON."));
      return;
    }
    if (incoming.v !== 1) {
      this.fail(new Error(`Unsupported signaling protocol version: ${incoming.v}`));
      return;
    }

    switch (incoming.type) {
      case "welcome":
        if (Array.isArray(incoming.iceServers)) {
          this.iceServers = mergeICEServers(this.iceServers, incoming.iceServers);
        }
        this.emitStatus(incoming.hostPresent ? "Waiting for host offer" : "Waiting for the host", "pending");
        break;
      case "peer-joined":
        if (incoming.role === "host") {
          this.emitStatus("Host connected; waiting for video", "pending");
        }
        break;
      case "offer":
        await this.answerOffer(incoming);
        break;
      case "candidate":
        if (this.peer && incoming.candidate) {
          try {
            await this.peer.addIceCandidate({
              candidate: incoming.candidate,
              sdpMid: incoming.sdpMid ?? null,
              sdpMLineIndex: incoming.sdpMLineIndex ?? null,
            });
          } catch (error) {
            this.fail(error);
          }
        }
        break;
      case "peer-left":
        if (incoming.role === "host") {
          this.resetPeer();
          this.emitStatus("Waiting for the host to reconnect", "pending");
        }
        break;
      case "ping":
        if (source === this.socket) this.send({ v: 1, type: "pong", t: incoming.t });
        break;
      case "error":
        this.fail(new Error(`${incoming.code || "signaling-error"}: ${incoming.message || "Connection rejected"}`));
        break;
      case "pong":
        break;
      default:
        console.warn("Ignoring unknown signaling message", incoming.type);
    }
  }

  async answerOffer(offer) {
    this.resetPeer();
    try {
      const connection = this.createPeer();
      await connection.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await waitForICEGathering(connection);
      this.send({
        v: 1,
        type: "answer",
        to: offer.from,
        sdp: JSON.stringify(connection.localDescription),
      });
      this.emitStatus("Answer sent; connecting", "pending");
    } catch (error) {
      this.fail(error);
      this.resetPeer();
    }
  }

  createPeer() {
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peer = connection;

    connection.addEventListener("track", (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.emitVideo({ kind: "stream", stream });
      this.emitAudio({ sampleRate: 48000, channels: 2 });
      void playMediaElement(event.track.kind);
    });

    connection.addEventListener("connectionstatechange", () => {
      if (this.peer !== connection) return;
      const state = connection.connectionState;
      this.emitStatus(connectionLabel(state), state === "connected" ? "connected" : state === "failed" ? "error" : "pending");
    });

    connection.addEventListener("iceconnectionstatechange", () => {
      if (this.peer === connection && connection.iceConnectionState === "disconnected") {
        this.emitStatus("Connection interrupted", "pending");
      }
    });

    return connection;
  }

  send(value) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The signaling socket is not connected.");
    }
    this.socket.send(JSON.stringify(value));
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer || this.reconnectAttempt >= 6) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    this.reconnectAttempt += 1;
    this.emitStatus(`Retrying signaling in ${Math.round(delay / 1000)} seconds…`, "pending");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // The signaling room only carries setup traffic. Without this the room sees a
  // silent socket, and an idle socket is closed and renegotiated every minute
  // even though the media track itself is healthy.
  startPing(socket) {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ v: 1, type: "ping", t: Date.now() }));
      } catch {
        // The close handler owns reconnecting; a failed keepalive just means
        // this socket is already on its way out.
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  closeSocket() {
    const old = this.socket;
    this.socket = null;
    if (old && old.readyState < WebSocket.CLOSING) old.close(1000, "reconnecting");
  }

  resetPeer() {
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
  }

  fail(error) {
    this.emitStatus("Could not connect", "error");
    this.emitAudio({ error: error instanceof Error ? error.message : String(error) });
  }
}

function connectionLabel(state) {
  switch (state) {
    case "connected": return "Connected";
    case "connecting": return "Connecting";
    case "disconnected": return "Interrupted";
    case "failed": return "Connection failed";
    case "closed": return "Disconnected";
    default: return "Negotiating";
  }
}

function mergeICEServers(preferred, additional) {
  const servers = [...preferred];
  const seen = new Set(servers.map((server) => JSON.stringify(server)));
  for (const server of additional) {
    const key = JSON.stringify(server);
    if (!seen.has(key)) {
      seen.add(key);
      servers.push(server);
    }
  }
  return servers;
}

function waitForICEGathering(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("ICE gathering timed out. Check network connectivity and try again."));
    }, 15000);
    const onStateChange = () => {
      if (connection.iceGatheringState === "complete") {
        cleanup();
        resolve();
      } else if (connection.signalingState === "closed") {
        cleanup();
        reject(new Error("Connection was closed before ICE gathering completed."));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onStateChange);
    };
    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

let mediaElement = null;

/** The app registers its <video> so a remote WebRTC track can autoplay. */
export function setMediaElement(element) {
  mediaElement = element;
}

async function playMediaElement(kind) {
  if (!mediaElement || kind !== "video") return;
  try {
    await mediaElement.play();
  } catch {
    // Autoplay is allowed because the player starts muted; if the browser
    // rejects it, the user can press play in the controls.
  }
}
