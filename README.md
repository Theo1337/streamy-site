# Streamy — web side

Everything that is web-hosted, free to run, and has nothing to do with the
desktop app except the message format in [`PROTOCOL.md`](PROTOCOL.md).

```
stream-site/
├── PROTOCOL.md          the wire format shared with screenshare-app/ (identical copy)
├── viewer/              static public lobby and WebRTC player
├── worker/              Cloudflare Worker + Durable Object signaling
├── bot/                 Discord bot: posts the public viewer link on start/stop
└── dev/                 start-bot.ps1 and configure-desktop.ps1
```

The desktop side can be pointed at the local bot with
`dev/configure-desktop.ps1 -ChannelID <id>`, which writes the `stream.discord`
block (and reads the notify key straight from `bot/.env`).

The Worker implements authenticated, rate-limited room signaling, and the static
viewer lists active streams and negotiates automatically when a visitor selects
one. Streamers sign in with Discord in the desktop settings UI; their Discord
name and avatar appear in the public lobby. Viewer names are not collected.
Video travels directly between the host and each browser peer (or via the
configured TURN relay). Deployments still require a Cloudflare account; no
account credentials are needed for local development.

## The split, and why

| | Upstream | Downstream |
| --- | --- | --- |
| Folder | `screenshare-app/` | `stream-site/` |
| Language | Go | JavaScript |
| Deployed to | your PC | Cloudflare (free tier) |
| Talks to the other side via | `PROTOCOL.md` | `PROTOCOL.md` |

`screenshare-app/` and `stream-site/` are separate git repositories and must
never import from each other. When the protocol needs to change, change the
document in **both** repositories and bump the version — the *document* is the
interface, not a shared library.

## Discord bot

When a stream starts, the desktop app calls the local bot's `/api/notify` and
the bot posts a normal message with the public viewer link. When the stream
stops, the bot deletes that message. There is no Activity, Watch button, slash
command, relay or tunnel.

The bot is optional. Without it, the desktop app still copies the viewer link to
the clipboard and shows it in the tray.

## Why Cloudflare

The requirements ask for free, always-on infrastructure:

- **Cloudflare Workers**: 100,000 requests/day and a generous WebSocket
  allowance on the free plan. A Durable Object per room means the room's state
  lives in one place, with no database and no coordination code.
- **Cloudflare Pages**: unlimited static requests, plus free TLS. The Vite viewer
  builds to a small static `dist/`, so it deploys as-is.
- **Cloudflare's free TURN** is not a thing, so the app ships with Google's
  public STUN servers and treats TURN as optional (a small VPS running coturn, or
  a free-tier service). Most home networks connect peer-to-peer with STUN alone.

Nothing here is Cloudflare-specific by design: the Worker is a WebSocket relay,
so any host that can run one would do. That is why the app talks to it through a
`Signaler` interface.

## Cost and privacy summary

- The signaling server sees SDP and ICE candidates: IP addresses and codecs, but
  **no video, no audio, no room contents**.
- Video flows directly peer-to-peer. The only exception is when TURN is needed,
  in which case it passes through your relay.
- The room token is a secret, and the viewer link embeds it in the URL fragment
  so it is never sent to the static host.
- The lobby is public by design: anyone with the viewer URL can see active
  streamers and watch their listed streams. The host's private room token is
  never published; the lobby uses a separate viewer-only token.

See [`PROTOCOL.md`](PROTOCOL.md) for the full message reference, and each
sub-folder's README for build and deploy steps.
