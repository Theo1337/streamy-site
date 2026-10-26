# bot/

> **Legacy:** the desktop app now runs the Go bot built into `streamy.exe`
> (`streamy.exe bot`). This Node implementation is kept as a reference and is
> no longer packaged by the installer. The HTTP contract is unchanged.

Discord bot and tiny HTTP API for Streamy. When a stream starts, the desktop
app calls `/api/notify` and the bot posts a normal message with the public viewer
link. When the stream stops, the same call with `"action":"stop"` deletes that
message. The bot never creates a Discord Activity, button, or slash command.

```
Streamy app ──HTTP /api/notify start──▶ bot ──message with viewer link──▶ channel
Streamy app ──HTTP /api/notify stop───▶ bot ──delete that message
```

The API is intended for the desktop app on the same machine and listens on
loopback only.

## Requirements

- Node.js 20.19 or newer.
- A Discord application with a bot token.

## Install and run

The bot loads `bot/.env` on startup if it exists; variables already present in
the environment take precedence. Copy `.env.example` to `.env` and fill it in:

```powershell
cd stream-site/bot
Copy-Item .env.example .env
npm install
node src/index.js
```

The explicit form, without a `.env` file:

```powershell
cd stream-site/bot
npm install
$env:DISCORD_TOKEN='...'
$env:STREAMY_API_KEY='<long-random-secret>'
$env:WATCH_CHANNEL_ID='<optional-default-channel-id>'
node src/index.js
```

`npm run dev` runs with `node --watch`.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `STREAMY_API_KEY` | yes | Bearer token the desktop app sends to `/api/notify`. |
| `WATCH_CHANNEL_ID` | no | Default channel when a notify body omits `channelId`. |
| `PORT` | no | HTTP port, default `8791`; the process listens on loopback. |
| `VIEWER_URL` | no | Fallback public viewer link when the notify body omits `url`. |

## HTTP API

### `GET /healthz`

Returns `ok`.

### `POST /api/notify`

Requires `Authorization: Bearer $STREAMY_API_KEY`.

Start (the default when `action` is omitted):

```json
{
  "action": "start",
  "channelId": "123456789012345678",
  "streamer": "Name",
  "url": "https://streamy-viewer.pages.dev/?room=..."
}
```

The bot posts the public link as plain message content. `channelId` falls back to
`WATCH_CHANNEL_ID`.

Stop:

```json
{
  "action": "stop",
  "channelId": "123456789012345678"
}
```

The bot deletes the tracked link for that channel. It also scans recent channel
messages for a Streamy link, so a restart of the bot does not leave a stale
invite behind.

## systemd example

```ini
[Unit]
Description=Streamy Discord bot
After=network-online.target

[Service]
WorkingDirectory=/opt/streamy/bot
ExecStart=/usr/bin/node src/index.js
EnvironmentFile=/etc/streamy-bot.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
