# Discord Activity (legacy)

> **Current behavior:** the desktop app and bot no longer create or launch a
> Discord Activity. The bot posts the public viewer link as a normal Discord
> message and deletes it when the stream stops. The relay and Activity viewer
> remain available for deployments that already use them; the URLs and portal
> mappings below still apply to those installs.

Streamy normally sends H.264/Opus peer-to-peer over WebRTC. Discord Activities
run inside a sandboxed iframe on `discordsays.com`, where direct WebRTC to every
viewer is not a practical transport. This document covers the optional second
path:

```
Go desktop app ──wss /v1/publish──▶ Go relay ──wss /v1/watch──▶ Activity viewer
        │                                                        (WebCodecs)
        └──HTTPS /api/notify──▶ Discord bot ──plain viewer link──▶ Discord channel
```

- The **viewer** (`viewer/`) auto-detects Activity mode and plays H.264/Opus
  frames from the relay with WebCodecs (MSE fallback).
- The **relay** (`relay/`) runs on a VPS and fans the encoded stream out to every
  Activity viewer in a room.
- The **bot** (`bot/`) posts the public viewer link for the current stream and
  removes it on stop. It no longer creates a Watch button or runs `/watch`.
- The **desktop app** publishes to the relay and optionally notifies the bot.
- The **gateway** (`gateway/`) is optional: it serves the viewer and proxies
  `/api` and `/relay` on one port, so a single free quick tunnel is enough when
  you have no domain. `dev/start-activity.ps1` starts the whole stack.

WebRTC remains the default. The relay can run alongside WebRTC, or replace it
with `stream.relay.only`.

---

## 0. Fast path: no domain, stable URLs

