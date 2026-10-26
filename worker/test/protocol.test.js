import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedOrigin,
  clampViewerLimit,
  constantTimeEqual,
  isValidRoomID,
  isValidToken,
  randomID,
  rateLimit,
} from "../src/protocol.js";

test("protocol identifiers have documented lengths and alphabet", () => {
  const room = randomID(12);
  const token = randomID(32);
  assert.equal(room.length, 16);
  assert.equal(token.length, 43);
  assert.equal(isValidRoomID(room), true);
  assert.equal(isValidToken(token), true);
  assert.equal(isValidRoomID(`${room}!`), false);
  assert.equal(isValidToken("x".repeat(42)), false);
});

test("token comparison requires exact content and equal lengths", () => {
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("secret", "secreT"), false);
  assert.equal(constantTimeEqual("secret", "secret!"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("viewer caps respect the hard limit and zero means server maximum", () => {
  assert.equal(clampViewerLimit(5, 20), 5);
  assert.equal(clampViewerLimit(100, 20), 20);
  assert.equal(clampViewerLimit(0, 20), 20);
  assert.equal(clampViewerLimit(-1, 20), 20);
});

test("browser origins must match the explicit allowlist", () => {
  assert.equal(allowedOrigin("", ""), true);
  assert.equal(allowedOrigin("https://viewer.example", "https://viewer.example"), true);
  assert.equal(allowedOrigin("https://evil.example", "https://viewer.example"), false);
});

test("message and candidate rates are independently limited", () => {
  const attachment = {};
  for (let i = 0; i < 30; i++) assert.equal(rateLimit(attachment, 1000 + i, true), false);
  assert.equal(rateLimit(attachment, 1031, true), true);
});
