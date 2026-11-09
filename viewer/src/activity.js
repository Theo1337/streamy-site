/**
 * Discord Activity bootstrap.
 *
 * An Activity page is served from discordsays.com inside an iframe. Discord
 * adds `frame_id` to the query string, and the only backend URLs that work are
 * the relative `/.proxy/...` mappings configured in the Developer Portal.
 */
export function isActivity() {
  const params = new URLSearchParams(location.search);
  return params.has("frame_id") || /(^|\.)discordsays\.com$/i.test(location.hostname);
}

/**
 * Runs the full embedded-app handshake and returns the room identity.
 * Throws an Error with a user-readable message on failure.
 */
export async function bootstrapActivity(config) {
  if (!isActivity()) return null;

  const clientId = config?.discordClientID;
  if (!clientId) throw new Error("config.json has no discordClientID.");

  let DiscordSDK;
  try {
    ({ DiscordSDK } = await import("@discord/embedded-app-sdk"));
  } catch (error) {
    throw new Error(`The Discord Activity SDK failed to load: ${messageOf(error)}`);
  }

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  let code;
  try {
    const authorization = await sdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      state: "streamy",
      prompt: "none",
      scope: ["identify", "guilds"],
    });
    code = authorization.code;
  } catch (error) {
    throw new Error(`Discord authorization was cancelled or failed: ${messageOf(error)}`);
  }
  if (!code) throw new Error("Discord did not return an authorization code.");

  // This relative path is rewritten by Discord's proxy. Never use the bot's
  // absolute hostname here: the Activity iframe cannot reach it directly.
  // Discord strips the mapping prefix, so `/.proxy/api/token` reaches the bot
  // as `/token`; the bot accepts both paths.
  const tokenURL = config?.tokenURL || "/.proxy/api/token";
  if (!tokenURL.startsWith("/.proxy/")) {
    throw new Error("config.json tokenURL must be a relative /.proxy/ path inside Discord.");
  }
  const response = await fetch(tokenURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`The token exchange failed (HTTP ${response.status}). ${detail}`.trim());
  }

  const token = await response.json();
  if (!token.access_token) throw new Error("The token exchange returned no access_token.");

  try {
    await sdk.commands.authenticate({ access_token: token.access_token });
  } catch (error) {
    throw new Error(`Discord authentication failed: ${messageOf(error)}`);
  }

  const room = sdk.channelId || sdk.instanceId;
  if (!room) throw new Error("Discord did not provide a channel or instance ID.");

  return {
    sdk,
    room: String(room),
    channelId: sdk.channelId ? String(sdk.channelId) : "",
    instanceId: sdk.instanceId ? String(sdk.instanceId) : "",
    accessToken: token.access_token,
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
