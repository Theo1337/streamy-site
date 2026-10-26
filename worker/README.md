# worker/

The signaling server: a Cloudflare Worker routes each WebSocket room to one
Durable Object, which authenticates room tokens, enforces limits, and relays
SDP/ICE messages. Media remains peer-to-peer. See
[`../PROTOCOL.md`](../PROTOCOL.md).

## Contents

| File | Purpose |
| --- | --- |
| `wrangler.toml` | Worker, Durable Object binding/migration, local port and development origins |
| `src/index.js` | Routing, WebSocket upgrade and explicit origin allowlist |
| `src/room.js` | Room auth, peer registry, relay, viewer cap, alarms and per-socket rate limiting |
| `src/lobby.js` | Public active-stream registry and one-time Discord OAuth state |
| `src/identity.js` | Discord identity token signing and callback validation |
| `src/protocol.js` | Versioned protocol helpers and security/limit primitives |
| `package.json` | Wrangler and local test/deploy scripts |
| `test/` | Protocol, token, origin and limit tests |

## Local development and deployment

```powershell
cd worker
npm install
npx wrangler login       # once, opens a browser
npm run dev              # Worker on localhost:8788
npm test                 # protocol tests
npm run deploy           # prints wss://<name>.<subdomain>.workers.dev
```

For local testing, set `signaling.url` to `ws://127.0.0.1:8788` in the app
config; the local viewer page runs on port 8787. `VIEWER_ORIGINS` is an exact
comma-separated list: replace the development entries with the deployed viewer
origin before publishing (for example `https://streamy-viewer.pages.dev`). A
native Go client has no `Origin` header and is allowed. Never use `*` as the
browser origin allowlist.

Before production, replace the development `VIEWER_ORIGINS` in `wrangler.toml`
with the exact deployed Pages origin. Deploy the **built** viewer, not the
source directory:

```powershell
cd stream-site/viewer
npm run deploy
```

`npm run deploy` builds `dist/` and uploads it to Cloudflare Pages. Deploy the
built output, not the source directory.

### Enable public lobby and Discord sign-in

1. In the Discord Developer Portal, create an OAuth2 application and register
   this exact redirect URL:
   `https://<worker-host>/v1/auth/discord/callback`.
2. Set `DISCORD_CLIENT_ID` in `wrangler.toml` to the application's client ID.
3. From `worker/`, store the two secrets in Cloudflare (do not put them in the
   desktop app or source control):

   ```powershell
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put DISCORD_IDENTITY_SECRET
   ```

   Use a randomly generated `DISCORD_IDENTITY_SECRET` with at least 32
   characters. The Discord client secret stays on the Worker; the identity
   secret signs short-lived stream-host tokens.
4. Deploy the Worker with `npm run deploy`, then deploy the viewer after setting
   `viewer/config.json`'s `signalURL` to the Worker's `wss://` URL.
5. Set the same Worker URL and the viewer's HTTPS URL in the desktop app
   `config.json`. Rebuild/restart the desktop app, open Settings, connect
   Discord, then start sharing.

The lobby is intentionally public to anyone who can open the viewer page.
It exposes the streamer's Discord display name/avatar, viewer count, and a
separate viewer-only room token for currently live rooms. It does not expose
the host's private room token or collect viewer names.

## Bundle check

For a bundle check without publishing, run `npx wrangler deploy --dry-run`.
`ICE_SERVERS_JSON` can be set with `wrangler secret put ICE_SERVERS_JSON`;
host-specific STUN/TURN settings are instead carried in the viewer URL fragment.
Durable Object availability and quotas depend on the Cloudflare account and plan.