If the goal is to see the Activity actually work before renting a VPS, skip to
[Run everything locally](#6-run-everything-locally-no-domain). It needs no
domain and no VPS. Two hostnames never change:

| Piece | Stable hostname |
| --- | --- |
| Viewer (static) | `https://streamy-viewer.pages.dev` |
| `/api` and `/relay` | `https://streamy-signal.thenightserver.workers.dev` |

The Worker is a front door for this PC: it reads the current Cloudflare quick
tunnel hostname from a Durable Object and forwards `/token`, `/api/*` and the
relay WebSocket to it. `dev\start-activity.ps1` publishes the new tunnel
hostname to the Worker on every start, so the Developer Portal is filled in
**once** and never edited again. The tunnel hostname becomes an internal detail.

The rest of this document describes the production shape: Pages, a public relay
and a public bot, each on its own hostname.


---

## 1. Deploy the viewer to Cloudflare Pages

The viewer is a Vite app and builds to a static `dist/`.

```powershell
cd stream-site/viewer
npm install
# edit public/config.json first (see below)
npm run deploy
```

`public/config.json` is copied into `dist/` and fetched at runtime:

```json
{
  "signalURL": "wss://streamy-signal.thenightserver.workers.dev",
  "relayURL": "wss://relay.example.com",
  "tokenURL": "/.proxy/api/token",
  "discordClientID": "1539962249718792203"
}
```

| Field | Purpose |
| --- | --- |
| `signalURL` | Existing Cloudflare signaling Worker (browser WebRTC lobby). |
| `relayURL` | Public relay host for **browser** relay testing (`?relay=<channel-id>`). Activity mode ignores it and uses the proxy path. |
| `tokenURL` | Relative Activity token endpoint. Must start with `/.proxy/`; Discord rewrites it. |
| `discordClientID` | Discord application (client) ID. Public, not a secret. |

The build uses relative asset paths (`base: "./"`), so the same `dist/` works at
the Pages root and through the Discord proxy.

---

## 2. Deploy the relay

The relay is a standalone Go module. It needs a publicly reachable **TLS**
endpoint; browser WebSockets from a `https:` Activity must use `wss:`.

```bash
cd stream-site/relay
go build -o streamy-relay .
RELAY_PUBLISH_TOKEN='<long-random-secret>' ./streamy-relay -addr :8790 -max-viewers 200
```

| Flag / env | Meaning |
| --- | --- |
| `-addr` | Listen address, default `:8790`. |
| `-publish-token` / `RELAY_PUBLISH_TOKEN` | Deployment-wide publisher secret. Empty disables publisher auth. |
| `-max-viewers` | Per-room viewer cap, default `200`; `0` is unlimited. |

Put it behind Caddy, nginx, or another TLS terminator. Caddy handles WebSocket
upgrades automatically:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

For nginx, forward the upgrade headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

Check `https://relay.example.com/healthz` returns `ok`. The relay routes are
`/v1/publish/<room>` and `/v1/watch/<room>`; run it at the host root, not under a
path prefix. Publisher URLs configured in Streamy are base URLs such as
`wss://relay.example.com`.

The relay keeps rooms in memory. It is a **single instance** design: restarting
it drops every stream, and it does not scale horizontally without sticky routing
per room.

---

## 3. Create the Discord application and Activity

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **General Information** — copy the Application ID (client ID) and public key.
   Under **OAuth2**, copy the Client Secret and add a placeholder redirect URI
   such as `https://127.0.0.1`. The Embedded App SDK handles the real redirect;
   the portal only requires that one exists.
2. **Installation** — enable **Guild Install** (and optionally **User Install**).
   The bot needs the `bot` and `applications.commands` scopes.
3. **Activities → Getting Started** — enable Activities and set the Activity URL
   to the Pages deployment, e.g. `https://streamy-viewer.pages.dev/`. Discord
   loads that app through `https://<client-id>.discordsays.com/`.
4. **Activities → URL Mappings** — add exactly these rows. The prefix is
   **stripped** before the request reaches the target.

| Prefix | Target (no protocol, no path) | What the Activity sends | What the target receives |
| --- | --- | --- | --- |
| `/api` | `streamy-signal.thenightserver.workers.dev` | `POST /.proxy/api/token` | `POST https://<current tunnel>/token` (via the Worker) |
| `/relay` | `streamy-signal.thenightserver.workers.dev` | `wss://<client-id>.discordsays.com/.proxy/relay/v1/watch/<room>` | `wss://<current tunnel>/v1/watch/<room>` (via the Worker) |

Both rows point at the Worker, which forwards to whatever quick tunnel the
launcher published, so the mapping never changes. No `/` mapping is needed while
the Activity URL is the Pages deployment; add `/` → the Worker only if you also
want the Worker to serve the viewer.

For a fully self-hosted deployment (Pages + a VPS relay + a public bot), use
`bot.example.com` and `relay.example.com` in those two rows instead, and add
`/` → `streamy-viewer.pages.dev`.

Rules that matter:

- Targets are hostnames only. Do **not** enter `https://` or `wss://`.
- List longer prefixes first; Discord matches on the longest prefix.
- `/.proxy/...` remains supported even though Discord now also accepts the
  unprefixed path. Streamy uses `/.proxy/...` for backwards compatibility.
- The bot therefore listens on both `/token` (proxied) and `/api/token`
  (direct). The desktop app notifies `https://bot.example.com/api/notify`.

### Entry Point command

Under **Activities → Getting Started**, set the Entry Point command to the same
name the bot registers (`watch` by default). The bot creates `/watch` on startup
if it does not exist. If you change `ENTRY_COMMAND_NAME`, also change the Entry
Point command name in the portal.

The bot handles **all** chat-input commands by returning callback type `12`, so
`/watch`, the Watch button, and a separately configured Entry Point command all
launch the same Activity. Do not register a second conflicting command.

### Install the bot

Use the OAuth2 URL generator with scopes `bot` and `applications.commands`, and
the minimum permissions **View Channels** and **Send Messages** (3072). Install
it in the guild that will host streams. The bot does not need Administrator, and
it never automates a user account.

---

## 4. Run the bot

The bot reads `bot/.env` on startup (real environment variables win), so the
shortest path is:

```powershell
cd stream-site/bot
Copy-Item .env.example .env   # then edit the four required values
npm install
node src/index.js
```

`node src/index.js` fails fast and names the missing variable if any of
`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` or
`STREAMY_API_KEY` is empty. The equivalent explicit form:

```bash
cd stream-site/bot
npm install
DISCORD_TOKEN='...' \
DISCORD_CLIENT_ID='...' \
DISCORD_CLIENT_SECRET='...' \
STREAMY_API_KEY='<long-random-secret>' \
GUILD_ID='<optional-guild-id>' \
WATCH_CHANNEL_ID='<optional-default-channel-id>' \
ENTRY_COMMAND_NAME='watch' \
PORT=8791 \
node src/index.js
```

| Variable | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Bot token. Never ship it in the viewer or desktop app. |
| `DISCORD_CLIENT_ID` | Application ID; used for the OAuth2 token exchange. |
| `DISCORD_CLIENT_SECRET` | OAuth2 secret; server-side only. |
| `STREAMY_API_KEY` | Bearer token the desktop app uses for `/api/notify`. |
| `GUILD_ID` | Optional. Registers `/watch` in one guild immediately; global commands can take time to propagate. |
| `WATCH_CHANNEL_ID` | Optional default channel when a notify body has no `channelId`. |
| `ENTRY_COMMAND_NAME` | Command name, default `watch`. |
| `PORT` | HTTP API port, default `8791`, bound to loopback. |
| `TLS_CERT` / `TLS_KEY` | Optional direct TLS. Usually terminate TLS in Caddy instead. |

Expose the bot over HTTPS so both Discord's proxy and the desktop app can reach
it:

```caddyfile
bot.example.com {
    reverse_proxy 127.0.0.1:8791
}
```

`POST /api/notify` requires `Authorization: Bearer $STREAMY_API_KEY`. It posts a
message with a **Watch** button in the target channel. The button's custom ID
always returns `LAUNCH_ACTIVITY`; it does not send a normal component reply.

---

## 5. Configure the desktop app

Open **Settings → Discord Activity** (or edit `%AppData%\streamy\config.json`):

```json
{
  "stream": {
    "relay": {
      "enabled": true,
      "url": "wss://relay.example.com",
      "token": "<RELAY_PUBLISH_TOKEN>",
      "channelID": "123456789012345678",
      "only": false,
      "notifyURL": "https://bot.example.com/api/notify",
      "notifyKey": "<STREAMY_API_KEY>"
    }
  }
}
```

- **Enabled** turns the publisher on. With `only: false`, WebRTC and the browser
  lobby still run.
- **Only** skips signaling and WebRTC. No viewer link is created; the stream is
  Activity-only.
- **Channel ID** becomes the relay room. It must be the channel where viewers
  will launch the Activity. The current desktop app uses one channel per stream;
  changing channels requires changing this setting before starting.
- **Notify** is optional. If set, the app calls the bot once at stream start; a
  failure is logged but does not stop the stream.
- Both URLs must be absolute `ws`/`wss` or `http`/`https` URLs. The relay base
  URL must not contain a path.

Settings apply to the **next** stream. Start sharing with the tray or hotkey.

---

## 6. Run everything locally (no domain)

This is the fastest way to see the real Discord proxy, the real Activity SDK and
the real relay working together. Everything runs on this PC; the Activity talks
to the Worker, and the Worker talks to one Cloudflare quick tunnel.

```
Discord client
   │  https://streamy-viewer.pages.dev            static viewer (never changes)
   │      /.proxy/api/*   ─┐
   │      /.proxy/relay/* ─┤
   ▼                       ▼
https://streamy-signal.thenightserver.workers.dev  Worker (never changes)
   │  reads the current tunnel host from a Durable Object
   ▼
https://<random>.trycloudflare.com                 quick tunnel (changes every start)
   ▼
gateway :8799 ──┬── /            viewer/dist (local browser check)
                ├── /v1, /relay  relay    :8790  ◀── desktop app (ws://127.0.0.1:8790)
                └── /token, /api bot      :8791  ◀── desktop app (/api/notify)
```

### 6.1 One-time setup

1. **Fill in the bot secrets.** Create `bot/.env` (the launcher does this for you
   on first run and then stops) and set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET` and any long random `STREAMY_API_KEY`.
2. **Match the client ID.** `viewer/public/config.json` `discordClientID` must
   equal `DISCORD_CLIENT_ID`. The launcher warns if they differ.
3. **Deploy the Worker front door** (already done on this machine; repeat if you
   clone the repo somewhere else):

   ```powershell
   cd stream-site\worker
   npm install
   # one shared secret that lets the launcher publish the tunnel hostname
   npx wrangler secret put TUNNEL_ADMIN_TOKEN
   npx wrangler deploy
   ```

   Keep the same value in `dev\secrets\tunnel-admin-token.txt` (one line, no
   quotes). The launcher reads that file.
4. **Deploy the viewer** so `https://streamy-viewer.pages.dev` serves the
   Activity-aware build:

   ```powershell
   cd stream-site\viewer
   npm run deploy
   ```

   This builds `dist/` and uploads it. Deploy `dist/`, not `viewer/`: the source
   page loads `/src/main.js`, so Discord cannot resolve the SDK's bare import.
5. **Enable Activities for the app** in the Developer Portal.

### 6.2 Start the stack

The desktop app starts the stack for you when **Start relay, bot and gateway
with Streamy** is enabled in **Settings → Discord Activity**, and stops it when
Streamy quits. Workers use `-Hidden`, so no extra terminals appear.

To run it by hand instead:

```powershell
cd stream-site
.\dev\start-activity.ps1                      # or: -PublishToken 'long-random-secret'
```

The script builds the gateway, opens the relay, bot and gateway in three windows,
waits for their health endpoints, opens the quick tunnel, then publishes the
tunnel hostname to the Worker and prints:

```
  Tunnel (internal)      : https://random-words-1234.trycloudflare.com
  Stable Activity URL    : https://streamy-viewer.pages.dev/
  Stable mapping target  : https://streamy-signal.thenightserver.workers.dev

  Developer Portal -> Activities -> URL Mappings (set once):
    prefix  /api     target  streamy-signal.thenightserver.workers.dev
    prefix  /relay   target  streamy-signal.thenightserver.workers.dev

  Nothing to change after a restart - the tunnel hostname is published above.
```

On first run only, set the developer portal to those values (see
[§3](#3-create-the-discord-application-and-activity)); after that a restart
changes nothing.

Stop everything with:

```powershell
.\dev\start-activity.ps1 -Stop
```

`-Stop` also tells the Worker the relay is gone, so the Activity shows "relay
offline" instead of waiting on a dead tunnel. `-NoTunnel` runs the same stack for
a purely local browser check at `http://127.0.0.1:8799/`; `-NoPublish` skips the
Worker update.

### 6.3 Point the desktop app at the local stack

Either fill in **Settings → Discord Activity**, or let the script write the
`stream.relay` block for you (it keeps a `config.json.bak` and reads the notify
key from `bot/.env`, so the two sides cannot drift):

```powershell
.\dev\configure-desktop.ps1 -ChannelID <discord-channel-id>
# add -KeepWebRTC to keep WebRTC and the Activity at the same time (default)
```

Restart `streamy.exe` afterwards; it reads the config at startup. The equivalent
settings are:

| Setting | Value |
| --- | --- |
| Enabled | on |
| Relay URL | `ws://127.0.0.1:8790` |
| Publish token | whatever you passed as `-PublishToken` (default `devsecret`) |
| Channel ID | fallback text channel — right-click it with Developer Mode on → Copy Channel ID. When you are connected to a voice channel, the bot uses that voice channel instead |
| Relay only | off — keeps WebRTC and the Pages lobby working; turn on only to test the relay in isolation |
| Notify URL | `http://127.0.0.1:8791/api/notify` |
| Notify key | the `STREAMY_API_KEY` from `bot/.env` |

The room is exactly `channelID` — or the streamer's current voice channel when
one is available. The desktop app asks the bot for that channel before it starts
publishing, and the Activity joins the room of the channel it was launched from,
so a mismatch is the most common "waiting forever" cause.

### 6.4 Launch the Activity

1. Invite the bot to a test server (scopes `bot` + `applications.commands`).
2. Join a voice channel if you want the Activity there. Start sharing (`Ctrl+\`).
   The relay window should log the publisher, and the bot should post a Watch
   message in your voice channel (otherwise in the fallback channel).
3. Click **Watch** (or run `/watch`; if you are in voice, the bot puts the
   button in the voice channel's text chat). Discord opens the Activity, the
   viewer completes `ready()` / `authorize()` / token exchange and joins the
   room of that channel. Stopping the stream removes the Watch invite.
4. Watch the gateway window: `POST /token -> 200` and
   `GET /v1/watch/<channel-id> -> 200 (websocket)` mean the proxy is working. A
   `502` means the bot is down; a viewer that connects but stays black means no
   publisher in that room.

Restarting this PC or the stack only changes the tunnel hostname, and the
launcher republishes it to the Worker automatically. The Developer Portal keeps
pointing at `streamy-viewer.pages.dev` and `streamy-signal.thenightserver.workers.dev`
for good.

Quick sanity check without Discord (browser WebRTC/relay path, needs
`relayURL` in `viewer/public/config.json` to point at a public relay):

```powershell
# The room must match stream.relay.channelID.
# https://streamy-viewer.pages.dev/?relay=123456789012345678
```

### 6.5 If you do have separate hosts

With Pages, a VPS relay and a public bot you can tunnel each port separately
instead of using the gateway:

1. `cd stream-site/viewer; npm run build; npm run preview -- --host 127.0.0.1 --port 8787`
   then `cloudflared tunnel --url http://127.0.0.1:8787`.
2. Start the relay (`go run . -addr :8790`) and tunnel port 8790.
3. Start the bot (`node src/index.js`) and tunnel port 8791.
4. Point `/`, `/api` and `/relay` at the three tunnel hostnames and set the
   Activity URL to the viewer tunnel host.

Do not use the Activity URL Override for this test. Discord documents that an
override bypasses its proxy, so `/.proxy/...` requests will not be rewritten.
Launch through the normal Activity entry point instead.

---

## 7. Test plan (browser and Activity simultaneously)

Prerequisites: ffmpeg installed, the viewer deployed, the relay and bot running,
and at least one guild where the bot is installed. For a two-viewer test, use two
Discord accounts in the same channel.

1. **WebRTC baseline** — start a stream with relay enabled but not relay-only.
   Open the normal viewer link in Chrome and confirm video, audio after unmute,
   and a `Live` status.
2. **Activity launch** — click the bot's **Watch** button. The Activity opens,
   runs `ready()` / `authorize()` / token exchange, and joins room
   `<channel-id>`. Confirm video appears without a manual reconnect.
3. **Simultaneous viewers** — keep the browser viewer open and launch the
   Activity in a second Discord client. Both should play the same stream. Relay
   logs should show two viewers, and viewer egress should be roughly twice the
   publisher ingress.
4. **Relay-only** — enable `stream.relay.only`, restart sharing, and confirm the
   browser lobby no longer lists the stream while the Activity still works.
   Disable it again and confirm WebRTC returns.
5. **Per-viewer launch** — have a second user run `/watch` (or click the button)
   themselves. One user launching must not push the Activity to anyone else.
6. **Publisher restart** — stop sharing while the Activity is open. The viewer
   gets close code `4001` and waits. Start sharing again; it reconnects and
   receives the cached keyframe without a page reload.
7. **Keyframe/stale handling** — leave the Activity tab backgrounded for a
   minute, then return. The viewer should resynchronize at the next IDR. Throttle
   one viewer in DevTools; the relay should close it with `4004` and the viewer
   should reconnect, while the other viewer and the publisher are unaffected.
8. **Viewer cap** — run the relay with `-max-viewers 1` and connect a second
   viewer. It should receive `4003` / "This stream is full" and retry later.
9. **Audio/video sync** — unmute and watch a clock or counting video for ten
   minutes. Check that audio stays aligned; the relay timestamps both streams on
   the same Unix-millisecond clock.
10. **Bot paths** — verify all three launch paths: the Watch button, `/watch`,
    and the portal Entry Point command. Bot logs must not contain
    `LAUNCH_ACTIVITY failed`.
11. **Failure modes** — use a wrong relay token (stream start fails with "relay
    rejected publisher"), a wrong bot key (HTTP 401, no message posted), and a
    wrong channel ID (no message / viewer waits for a publisher).
12. **Fallback** — test a browser without WebCodecs H.264 support. The viewer
    should switch to the MSE compatibility player or report a clear error.

---

## 8. Known limits

- **Latency is roughly 0.5–2 s.** Encode, relay buffering, jitter scheduling,
  and decoder queues add up. This is fine for watching, not for competitive
  play.
- **TCP head-of-line blocking.** The relay path is WebSocket over TCP. Packet
  loss stalls every frame behind it; WebRTC's UDP path degrades more gracefully.
  Expect visible freezes on a poor mobile connection.
- **Relay bandwidth is the real cost.** Publisher ingress is about the stream
  bitrate; viewer egress is about `bitrate × viewers`. A 6 Mbps stream with 50
  viewers needs ~300 Mbps of egress. Cap viewers and monitor the relay's
  `relay bandwidth` log lines.
- **One relay instance, in-memory rooms.** Restarting drops all streams, and
  there is no cross-instance routing. Run one instance per region or accept the
  single point of failure.
- **One publisher and one configured channel per stream.** The room is the
  Discord channel ID from config. Supporting several channels concurrently needs
  one app instance (or a future channel picker) per channel.
- **The relay sees all media.** Unlike WebRTC, there is no end-to-end media path.
  Treat the VPS and `RELAY_PUBLISH_TOKEN` as sensitive. The token is
  deployment-wide, so anyone holding it can publish to any room.
- **Viewers are not authenticated.** The channel ID is the capability; anyone
  who knows it and can reach the relay can watch. Keep the relay behind TLS and
  do not publish room IDs.
- **Discord proxy limits.** Only mapped paths are reachable. Mappings strip the
  prefix, targets omit the protocol, the root mapping must be last, and hosts
  must use TLS. WebSockets are supported but are still subject to idle and
  message-size limits.
- **Activities are launched per viewer.** Discord does not broadcast one user's
  Activity to a channel. Every viewer clicks Watch or runs `/watch`. Bots may
  not automate user accounts or act as self-bots; use the official bot token and
  Activity SDK only.
- **Codec support varies.** WebCodecs H.264 is not universal. MSE fallback adds
  latency, and Opus-in-MP4 audio support is not universal, in which case the
  viewer plays video without sound.
- **Autoplay policy.** Viewers start muted; audio requires a user gesture. This
  is enforced by browsers, especially on mobile.
- **No recording, DVR, or seek.** The relay is live-only and drops stale frames
  instead of queueing them.
- **Discord ToS.** Do not self-bot, scrape, or automate a user account. The bot
  must remain a normal bot application, and the Activity must use the official
  Embedded App SDK.
- **Quick tunnels are for testing only.** The hostname is random and changes on
  every restart. That no longer touches the Developer Portal (the Worker absorbs
  it), but Cloudflare rate-limits quick tunnels and either end can be slow under
  load. For an always-on relay with no Worker in the path, use a Cloudflare-managed
  domain (named tunnel) or a VPS with a real certificate.
- **The Worker front door is a proxy, not a relay.** It forwards to the PC, so the
  PC must be awake and the tunnel up. When the stack is stopped, `/token` and
  `/relay` return `503 {"error":"relay-offline"}` instead of hanging.
- **The local stack is not always on.** The relay, bot and gateway run while
  their windows are open; closing them, sleeping the PC or losing the network
  ends every Activity stream.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Activity shows a blank page | The Activity URL does not serve `index.html` + `assets/` (check `https://streamy-viewer.pages.dev/`), or a `/` mapping exists and shadows the Activity URL. |
| `Failed to resolve module specifier "@discord/embedded-app-sdk"` | The Pages deployment is serving the viewer **source** instead of `dist/` (the HTML references `/src/main.js`). Run `npm run deploy` from `stream-site/viewer` and redeploy `dist/`. |
| `blocked:csp` / failed fetch | A backend URL was absolute or not under a mapped prefix. Use `/.proxy/...`. |
| Token exchange 502 | Wrong client ID/secret, expired code, or the bot cannot reach Discord. Check bot logs; the response now includes the upstream detail. |
| Token exchange 404 | The `/api` mapping points at a host that does not serve `/token`. The prefix is stripped. |
| Gateway returns 502 | The relay or bot is not running, or on a different port. The gateway logs the failing upstream URL; its `/healthz` shows the configured targets. |
| A `/token` failure shows Cloudflare's own "502 Bad gateway" page | Quick-tunnel edges replace origin 5xx bodies with their own error page. The bot's real message (`token exchange failed: …`) is in the bot window; `curl http://127.0.0.1:8791/token` shows it locally. Successful exchanges (200) are unaffected. |
| Worked, then broke after a restart | The tunnel hostname changed but the Worker was not updated. Run `.\dev\start-activity.ps1` again (it publishes the host), then check `GET /__tunnel` with the admin token. |
| `/token` or `/relay` returns 503 `relay-offline` | The Worker has no tunnel host: the stack is stopped, or the launcher could not publish. Resume with `.\dev\start-activity.ps1`. |
| `GET /__tunnel` is 401/503 | `TUNNEL_ADMIN_TOKEN` in the Worker does not match `dev\secrets\tunnel-admin-token.txt`, or the secret was never set. |
| Relay connection fails in Activity | `/relay` mapping missing, target not TLS, or the reverse proxy is not forwarding WebSocket upgrades. |
| Relay rejects publisher | `stream.relay.token` does not match `RELAY_PUBLISH_TOKEN`. |
| Viewer waits forever | No publisher in that room. Check that `stream.relay.channelID` equals the channel where the Activity was launched. |
| Watch button does nothing | Bot lacks permission in the channel, the Activity is not enabled, or `LAUNCH_ACTIVITY` failed. Check bot logs. |
| Video but no audio | The viewer is muted (autoplay), Opus/MP4 is unsupported, or desktop audio is disabled in Settings. |
