# viewer/ (phase 6)

The static viewer page: plain HTML, CSS and JavaScript, no framework and no build
step, so it can be dropped straight into Cloudflare Pages.

## Planned contents

| File | Purpose |
| --- | --- |
| `index.html` | The page: one `<video>` element, a status line, a fullscreen button, a reconnect button |
| `app.js` | Reads `room`, `token` and `signal` from `location.hash`, connects to the Worker, answers the host's offers, plays the stream |
| `style.css` | Responsive layout that works on a phone (this is the main way people will watch) |
| `_headers` | A Content-Security-Policy and cache headers for Pages |

## Planned deploy

```powershell
npx wrangler pages deploy viewer --project-name streamy-viewer
```

The Worker URL is baked into `app.js` as a default and can be overridden per link
with the `signal` fragment parameter — see `PROTOCOL.md`.

Nothing is deployed yet. This placeholder exists so the folder layout matches the
project plan from the start.
