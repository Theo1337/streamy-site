const STREAM_TTL_MS = 90_000;
const OAUTH_STATE_TTL_MS = 5 * 60_000;

export class Lobby {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/streams" && request.method === "GET") {
      const streams = await this.readStreams();
      return Response.json({ streams });
    }
    if (url.pathname === "/streams" && request.method === "PUT") {
      const stream = await request.json();
      if (!stream || typeof stream.room !== "string" ||
          typeof stream.token !== "string" || typeof stream.name !== "string" ||
          typeof stream.avatar !== "string" || !Number.isInteger(stream.viewerCount) ||
          !Array.isArray(stream.iceServers) || stream.iceServers.length > 16) {
        return new Response("invalid stream", { status: 400 });
      }
      await this.state.storage.put(`stream:${stream.room}`, {
        room: stream.room,
        token: stream.token,
        name: stream.name.slice(0, 80),
        avatar: stream.avatar.slice(0, 512),
        viewerCount: Math.max(0, stream.viewerCount),
        iceServers: stream.iceServers,
        updatedAt: Date.now(),
      });
      await this.state.storage.setAlarm(Date.now() + STREAM_TTL_MS);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/streams/") && request.method === "DELETE") {
      const room = decodeURIComponent(url.pathname.slice("/streams/".length));
      await this.state.storage.delete(`stream:${room}`);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/oauth/states" && request.method === "POST") {
      const data = await request.json();
      if (typeof data.state !== "string" || data.state.length < 32 ||
          typeof data.clientState !== "string" || data.clientState.length < 32 ||
          typeof data.callback !== "string") {
        return new Response("invalid OAuth state", { status: 400 });
      }
      await this.state.storage.put(`oauth:${data.state}`, {
        callback: data.callback,
        clientState: data.clientState,
        createdAt: Date.now(),
      });
      await this.state.storage.setAlarm(Date.now() + OAUTH_STATE_TTL_MS);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/oauth/states/") && request.method === "GET") {
      const state = decodeURIComponent(url.pathname.slice("/oauth/states/".length));
      const key = `oauth:${state}`;
      const value = await this.state.storage.get(key);
      await this.state.storage.delete(key);
      if (!value || Date.now() - value.createdAt > OAUTH_STATE_TTL_MS) {
        return Response.json({ error: "expired-state" }, { status: 404 });
      }
      return Response.json(value);
    }
    return new Response("not found", { status: 404 });
  }

  async readStreams() {
    const entries = await this.state.storage.list({ prefix: "stream:" });
    const now = Date.now();
    const streams = [];
    for (const [key, stream] of entries) {
      if (now - stream.updatedAt > STREAM_TTL_MS) {
        await this.state.storage.delete(key);
      } else {
        streams.push(stream);
      }
    }
    streams.sort((left, right) => left.name.localeCompare(right.name) || left.room.localeCompare(right.room));
    return streams.map(({ room, token, name, avatar, viewerCount, iceServers }) => ({
      room,
      token,
      name,
      avatar,
      viewerCount,
      iceServers,
    }));
  }

  async alarm() {
    const now = Date.now();
    const [streams, states] = await Promise.all([
      this.state.storage.list({ prefix: "stream:" }),
      this.state.storage.list({ prefix: "oauth:" }),
    ]);
    let nextAlarm = 0;
    for (const [key, stream] of streams) {
      const expiresAt = stream.updatedAt + STREAM_TTL_MS;
      if (now >= expiresAt) {
        await this.state.storage.delete(key);
      } else {
        nextAlarm = nextAlarm === 0 ? expiresAt : Math.min(nextAlarm, expiresAt);
      }
    }
    for (const [key, flow] of states) {
      const expiresAt = flow.createdAt + OAUTH_STATE_TTL_MS;
      if (now >= expiresAt) {
        await this.state.storage.delete(key);
      } else {
        nextAlarm = nextAlarm === 0 ? expiresAt : Math.min(nextAlarm, expiresAt);
      }
    }
    if (nextAlarm > 0) await this.state.storage.setAlarm(nextAlarm);
  }
}
