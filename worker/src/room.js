import {
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  DEFAULT_MAX_VIEWERS,
  clampViewerLimit,
  constantTimeEqual,
  errorMessage,
  isValidToken,
  randomID,
  rateLimit,
} from "./protocol.js";
import { verifyIdentityToken } from "./identity.js";

const MAX_VIEWER_HARD_CAP = 20;
const MAX_REASON_LENGTH = 120;
const CLOSE_POLICY = 1008;
const CLOSE_PROTOCOL = 1002;
const CLOSE_INTERNAL = 1011;
const CLOSE_HOST_GONE = 4001;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.roomID = await this.state.storage.get("roomID");
      this.token = await this.state.storage.get("token");
      this.publicToken = await this.state.storage.get("publicToken");
      this.profile = await this.state.storage.get("profile");
      this.iceServers = await this.state.storage.get("iceServers") || [];
      this.maxViewers = await this.state.storage.get("maxViewers") || DEFAULT_MAX_VIEWERS;
    });
  }

  async updateLobby() {
    const hostPresent = this.state.getWebSockets().some((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment.authenticated && !attachment.removed && attachment.role === "host";
    });
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("public"));
    const response = hostPresent && this.publicToken && this.profile
      ? await lobby.fetch("https://lobby/streams", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room: this.roomID,
          token: this.publicToken,
          name: this.profile.name,
          avatar: this.profile.avatar,
          iceServers: this.iceServers,
          viewerCount: this.state.getWebSockets().filter((socket) => {
            const attachment = socket.deserializeAttachment();
            return attachment.authenticated && !attachment.removed && attachment.role === "viewer";
          }).length,
        }),
      })
      : await lobby.fetch(`https://lobby/streams/${encodeURIComponent(this.roomID)}`, { method: "DELETE" });
    if (!response.ok) {
      throw new Error(`Lobby update failed (${response.status})`);
    }

  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    this.roomID = new URL(request.url).pathname.split("/")[3] || "";
    await this.state.storage.put("roomID", this.roomID);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      authenticated: false,
      peerID: "",
      role: "",
      lastMessage: Date.now(),
      messageTimes: [],
      candidateTimes: [],
    });
    await this.state.storage.setAlarm(Date.now() + 10_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    try {
      const attachment = socket.deserializeAttachment();
      if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
        this.reject(socket, "bad-message", "Messages must be text and no larger than 64 KiB", CLOSE_POLICY);
        return;
      }
      const message = JSON.parse(raw);
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.reject(socket, "bad-message", "Expected a JSON object", CLOSE_POLICY);
        return;
      }
      if (message.v !== PROTOCOL_VERSION) {
        this.reject(socket, "unsupported-version", "This room supports protocol version 1", CLOSE_PROTOCOL);
        return;
      }

      attachment.lastMessage = Date.now();
      if (!attachment.authenticated) {
        await this.hello(socket, attachment, message);
        return;
      }
      if (rateLimit(attachment, attachment.lastMessage, message.type === "candidate")) {
        socket.serializeAttachment(attachment);
        this.reject(socket, "rate-limited", "Message rate limit exceeded", CLOSE_POLICY);
        return;
      }
      socket.serializeAttachment(attachment);
      await this.handleMessage(socket, attachment, message);
    } catch (error) {
      console.error("Room message handler failed", error);
      this.reject(socket, "internal", "The signaling server encountered an internal error", CLOSE_INTERNAL);
    }
  }

  async hello(socket, attachment, message) {
    if (message.type !== "hello") {
      this.reject(socket, "bad-message", "The first message must be hello", CLOSE_POLICY);
      return;
    }
    if (message.role !== "host" && message.role !== "viewer") {
      this.reject(socket, "bad-message", "role must be host or viewer", CLOSE_POLICY);
      return;
    }
    if (!isValidToken(message.token)) {
      this.reject(socket, "unauthorized", "A valid room token is required", CLOSE_POLICY);
      return;
    }
    if (message.role === "host" && !validICEServers(message.iceServers || [])) {
      this.reject(socket, "bad-message", "The host ICE server list is invalid", CLOSE_POLICY);
      return;
    }
    let hostProfile = null;
    if (message.role === "host") {
      hostProfile = await verifyIdentityToken(message.identityToken, this.env.DISCORD_IDENTITY_SECRET);
      if (!hostProfile) {
        this.reject(socket, "discord-login-required", "Sign in with Discord in Streamy before starting a public stream", CLOSE_POLICY);
        return;
      }
    }

    const sockets = this.state.getWebSockets();
    const existingHost = sockets.find((peer) => {
      const peerAttachment = peer.deserializeAttachment();
      return peerAttachment.authenticated && !peerAttachment.removed && peerAttachment.role === "host";
    });
    if (message.role === "host") {
      if (this.token && !constantTimeEqual(this.token, message.token)) {
        this.reject(socket, "unauthorized", "The room token is invalid", CLOSE_POLICY);
        return;
      }
      if (existingHost) {
        this.reject(socket, "room-in-use", "A host is already connected to this room", CLOSE_POLICY);
        return;
      }
      this.token ||= message.token;
      this.publicToken ||= randomID(32);
      this.profile = hostProfile;
      this.iceServers = message.iceServers || [];
      this.maxViewers = clampViewerLimit(message.maxViewers, MAX_VIEWER_HARD_CAP);
      await this.state.storage.put({
        token: this.token,
        publicToken: this.publicToken,
        profile: this.profile,
        iceServers: this.iceServers,
        maxViewers: this.maxViewers,
      });
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete("hostGoneAt");
    } else if (!this.publicToken || !constantTimeEqual(this.publicToken, message.token)) {
      this.reject(socket, "unauthorized", "The room token is invalid", CLOSE_POLICY);
      return;
    }

    const viewers = sockets.filter((peer) => {
      const peerAttachment = peer.deserializeAttachment();
      return peerAttachment.authenticated && !peerAttachment.removed && peerAttachment.role === "viewer";
    });
    if (message.role === "viewer" && viewers.length >= this.maxViewers) {
      this.reject(socket, "room-full", "The room has reached its viewer limit", CLOSE_POLICY);
      return;
    }

    const peerID = randomID(6);
    attachment.authenticated = true;
    attachment.peerID = peerID;
    attachment.role = message.role;
    attachment.messageTimes = [];
    attachment.candidateTimes = [];
    socket.serializeAttachment(attachment);

    const currentSockets = this.state.getWebSockets();
    const currentViewers = currentSockets.filter((peer) =>
      peer.deserializeAttachment().authenticated &&
      !peer.deserializeAttachment().removed &&
      peer.deserializeAttachment().role === "viewer",
    );
    const hostPresent = message.role === "host" || currentSockets.some((peer) => {
      const peerAttachment = peer.deserializeAttachment();
      return peerAttachment.authenticated && !peerAttachment.removed && peerAttachment.role === "host";
    });
    this.send(socket, {
      v: PROTOCOL_VERSION,
      type: "welcome",
      room: this.roomID,
      peerID,
      role: message.role,
      token: message.role === "host" ? this.token : message.token,
      hostPresent,
      viewerCount: currentViewers.length,
      maxViewers: this.maxViewers,
      ...((this.iceServers.length || this.readICEServers())
        ? { iceServers: [...this.iceServers, ...(this.readICEServers() || [])] }
        : {}),
    });

    if (message.role === "host") {
      for (const viewer of currentViewers) {
        this.send(socket, {
          v: PROTOCOL_VERSION,
          type: "peer-joined",
          peerID: viewer.deserializeAttachment().peerID,
          role: "viewer",
        });
      }
      for (const viewer of currentViewers) {
        this.send(viewer, { v: PROTOCOL_VERSION, type: "peer-joined", peerID, role: "host" });
      }
    } else {
      if (existingHost) {
        this.send(existingHost, { v: PROTOCOL_VERSION, type: "peer-joined", peerID, role: "viewer" });
      }
      for (const peer of currentSockets) {
        const peerAttachment = peer.deserializeAttachment();
        if (peer !== socket && peerAttachment.authenticated && peerAttachment.role === "viewer") {
          this.send(peer, { v: PROTOCOL_VERSION, type: "peer-joined", peerID, role: "viewer" });
        }
      }
    }
    await this.updateLobby();
    await this.scheduleMaintenance();
  }

  async handleMessage(socket, attachment, message) {
    switch (message.type) {
      case "ping":
        this.send(socket, { v: PROTOCOL_VERSION, type: "pong", t: Number(message.t) || 0 });
        return;
      case "pong":
        return;
      case "bye":
        await this.removePeer(socket, attachment, "bye");
        socket.close(1000, "leaving");
        return;
      case "offer":
      case "answer":
        if (typeof message.sdp !== "string" || message.sdp.length === 0 || message.sdp.length > MAX_MESSAGE_BYTES / 2) {
          this.sendError(socket, "bad-message", "sdp must be a non-empty string within the size limit", false);
          return;
        }
        break;
      case "candidate":
        if (typeof message.candidate !== "string" || message.candidate.length > 4096) {
          this.sendError(socket, "bad-message", "candidate must be a string within the size limit", false);
          return;
        }
        break;
      default:
        this.sendError(socket, "bad-message", "Unknown message type", false);
        return;
    }

    if ((message.type === "offer" && attachment.role !== "host") ||
        (message.type === "answer" && attachment.role !== "viewer")) {
      this.sendError(socket, "bad-message", "The peer role cannot send this message type", false);
      return;
    }
    const targets = this.findTargets(socket, message.to);
    const forwarded = {
      v: PROTOCOL_VERSION,
      type: message.type,
      from: attachment.peerID,
      ...(message.to ? { to: message.to } : {}),
      ...(message.sdp ? { sdp: message.sdp } : {}),
      ...(message.type === "candidate" ? {
        candidate: message.candidate,
        ...(typeof message.sdpMid === "string" ? { sdpMid: message.sdpMid } : {}),
        ...(Number.isInteger(message.sdpMLineIndex) ? { sdpMLineIndex: message.sdpMLineIndex } : {}),
      } : {}),
    };
    for (const target of targets) this.send(target, forwarded);
  }

  findTargets(sender, recipientID) {
    const senderAttachment = sender.deserializeAttachment();
    return this.state.getWebSockets().filter((socket) => {
      if (socket === sender) return false;
      const attachment = socket.deserializeAttachment();
      if (!attachment.authenticated) return false;
      const allowedRole = senderAttachment.role === "host" ? "viewer" : "host";
      if (attachment.role !== allowedRole) return false;
      if (recipientID) return attachment.peerID === recipientID;
      return senderAttachment.role === "host"
        ? attachment.role === "viewer"
        : attachment.role === "host";
    });
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    await this.removePeer(socket, attachment, "disconnected");
  }

  async webSocketError(socket) {
    const attachment = socket.deserializeAttachment();
    await this.removePeer(socket, attachment, "socket-error");
  }

  async removePeer(socket, attachment, reason) {
    if (!attachment?.authenticated || attachment.removed) return;
    attachment.removed = true;
    socket.serializeAttachment(attachment);
    for (const peer of this.state.getWebSockets()) {
      const other = peer.deserializeAttachment();
      if (other.authenticated && other.peerID !== attachment.peerID) {
        this.send(peer, {
          v: PROTOCOL_VERSION,
          type: "peer-left",
          peerID: attachment.peerID,
          role: attachment.role,
          reason: reason.slice(0, MAX_REASON_LENGTH),
        });
      }
    }
    if (attachment.role === "host") {
      await this.updateLobby();
      const graceSeconds = this.readHostGraceSeconds();
      await this.state.storage.put("hostGoneAt", Date.now());
      await this.state.storage.setAlarm(Date.now() + graceSeconds * 1000);
    } else {
      await this.updateLobby();
      await this.scheduleMaintenance();
    }
  }

  async alarm() {
    const hostGoneAt = await this.state.storage.get("hostGoneAt");
    if (hostGoneAt) {
      const elapsed = Date.now() - hostGoneAt;
      const graceMs = this.readHostGraceSeconds() * 1000;
      if (elapsed < graceMs) {
        await this.state.storage.setAlarm(hostGoneAt + graceMs);
        return;
      }
      for (const socket of this.state.getWebSockets()) {
        this.sendError(socket, "host-gone", "The host did not reconnect", true);
        socket.close(CLOSE_HOST_GONE, "host-gone");
      }
      await this.state.storage.deleteAll();
      return;
    }
    const now = Date.now();
    const hostPresent = this.state.getWebSockets().some((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment.authenticated && !attachment.removed && attachment.role === "host";
    });
    if (hostPresent) await this.updateLobby();
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (!attachment.authenticated) {
        socket.close(CLOSE_POLICY, "hello-timeout");
        continue;
      }
      if (now - attachment.lastMessage > IDLE_TIMEOUT_MS) {
        socket.close(CLOSE_POLICY, "idle-timeout");
        continue;
      }
      if (now - attachment.lastMessage >= PING_INTERVAL_MS) {
        this.send(socket, { v: PROTOCOL_VERSION, type: "ping", t: now });
        attachment.lastMessage = now;
        socket.serializeAttachment(attachment);
      }
    }
    await this.scheduleMaintenance();
  }

  async scheduleMaintenance() {
    if (this.state.getWebSockets().length) {
      await this.state.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
    } else if (!(await this.state.storage.get("hostGoneAt"))) {
      await this.state.storage.deleteAll();
    }
  }

  readHostGraceSeconds() {
    const configured = Number(this.env.HOST_GRACE_SECONDS);
    return Number.isInteger(configured) && configured >= 1 && configured <= 300 ? configured : 30;
  }

  readICEServers() {
    if (!this.env.ICE_SERVERS_JSON) return null;
    try {
      const parsed = JSON.parse(this.env.ICE_SERVERS_JSON);
      return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      console.error("ICE_SERVERS_JSON must be valid JSON", error);
      return null;
    }
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.warn("Failed to send room message", error);
    }
  }

  sendError(socket, code, message, fatal = true) {
    this.send(socket, errorMessage(code, message, fatal));
  }

  reject(socket, code, message, closeCode) {
    this.sendError(socket, code, message);
    try {
      socket.close(closeCode, code);
    } catch (error) {
      console.warn("Failed to close rejected signaling socket", error);
    }
  }
}

function validICEServers(servers) {
  if (!Array.isArray(servers) || servers.length > 16) return false;
  return servers.every((server) => {
    if (!server || typeof server !== "object" || !Array.isArray(server.urls) ||
        server.urls.length < 1 || server.urls.length > 8) return false;
    if (server.username !== undefined && (typeof server.username !== "string" || server.username.length > 512)) return false;
    if (server.credential !== undefined && (typeof server.credential !== "string" || server.credential.length > 512)) return false;
    return server.urls.every((value) =>
      typeof value === "string" &&
      value.length <= 512 &&
      /^(stun|stuns|turn|turns):[^\s]+$/i.test(value),
    );
  });
}
