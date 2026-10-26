const IDENTITY_ISSUER = "streamy-signal";

function encodeBase64URL(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64URL(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("DISCORD_IDENTITY_SECRET must contain at least 32 characters");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueIdentityToken(user, secret, now = Date.now()) {
  const header = encodeBase64URL(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = encodeBase64URL(new TextEncoder().encode(JSON.stringify({
    iss: IDENTITY_ISSUER,
    sub: user.id,
    name: user.global_name || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : "",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 30 * 24 * 60 * 60,
  })));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), new TextEncoder().encode(data));
  return `${data}.${encodeBase64URL(new Uint8Array(signature))}`;
}

export async function verifyIdentityToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64URL(parts[0])));
    const profile = JSON.parse(new TextDecoder().decode(decodeBase64URL(parts[1])));
    if (header.alg !== "HS256" || header.typ !== "JWT" ||
        !await crypto.subtle.verify("HMAC", await signingKey(secret), decodeBase64URL(parts[2]),
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) {
      return null;
    }
    if (profile.iss !== IDENTITY_ISSUER || typeof profile.sub !== "string" ||
        typeof profile.name !== "string" || profile.name.length < 1 || profile.name.length > 80 ||
        typeof profile.avatar !== "string" || profile.avatar.length > 512 ||
        !Number.isInteger(profile.exp) || profile.exp <= Math.floor(now / 1000)) {
      return null;
    }
    return { id: profile.sub, name: profile.name, avatar: profile.avatar };
  } catch {
    return null;
  }
}

export function validLoopbackCallback(value) {
  try {
    const callback = new URL(value);
    return callback.protocol === "http:" &&
      callback.hostname === "127.0.0.1" &&
      callback.port !== "" &&
      callback.username === "" &&
      callback.password === "" &&
      callback.pathname === "/api/discord/callback" &&
      callback.search === "" &&
      callback.hash === "";
  } catch {
    return false;
  }
}
