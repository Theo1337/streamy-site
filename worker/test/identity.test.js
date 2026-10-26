import test from "node:test";
import assert from "node:assert/strict";

import { issueIdentityToken, validLoopbackCallback, verifyIdentityToken } from "../src/identity.js";

const secret = "test-signing-secret-that-is-long-enough";

test("Discord identity tokens are signed and verified with expiry", async () => {
  const token = await issueIdentityToken({
    id: "123456789012345678",
    username: "streamer",
    global_name: "Streamer Name",
    avatar: "avatar-hash",
  }, secret);

  assert.deepEqual(await verifyIdentityToken(token, secret), {
    id: "123456789012345678",
    name: "Streamer Name",
    avatar: "https://cdn.discordapp.com/avatars/123456789012345678/avatar-hash.png?size=128",
  });
  assert.equal(await verifyIdentityToken(token, "wrong-secret-that-is-long-enough"), null);
  assert.equal(await verifyIdentityToken(`${token.slice(0, -1)}x`, secret), null);
});

test("OAuth callbacks are restricted to the local Streamy callback", () => {
  assert.equal(validLoopbackCallback("http://127.0.0.1:48123/api/discord/callback"), true);
  assert.equal(validLoopbackCallback("http://localhost:48123/api/discord/callback"), false);
  assert.equal(validLoopbackCallback("https://evil.example/api/discord/callback"), false);
  assert.equal(validLoopbackCallback("http://127.0.0.1:48123/other"), false);
});
