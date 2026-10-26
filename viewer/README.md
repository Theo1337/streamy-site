# viewer/

Vite single-page app for the public Streamy lobby and WebRTC player.

The page lists active public streams, opens the first one muted, and provides
custom playback, audio, fullscreen, reconnect, and manual SDP diagnostics
(`?manual=1`).

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Lobby, player, and manual offer/answer controls |
| `src/main.js` | Routing (direct WebRTC and lobby), controls, `window.Streamy` API |
| `src/lobby.js` | Lobby rendering and selection |
| `src/transports/transport.js` | Shared `Transport` interface |
| `src/transports/webrtc.js` | WebRTC viewer transport |
| `public/config.json` | Default signaling URL used by the lobby and direct links |

## Local development

```powershell
cd stream-site/viewer
npm install
npm run dev
```

The development server runs on <http://127.0.0.1:8787>. Add that origin to
`VIEWER_ORIGINS` in `worker/wrangler.toml` if the lobby request is rejected.

## Deploy

```powershell
npm run deploy
```

This builds `dist/` and publishes it to the `streamy-viewer` Cloudflare Pages
project. The signaling Worker URL can be overridden per direct link with
`?signal=wss://...`.

## Direct links

- `?room=<room>&token=<host-token>` opens one WebRTC room.
- `?manual=1` shows the manual SDP diagnostics panel.
- `?room=...&token=...&ice=<json>` overrides the ICE server list.
