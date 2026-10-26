import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";

loadDotEnv();

const config = readConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const HTTP_PORT = Number(process.env.PORT || 8791);
const MAX_BODY_BYTES = 16 * 1024;

// channelId -> messageId for the single live link. Keeping this in memory is
// enough: the desktop app removes it on stop, and a restart of the bot also
// removes stale invites when the next stream starts.
const liveMessages = new Map();

client.once(Events.ClientReady, (ready) => {
  console.log(`[streamy-bot] signed in as ${ready.user.tag}`);
  console.log("[streamy-bot] posting plain viewer links");
});

client.on(Events.Error, (error) => {
  console.error("[streamy-bot] gateway error:", error);
});

const requestHandler = (req, res) => {
  void route(req, res).catch((error) => {
    console.error("[streamy-bot] request failed:", error);
    sendJSON(res, 500, { error: "internal" });
  });
};

const server = createHttpServer(requestHandler);

server.listen(HTTP_PORT, () => {
  console.log(`[streamy-bot] API listening on http://127.0.0.1:${HTTP_PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[streamy-bot] ${signal}; shutting down`);
    server.close();
    void client.destroy().finally(() => process.exit(0));
  });
}

client.login(config.token).catch((error) => {
  console.error("[streamy-bot] login failed:", error.message);
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/* Channel + message helpers                                           */
/* ------------------------------------------------------------------ */

async function resolveTargetChannel(requestedChannelId) {
  const candidates = [
    requestedChannelId,
    config.watchChannelId,
  ];
  for (const candidate of candidates) {
    const channelId = String(candidate || "").trim();
    if (!/^\d{5,32}$/.test(channelId)) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isTextBased?.()) return channel;
  }
  return null;
}

async function postLiveMessage(channel, url, streamer = "") {
  const content = streamer
    ? `**${escapeMarkdown(streamer)}** is live. Watch here: ${url}`
    : `Streamy is live. Watch here: ${url}`;
  return channel.send({
    content,
    allowedMentions: { parse: [] },
  });
}

/**
 * Deletes the bot's live links in the given channels. It checks the tracked
 * message ID and also scans recent history, so a bot restart cannot leave an
 * old link behind.
 */
async function removeLiveMessages(...channelIds) {
  let deleted = 0;
  const botId = client.user?.id;
  if (!botId) return deleted;
  const seen = new Set();
  for (const raw of channelIds) {
    const channelId = String(raw || "").trim();
    if (!/^\d{5,32}$/.test(channelId) || seen.has(channelId)) continue;
    seen.add(channelId);

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || !("messages" in channel)) continue;

    const candidates = new Set();
    const tracked = liveMessages.get(channelId);
    if (tracked) candidates.add(tracked);
    liveMessages.delete(channelId);

    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      for (const message of recent.values()) {
        if (message.author.id === botId && isLiveMessage(message)) {
          candidates.add(message.id);
        }
      }
    }

    for (const messageId of candidates) {
      const message = recent?.get(messageId)
        || await channel.messages.fetch(messageId).catch(() => null);
      if (!message || message.author.id !== botId) continue;
      try {
        await message.delete();
        deleted += 1;
      } catch {
        // Missing "Manage messages" permission is not fatal for stopping.
      }
    }
  }
  return deleted;
}

function isLiveMessage(message) {
  const content = String(message.content || "");
  return content.includes("Streamy is live")
    || /is live\. Watch here: https?:\/\//i.test(content);
}

function viewerURL(raw) {
  const value = String(raw || config.viewerURL || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}


/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notify") {
    if (!authorized(req)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJSON(req);
    const action = String(body.action || "start").trim().toLowerCase();
    const requestedChannelId = String(body.channelId || config.watchChannelId || "").trim();

    if (action === "stop" || action === "end" || body.live === false) {
      const deleted = await removeLiveMessages(
        requestedChannelId,
        config.watchChannelId,
        ...liveMessages.keys(),
      );
      sendJSON(res, 200, { ok: true, deleted });
      return;
    }

    if (!/^\d{5,32}$/.test(requestedChannelId)) {
      sendJSON(res, 400, { error: "channelId is required" });
      return;
    }
    const target = await resolveTargetChannel(requestedChannelId);
    if (!target || !target.isTextBased() || !("send" in target)) {
      sendJSON(res, 404, { error: "channel not found or not text based" });
      return;
    }
    const url = viewerURL(body.url);
    if (!url) {
      sendJSON(res, 400, { error: "url must be an http(s) viewer link" });
      return;
    }

    // One link at a time. Remove the previous one before posting, including
    // the configured fallback channel.
    await removeLiveMessages(
      target.id,
      requestedChannelId,
      config.watchChannelId,
      ...liveMessages.keys(),
    );

    const streamer = String(body.streamer || "").trim().slice(0, 80);
    const sent = await postLiveMessage(target, url, streamer);
    liveMessages.set(target.id, sent.id);
    sendJSON(res, 200, {
      ok: true,
      messageId: sent.id,
      channelId: target.id,
      url,
    });
    return;
  }

  sendJSON(res, 404, { error: "not found" });
}

// Minimal `.env` loader. bot/.env sits next to package.json; variables already
// present in the process environment win, so an inline `DISCORD_TOKEN=...`
// still overrides the file.
function loadDotEnv() {
  let text;
  try {
    text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    const quoted = value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]);
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readConfig() {
  const token = process.env.DISCORD_TOKEN;
  const apiKey = process.env.STREAMY_API_KEY;
  if (!token || !apiKey) {
    console.error("Missing DISCORD_TOKEN or STREAMY_API_KEY.");
    process.exit(1);
  }
  return {
    token,
    apiKey,
    watchChannelId: process.env.WATCH_CHANNEL_ID || "",
    viewerURL: process.env.VIEWER_URL || "https://streamy-viewer.pages.dev/",
  };
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return equalStrings(token, config.apiKey);
}

function equalStrings(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function escapeMarkdown(value) {
  return value.replace(/[*_`~\\]/g, "\\$&");
}
