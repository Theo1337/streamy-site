// Stable front door for the self-hosted relay and bot.
//
// Discord's Activity proxy sends /.proxy/api/* and /.proxy/relay/* here, and we
// forward them to whichever Cloudflare tunnel is currently pointed at the
// user's machine. The tunnel hostname is looked up from KV on every request so
// restarting the local stack never requires touching the Developer Portal.

const EXACT_PATHS = new Set(["/token", "/api/token"]);

const PATH_PREFIXES = ["/v1/watch/", "/v1/publish/", "/relay/", "/relay"];

export function isTunnelPath(pathname) {
  if (EXACT_PATHS.has(pathname)) return true;
  return PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

function tunnelOrigin(host) {
  const trimmed = String(host || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

async function currentHost(env) {
  if (env.LOBBY) {
    try {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName("public"));
      const response = await lobby.fetch("https://lobby/tunnel");
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data.host === "string" && data.host) return data.host;
      }
    } catch {
      // Fall through to the static value so local dev keeps working.
    }
  }
  return env.TUNNEL_HOST || "";
}

export async function proxyToTunnel(request, env, url) {
  const origin = tunnelOrigin(await currentHost(env));
  if (!origin) {
    return new Response(JSON.stringify({ error: "relay-offline" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  // The portal mapping may or may not strip its prefix, so both /relay/v1/x and
  // /v1/x have to land on the same upstream path.
  const pathname = url.pathname.replace(/^\/relay(?=\/v1\/)/, "");
  const target = new URL(`${origin}${pathname}${url.search}`);

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
  }

  const upstream = await fetch(new Request(target.toString(), init));
  return upstream;
}
