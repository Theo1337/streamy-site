# Streamy — web side (phase 1 scaffolding)

Everything that is web-hosted, free to run, and has nothing to do with the
desktop app except the message format in [`PROTOCOL.md`](PROTOCOL.md).

```
stream-site/
├── PROTOCOL.md      the wire format shared with screenshare-app/ (identical copy)
├── viewer/          static viewer page — deploys to Cloudflare Pages (phase 6)
└── worker/          Cloudflare Worker + Durable Object signaling (phase 4)
```

**Status: phase 1.** This folder currently holds only the contract and the
layout. No viewer code and no Worker exist yet — they arrive in phases 4 and 6.
It is here from the start so that the protocol has a home on both sides and the
two projects never grow a shared dependency.

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

## Why Cloudflare

The requirements ask for free, always-on infrastructure:

- **Cloudflare Workers**: 100,000 requests/day and a generous WebSocket
  allowance on the free plan. A Durable Object per room means the room's state
  lives in one place, with no database and no coordination code.
- **Cloudflare Pages**: unlimited static requests, plus free TLS. The viewer page
  is three small files, so it deploys as-is.
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

See [`PROTOCOL.md`](PROTOCOL.md) for the full message reference, and each
sub-folder's README for build and deploy steps.
