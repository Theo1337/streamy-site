import { isValidRoomID, jsonResponse, allowedOrigin, randomID } from "./protocol.js";
import { Room } from "./room.js";
import { issueIdentityToken, validLoopbackCallback } from "./identity.js";
import { Lobby } from "./lobby.js";
import { isTunnelPath, proxyToTunnel } from "./tunnel.js";

export { Lobby, Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Discord's Activity proxy sends /.proxy/api/token here as /token. The
    // Worker already owns the client secret, so the code exchange happens at
    // the edge instead of depending on the local bot being reachable.
    if (url.pathname === "/token" || url.pathname === "/api/token") {
      return exchangeActivityToken(request, env);
    }
    if (isTunnelPath(url.pathname)) {
      return proxyToTunnel(request, env, url);
    }
    if (url.pathname === "/__tunnel") {
      return handleTunnelAdmin(request, env);
    }
    if (url.pathname === "/v1/lobby") {
      if (!allowedOrigin(request.headers.get("Origin"), env.VIEWER_ORIGINS || "")) {
        return jsonResponse({ error: "origin-not-allowed" }, 403);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": request.headers.get("Origin") || "",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "Content-Type",
            "access-control-max-age": "600",
            "vary": "Origin",
          },
        });
      }
      if (request.method !== "GET") {
        return jsonResponse({ error: "method-not-allowed" }, 405, { allow: "GET, OPTIONS" });
      }
      const lobby = env.LOBBY.get(env.LOBBY.idFromName("public"));
      const response = await lobby.fetch("https://lobby/streams");
      return jsonResponse(await response.json(), response.status, {
        "access-control-allow-origin": request.headers.get("Origin") || "",
        "cache-control": "no-store",
        "vary": "Origin",
      });
    }
    if (url.pathname === "/v1/auth/discord/start") {
      return startDiscordOAuth(request, env, url);
    }
    if (url.pathname === "/v1/auth/discord/callback") {
      return finishDiscordOAuth(request, env, url);
    }

    const match = url.pathname.match(/^\/v1\/room\/([A-Za-z0-9_-]+)\/ws$/);
    if (!match) {
      if (url.pathname === "/health") {
        return jsonResponse({ status: "ok", protocol: 1 });
      }
      return jsonResponse({ error: "not-found" }, 404);
    }

    const roomID = match[1];
    if (!isValidRoomID(roomID)) return jsonResponse({ error: "invalid-room" }, 400);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket-required" }, 426, { upgrade: "websocket" });
    }
    if (!allowedOrigin(request.headers.get("Origin"), env.VIEWER_ORIGINS || "")) {
      return jsonResponse({ error: "origin-not-allowed" }, 403);
    }

    const roomIDObject = env.ROOMS.idFromName(roomID);
    return env.ROOMS.get(roomIDObject).fetch(request);
  },
};

// Lets the local start script publish "this is the tunnel serving the relay
// right now" without anyone touching the Developer Portal. The tunnel hostname
// is the only thing that changes between runs, and it is stored in the Lobby
// Durable Object so lookups are immediately consistent.
async function handleTunnelAdmin(request, env) {
  const expected = env.TUNNEL_ADMIN_TOKEN || "";
  if (!expected) return jsonResponse({ error: "admin-not-configured" }, 503);
  const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(provided, expected)) return jsonResponse({ error: "unauthorized" }, 401);

  const lobby = env.LOBBY.get(env.LOBBY.idFromName("public"));
  if (request.method === "GET") {
    const response = await lobby.fetch("https://lobby/tunnel");
    return jsonResponse(await response.json(), 200, { "cache-control": "no-store" });
  }
  if (request.method === "PUT") {
    const response = await lobby.fetch("https://lobby/tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
    if (response.ok) return jsonResponse({ ok: true }, 200);
    return jsonResponse({ error: "invalid-host" }, response.status);
  }
  if (request.method === "DELETE") {
    await lobby.fetch("https://lobby/tunnel", { method: "DELETE" });
    return jsonResponse({ ok: true }, 200);
  }
  return jsonResponse({ error: "method-not-allowed" }, 405, { allow: "GET, PUT, DELETE" });
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

// Discord Embedded App SDK code exchange. The SDK returns a short-lived code
// from commands.authorize(); the Activity then authenticates with the access
// token. No redirect_uri is sent: the code was issued to the embedded app, not
// to a browser redirect, and Discord rejects a mismatched redirect_uri.
async function exchangeActivityToken(request, env) {
  const origin = request.headers.get("Origin") || "";
  const cors = origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "vary": "Origin",
      }
    : {};
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method-not-allowed" }, 405, { ...cors, allow: "POST, OPTIONS" });
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return jsonResponse({ error: "discord-not-configured" }, 503, cors);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400, cors);
  }
  const code = typeof input?.code === "string" ? input.code.trim() : "";
  if (!code || code.length > 2048) {
    return jsonResponse({ error: "code is required" }, 400, cors);
  }

  const tokenBody = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
  });
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text().catch(() => "");
    console.error("Discord Activity token exchange failed", tokenResponse.status, detail);
    return jsonResponse({ error: "token exchange failed" }, 502, cors);
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    return jsonResponse({ error: "token exchange returned no access_token" }, 502, cors);
  }
  return jsonResponse({ access_token: tokenData.access_token }, 200, { ...cors, "cache-control": "no-store" });
}

