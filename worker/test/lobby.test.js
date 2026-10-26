import test from "node:test";
import assert from "node:assert/strict";

import { Lobby } from "../src/lobby.js";

function fakeState() {
  const values = new Map();
  return {
    values,
    alarms: [],
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        if (typeof key === "object") {
          for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
        } else {
          values.set(key, value);
        }
      },
      async delete(key) {
        values.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return new Map([...values].filter(([key]) => key.startsWith(prefix)));
      },
      async setAlarm(value) {
        this.alarm = value;
      },
    },
    async setAlarm(value) {
      this.alarms.push(value);
    },
  };
}

test("public lobby lists sanitized active streams and removes ended rooms", async () => {
  const state = fakeState();
  const lobby = new Lobby(state);
  const stream = {
    room: "abcdefghijklmnop",
    token: "A".repeat(43),
    name: "Streamer",
    avatar: "https://cdn.discordapp.com/avatars/123/avatar.png?size=128",
    viewerCount: 3,
    iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
    privateToken: "never-publish-this",
  };
  const updated = await lobby.fetch(new Request("https://lobby/streams", {
    method: "PUT",
    body: JSON.stringify(stream),
  }));
  assert.equal(updated.status, 204);

  const response = await lobby.fetch(new Request("https://lobby/streams"));
  assert.deepEqual(await response.json(), {
    streams: [{
      room: stream.room,
      token: stream.token,
      name: stream.name,
      avatar: stream.avatar,
      viewerCount: 3,
      iceServers: stream.iceServers,
    }],
  });

  await lobby.fetch(new Request(`https://lobby/streams/${stream.room}`, { method: "DELETE" }));
  assert.deepEqual(await (await lobby.fetch(new Request("https://lobby/streams"))).json(), { streams: [] });
});

test("OAuth state can be consumed only once", async () => {
  const lobby = new Lobby(fakeState());
  const state = "S".repeat(43);
  const clientState = "C".repeat(43);
  const added = await lobby.fetch(new Request("https://lobby/oauth/states", {
    method: "POST",
    body: JSON.stringify({
      state,
      clientState,
      callback: "http://127.0.0.1:12345/api/discord/callback",
    }),
  }));
  assert.equal(added.status, 204);

  const first = await lobby.fetch(new Request(`https://lobby/oauth/states/${state}`));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).clientState, clientState);
  const second = await lobby.fetch(new Request(`https://lobby/oauth/states/${state}`));
  assert.equal(second.status, 404);
});
