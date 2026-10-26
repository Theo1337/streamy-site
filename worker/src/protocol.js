export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_MESSAGES_PER_SECOND = 60;
export const MAX_CANDIDATES_PER_SECOND = 30;
export const DEFAULT_MAX_VIEWERS = 20;
export const IDLE_TIMEOUT_MS = 120_000;
export const PING_INTERVAL_MS = 30_000;

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function isValidRoomID(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16}$/.test(value);
}

export function isValidToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function errorMessage(code, message, fatal = true) {
  return { v: PROTOCOL_VERSION, type: "error", code, message, fatal };
}

export function randomID(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function allowedOrigin(requestOrigin, configured) {
  if (!requestOrigin) return true;
  const req = requestOrigin.replace(/\/+$/, "");
  const list = (configured || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (list.includes("*") || list.includes(req)) return true;
  try {
    const parsed = new URL(req);
    if (parsed.hostname.endsWith(".streamy-viewer.pages.dev") || parsed.hostname === "streamy-viewer.pages.dev") {
      return true;
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
  } catch {}
  return false;
}

export function clampViewerLimit(requested, hardLimit = DEFAULT_MAX_VIEWERS) {
  const hard = Number.isInteger(hardLimit) && hardLimit > 0 ? hardLimit : DEFAULT_MAX_VIEWERS;
  if (!Number.isInteger(requested) || requested < 0) return hard;
  return requested === 0 ? hard : Math.min(requested, hard);
}

export function rateLimit(attachment, now, candidate) {
  const recentMessages = (attachment.messageTimes || []).filter((time) => now - time < 1000);
  const recentCandidates = (attachment.candidateTimes || []).filter((time) => now - time < 1000);
  recentMessages.push(now);
  if (candidate) recentCandidates.push(now);
  attachment.messageTimes = recentMessages;
  attachment.candidateTimes = recentCandidates;
  return recentMessages.length > MAX_MESSAGES_PER_SECOND ||
    recentCandidates.length > MAX_CANDIDATES_PER_SECOND;
}
