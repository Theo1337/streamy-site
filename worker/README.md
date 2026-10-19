# worker/ (phase 4)

The signaling server: a Cloudflare Worker that upgrades the WebSocket request and
hands it to a Durable Object, one instance per room, which relays SDP and ICE
messages between the host and its viewers. See [`../PROTOCOL.md`](../PROTOCOL.md).

## Planned contents

| File | Purpose |
| --- | --- |
| `wrangler.toml` | Worker name, compatibility date, and the Durable Object binding + migration |
| `src/index.js` | The Worker entry point: routing, `Upgrade: websocket` handling, `Origin` check |
| `src/room.js` | The `Room` Durable Object: token check, peer registry, relay, viewer cap, rate limiting |
| `package.json` | `wrangler` as a dev dependency, plus `dev` and `deploy` scripts |
| `test/` | Room-level tests against the Durable Object |

## Planned deploy

```powershell
cd worker
npm install
npx wrangler login       # once, opens a browser
npx wrangler dev         # local, with a real Durable Object
npx wrangler deploy      # prints wss://<name>.<subdomain>.workers.dev
```

Put that `wss://` URL into the app's `signaling.url` setting and into the viewer
page's default, and the system is live. Everything on the free plan.

Nothing is deployed yet. This placeholder exists so the folder layout matches the
project plan from the start.