async function startDiscordOAuth(request, env, url) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method-not-allowed" }, 405, { allow: "POST" });
  }
  if (!env.DISCORD_CLIENT_ID) {
    return jsonResponse({ error: "discord-not-configured" }, 503);
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }
  if (!validLoopbackCallback(input?.callback) ||
      typeof input?.clientState !== "string" || input.clientState.length < 32 || input.clientState.length > 128) {
    return jsonResponse({ error: "invalid-callback" }, 400);
  }

  const oauthState = randomID(32);
  const lobby = env.LOBBY.get(env.LOBBY.idFromName("public"));
  const stored = await lobby.fetch("https://lobby/oauth/states", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: oauthState, callback: input.callback, clientState: input.clientState }),
  });
  if (!stored.ok) return jsonResponse({ error: "oauth-state-storage-failed" }, 503);

  const redirectURI = `${url.origin}/v1/auth/discord/callback`;
  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorization.searchParams.set("redirect_uri", redirectURI);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "identify");
  authorization.searchParams.set("state", oauthState);
  return jsonResponse({ authorizationURL: authorization.toString() }, 200, { "cache-control": "no-store" });
}

async function finishDiscordOAuth(request, env, url) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_IDENTITY_SECRET) {
    return new Response("Discord OAuth is not configured on this Worker.", { status: 503 });
  }
  const state = url.searchParams.get("state") || "";
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    return new Response("Invalid OAuth state.", { status: 400 });
  }
  const lobby = env.LOBBY.get(env.LOBBY.idFromName("public"));
  const stateResponse = await lobby.fetch(`https://lobby/oauth/states/${encodeURIComponent(state)}`);
  if (!stateResponse.ok) return new Response("This Discord sign-in has expired. Return to Streamy and try again.", { status: 400 });
  const flow = await stateResponse.json();
  if (!validLoopbackCallback(flow.callback)) return new Response("Invalid OAuth callback.", { status: 400 });

  const callback = new URL(flow.callback);
  callback.searchParams.set("state", flow.clientState);
  const discordError = url.searchParams.get("error");
  if (discordError) {
    callback.searchParams.set("error", "discord-denied");
    return Response.redirect(callback.toString(), 302);
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return new Response("Discord did not return an authorization code.", { status: 400 });

  const redirectURI = `${url.origin}/v1/auth/discord/callback`;
  const tokenBody = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectURI,
  });
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) {
    console.error("Discord token exchange failed", tokenResponse.status);
    return new Response("Discord sign-in failed. Return to Streamy and try again.", { status: 502 });
  }
  const tokenData = await tokenResponse.json();
  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userResponse.ok) {
    console.error("Discord identity lookup failed", userResponse.status);
    return new Response("Could not read your Discord profile.", { status: 502 });
  }
  const user = await userResponse.json();
  if (typeof user.id !== "string" || typeof user.username !== "string") {
    return new Response("Discord returned an invalid profile.", { status: 502 });
  }
  const identityToken = await issueIdentityToken(user, env.DISCORD_IDENTITY_SECRET);
  callback.searchParams.set("identity", identityToken);
  return Response.redirect(callback.toString(), 302);
}
