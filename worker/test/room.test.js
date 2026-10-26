import test from "node:test";
import assert from "node:assert/strict";

import { issueIdentityToken } from "../src/identity.js";
import { Room } from "../src/room.js";

function socket(attachment) {
  return {
    attachment,
    messages: [],
    deserializeAttachment() {
      return this.attachment;
    },
    serializeAttachment(value) {
      this.attachment = value;
    },
    send(raw) {
      this.messages.push(JSON.parse(raw));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}

function roomFixture() {
  const sockets = [];
  const stored = new Map();
  const lobbyUpdates = [];
  const state = {
    initialization: Promise.resolve(),
    blockConcurrencyWhile(callback) {
      this.initialization = callback();
    },
    getWebSockets() {
      return sockets;
    },
    storage: {
      async get(key) {
        return stored.get(key);
      },
      async put(key, value) {
        if (typeof key === "object") {
          for (const [entryKey, entryValue] of Object.entries(key)) stored.set(entryKey, entryValue);
        } else {
          stored.set(key, value);
        }
      },
      async delete(key) {
        stored.delete(key);
      },
      async deleteAlarm() {},
      async setAlarm() {},
    },
  };
  const lobbyObject = {
    async fetch(_url, request) {
      if (request.method === "PUT") lobbyUpdates.push(JSON.parse(request.body));
      return new Response(null, { status: 204 });
    },
  };
  const room = new Room(state, {
    DISCORD_IDENTITY_SECRET: "test-signing-secret-that-is-long-enough",
    LOBBY: {
      idFromName() {
        return "public";
      },
      get() {
        return lobbyObject;
      },
    },
  });
  return { room, state, sockets, lobbyUpdates };
}

test("host identity creates a public viewer token without publishing the host token", async () => {
  const { room, state, sockets, lobbyUpdates } = roomFixture();
  await state.initialization;
  room.roomID = "abcdefghijklmnop";
  const host = socket({
    authenticated: false,
    peerID: "",
    role: "",
    lastMessage: Date.now(),
    messageTimes: [],
    candidateTimes: [],
  });
  sockets.push(host);
  const hostToken = "A".repeat(43);
  const identityToken = await issueIdentityToken({
    id: "123456789012345678",
    username: "streamer",
    global_name: "Streamer",
    avatar: "avatar-hash",
  }, "test-signing-secret-that-is-long-enough");
  await room.hello(host, host.deserializeAttachment(), {
    type: "hello",
    role: "host",
    token: hostToken,
    identityToken,
    maxViewers: 10,
    iceServers: [{ urls: ["turn:relay.example.test:3478"], username: "user", credential: "secret" }],
  });

  const publicToken = room.publicToken;
  assert.equal(publicToken.length, 43);
  assert.notEqual(publicToken, hostToken);
  assert.equal(lobbyUpdates[0].token, publicToken);
  assert.equal(JSON.stringify(lobbyUpdates[0]).includes(hostToken), false);
  assert.deepEqual(host.messages[0].iceServers, room.iceServers);

  const unauthorizedViewer = socket({
    authenticated: false,
    peerID: "",
    role: "",
    lastMessage: Date.now(),
    messageTimes: [],
    candidateTimes: [],
  });
  sockets.push(unauthorizedViewer);
  await room.hello(unauthorizedViewer, unauthorizedViewer.deserializeAttachment(), {
    type: "hello",
    role: "viewer",
    token: hostToken,
  });
  assert.ok(unauthorizedViewer.closed, "the private host token must not authorize viewers");

  const viewer = socket({
    authenticated: false,
    peerID: "",
    role: "",
    lastMessage: Date.now(),
    messageTimes: [],
    candidateTimes: [],
  });
  sockets.push(viewer);
  await room.hello(viewer, viewer.deserializeAttachment(), {
    type: "hello",
    role: "viewer",
    token: publicToken,
  });
  assert.equal(viewer.messages[0].type, "welcome");
  assert.equal(viewer.messages[0].iceServers[0].urls[0], "turn:relay.example.test:3478");
});

test("host hello rejects missing identity and invalid ICE servers", async () => {
  for (const hello of [
    { type: "hello", role: "host", token: "A".repeat(43), iceServers: [] },
    {
      type: "hello",
      role: "host",
      token: "A".repeat(43),
      identityToken: "not-a-signed-token",
      iceServers: [{ urls: ["javascript:alert(1)"] }],
    },
  ]) {
    const { room, state, sockets } = roomFixture();
    await state.initialization;
    const host = socket({ authenticated: false, peerID: "", role: "" });
    sockets.push(host);
    await room.hello(host, host.deserializeAttachment(), hello);
    assert.ok(host.closed, `expected invalid host hello to be rejected: ${JSON.stringify(hello)}`);
    assert.equal(room.publicToken, undefined);
  }
});

test("host offers are relayed only to the addressed viewer", async () => {
  const host = socket({ authenticated: true, peerID: "host-id", role: "host" });
  const viewer = socket({ authenticated: true, peerID: "viewer-id", role: "viewer" });
  const otherViewer = socket({ authenticated: true, peerID: "other-id", role: "viewer" });
  const state = {
    blockConcurrencyWhile(callback) {
      callback();
    },
    getWebSockets() {
      return [host, viewer, otherViewer];
    },
    storage: {
      async get() {
        return undefined;
      },
    },
  };
  const room = new Room(state, {});

  await room.handleMessage(host, host.deserializeAttachment(), {
    type: "offer",
    to: "viewer-id",
    sdp: "offer-sdp",
  });

  assert.deepEqual(viewer.messages, [
    { v: 1, type: "offer", from: "host-id", to: "viewer-id", sdp: "offer-sdp" },
  ]);
  assert.deepEqual(otherViewer.messages, []);
});
