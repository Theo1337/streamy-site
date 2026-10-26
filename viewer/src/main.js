import { installLobby } from "./lobby.js";
import { setMediaElement, WebRtcTransport } from "./transports/webrtc.js";

const DEFAULT_SIGNAL_URL = "wss://streamy-signal.thenightserver.workers.dev";
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const dom = {
  status: document.querySelector("#status"),
  video: document.querySelector("#video"),
  player: document.querySelector("#player"),
  playerHint: document.querySelector("#player-hint"),
  playerHintText: document.querySelector("#player-hint-text"),
  offer: document.querySelector("#offer"),
  answer: document.querySelector("#answer"),
  connect: document.querySelector("#connect"),
  reset: document.querySelector("#reset"),
  copy: document.querySelector("#copy"),
  message: document.querySelector("#message"),
  manual: document.querySelector("#manual"),
  manualToggle: document.querySelector("#manual-toggle"),
  reconnect: document.querySelector("#reconnect"),
  downloadBtn: document.querySelector("#download-btn"),
  lobbyEmpty: document.querySelector("#lobby-empty"),
  count: document.querySelector("#count"),
  workspace: document.querySelector("#workspace"),
  manualPreviewBody: document.querySelector("#manual-preview-body"),
  viewerMessage: document.querySelector("#viewer-message"),
};

const fragment = new URLSearchParams(location.hash.slice(1));
const query = new URLSearchParams(location.search);

let config = {};
let manualMode = query.get("manual") === "1";
let currentStreams = [];
let selectedStream = null;
let roomCredentials = null;
let lobbyTimer = null;
let currentTransport = null;
let manualPeer = null;

const audio = {
  volume: 0.75,
  previousVolume: 0.75,
  muted: true,
};

// Declared before installCinemaMode() runs: wakeControls() is called from there.
let controlsIdleTimer = null;

setMediaElement(dom.video);
installGlobalApi();
installCinemaMode();
installLobby();
void init();

if (dom.connect) dom.connect.addEventListener("click", () => void connectManual());
if (dom.reset) dom.reset.addEventListener("click", resetManual);
if (dom.copy) dom.copy.addEventListener("click", () => void copyAnswer());
if (dom.reconnect) dom.reconnect.addEventListener("click", reconnect);
if (dom.manualToggle) dom.manualToggle.addEventListener("click", () => toggleManual());
if (dom.video) {
  dom.video.muted = true;
  dom.video.volume = 0;
  dom.video.autoplay = true;
  dom.video.playsInline = true;
}
window.addEventListener("beforeunload", () => {
  currentTransport?.close();
  if (manualPeer) manualPeer.close();
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

async function init() {
  await loadConfig();

  if (manualMode) {
    toggleManual(true);
    setStatus("Manual test", "");
    return;
  }

  const directRoom = fragment.get("room") || query.get("room");
  const directToken = fragment.get("token") || query.get("token");
  const signalURL = fragment.get("signal") || config.signalURL || DEFAULT_SIGNAL_URL;

  if (directRoom && directToken) {
    roomCredentials = {
      room: directRoom,
      token: directToken,
      signalURL,
      iceServers: parseICEServers(fragment.get("ice")),
    };
    const stream = {
      room: directRoom,
      token: directToken,
      name: "Live Stream",
      avatar: "",
      viewerCount: 1,
      iceServers: roomCredentials.iceServers,
    };
    currentStreams = [stream];
    selectedStream = stream;
    window.Streamy.onStreamsUpdated?.(currentStreams);
    window.Streamy.onSelectedStreamChanged?.(stream);
    connectWebRTC(stream);
    return;
  }

  void startLobby();
}

async function loadConfig() {
  try {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (response.ok) config = await response.json();
    // Apply download URL from config to the download button
    if (dom.downloadBtn && config.downloadURL) {
      dom.downloadBtn.href = config.downloadURL;
    }
  } catch {
    // A missing config is fine: the built-in signaling URL still works.
  }
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

function connectWebRTC(stream) {
  closeTransport();
  resetPlayerSurface();
  const credentials = roomCredentials;
  if (!credentials) return;

  const transport = new WebRtcTransport({
    room: credentials.room,
    token: credentials.token,
    signalURL: credentials.signalURL,
    iceServers: credentials.iceServers,
  });
  attachTransport(transport);
  currentTransport = transport;
  void transport.connect();

  if (dom.playerHint) dom.playerHint.hidden = false;
  if (dom.playerHintText) dom.playerHintText.textContent = `Connecting to ${stream?.name || "stream"}…`;
}

function attachTransport(transport) {
  transport.onStatus((text, state) => {
    setStatus(text, state);
    if (dom.playerHintText && state !== "connected") {
      dom.playerHintText.textContent = hintForStatus(text);
    }
  });
  transport.onVideo((value) => showVideo(value));
  transport.onAudio((value) => handleAudio(value));
}

function closeTransport() {
  if (currentTransport) {
    try { currentTransport.close(); } catch {}
    currentTransport = null;
  }
}

function showVideo(value) {
  if (!value) return;

  if (dom.video) {
    dom.video.hidden = false;
    if (value.kind === "stream") {
      dom.video.srcObject = value.stream;
    }
    applyAudioState();
    const playing = dom.video.play();
    if (playing && typeof playing.catch === "function") {
      // Autoplay can be blocked until the first click. The stream is already
      // attached and the controls remain available, so do not interrupt the
      // viewer with a "press play" banner.
      playing.catch(() => {});
    }
  }
  if (dom.playerHint) dom.playerHint.hidden = true;
}

function handleAudio(value) {
  if (!value) return;
  if (value.error) {
    showError(new Error(value.error));
    return;
  }
  if (value.unsupported) {
    showMessage("This browser cannot decode the stream's audio; video continues without sound.");
  }
}

function resetPlayerSurface() {
  if (dom.video) {
    dom.video.srcObject = null;
    if (dom.video.hasAttribute("src")) {
      dom.video.removeAttribute("src");
      try { dom.video.load(); } catch {}
    }
    dom.video.hidden = false;
  }
  if (dom.playerHint) dom.playerHint.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

async function startLobby() {
  try {
    const signal = config.signalURL || DEFAULT_SIGNAL_URL;
    const endpoint = new URL(signal);
    if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") {
      throw new Error("The lobby signaling URL must use wss or ws.");
    }
    await refreshLobby();
    if (!lobbyTimer) lobbyTimer = setInterval(() => void refreshLobby(), 5000);
  } catch (error) {
    showError(error);
    if (dom.lobbyEmpty) {
      dom.lobbyEmpty.hidden = false;
      const sub = document.querySelector("#lobby-empty-sub");
      if (sub) sub.textContent = "Signaling server is currently unreachable. You can preview demo streams below.";
    }
    window.Streamy.onStreamsUpdated?.(currentStreams);
  }
}

async function refreshLobby() {
  const signal = config.signalURL || DEFAULT_SIGNAL_URL;
  try {
    const endpoint = new URL(signal);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/lobby`;
    endpoint.search = "";
    endpoint.hash = "";
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("Signaling server rejected viewer origin (403). Make sure VIEWER_ORIGINS includes this domain.");
      }
      throw new Error(`Lobby request failed (${response.status}).`);
    }
    const result = await response.json();
    if (!Array.isArray(result.streams)) throw new Error("The signaling Worker returned an invalid lobby.");
    applyLobbyStreams(result.streams);
  } catch (error) {
    if (!selectedStream) setStatus("Lobby offline", "error");
    if (dom.lobbyEmpty && currentStreams.length === 0) {
      dom.lobbyEmpty.hidden = false;
      const sub = document.querySelector("#lobby-empty-sub");
      if (sub) {
        sub.textContent = String(error.message).includes("403")
          ? "Signaling Worker rejected this origin (403). VIEWER_ORIGINS in the Worker needs to include this domain."
          : "Signaling server is currently unreachable. You can preview demo streams below.";
      }
    }
    showMessage(error instanceof Error ? error.message : String(error));
  }
}

function applyLobbyStreams(streams) {
  const seenRooms = new Set();
  const validStreams = streams.filter((stream) => {
    if (
      !/^[A-Za-z0-9_-]{16}$/.test(stream.room) ||
      !/^[A-Za-z0-9_-]{43}$/.test(stream.token) ||
      typeof stream.name !== "string" ||
      seenRooms.has(stream.room)
    ) {
      return false;
    }
    seenRooms.add(stream.room);
    return true;
  });
  const previousRooms = currentStreams.map((stream) => stream.room).join("\n");
  const nextRooms = validStreams.map((stream) => stream.room).join("\n");
  currentStreams = validStreams;

  if (dom.count) {
    dom.count.textContent = `${validStreams.length} live stream${validStreams.length === 1 ? "" : "s"}`;
  }
  if (dom.lobbyEmpty) dom.lobbyEmpty.hidden = validStreams.length !== 0;

  if (previousRooms !== nextRooms) {
    window.Streamy.onStreamsUpdated?.(validStreams);
  }

  if (selectedStream) {
    const latest = validStreams.find((stream) => stream.room === selectedStream.room);
    if (latest) {
      selectedStream = latest;
      window.Streamy.onStreamMetadataChanged?.(latest);
    } else if (!selectedStream.isDemo) {
      deselectStream();
      setStatus(validStreams.length ? "Select a stream" : "No streams live", "");
    }
  } else if (validStreams.length > 0 && !manualMode) {
    selectStream(validStreams[0]);
  } else if (validStreams.length === 0) {
    setStatus("No streams live", "");
  }
}

function selectStream(stream) {
  if (!stream) {
    deselectStream();
    return;
  }
  if (selectedStream?.room && selectedStream.room === stream.room) {
    selectedStream = stream;
    window.Streamy.onStreamMetadataChanged?.(stream);
    return;
  }

  selectedStream = stream;
  if (stream.isDemo) {
    closeTransport();
    resetPlayerSurface();
    setStatus("Demo stream", "");
    window.Streamy.onSelectedStreamChanged?.(stream);
    return;
  }

  roomCredentials = {
    room: stream.room,
    token: stream.token,
    signalURL: config.signalURL || DEFAULT_SIGNAL_URL,
    iceServers: mergeICEServers(DEFAULT_ICE_SERVERS, stream.iceServers || []),
  };

  audio.muted = true;
  applyAudioState();
  notifyAudioChange();
  showMessage("");

  window.Streamy.onSelectedStreamChanged?.(stream);
  connectWebRTC(stream);
}

function deselectStream() {
  closeTransport();
  resetPlayerSurface();
  selectedStream = null;
  window.Streamy.onSelectedStreamChanged?.(null);
  setStatus(currentStreams.length ? "Select a stream" : "No streams live", "");
}

/* ------------------------------------------------------------------ */
/* Global API used by lobby.js                                         */
/* ------------------------------------------------------------------ */

function installGlobalApi() {
  window.Streamy = {
    get streams() { return currentStreams; },
    get selectedStream() { return selectedStream; },
    get isManual() { return manualMode; },
    get volume() { return audio.muted ? 0 : Math.round(audio.volume * 100); },
    get muted() { return audio.muted; },
    get isCinema() { return document.body.classList.contains("cinema"); },

    getPlayerElement: () => dom.player,
    getVideoElement: () => dom.video,

    selectStream,
    deselectStream,
    setVolume,
    toggleMute,
    toggleFullscreen,
    togglePlayback,
    toggleManual,
    reconnect,
    connectManual,
    resetManual,
    copyAnswer,
    setStreams: (streams) => {
      currentStreams = streams;
      window.Streamy.onStreamsUpdated?.(currentStreams);
    },

    onStreamsUpdated: null,
    onSelectedStreamChanged: null,
    onStreamMetadataChanged: null,
    onStatusChanged: null,
    onAudioChanged: null,
    onMessageChanged: null,
    onCinemaChanged: null,
  };
}

/* ------------------------------------------------------------------ */
/* Audio, fullscreen and cinema mode                                   */
/* ------------------------------------------------------------------ */

/**
 * Player-only layout.
 *
 * Cinema mode hides the top bar, the live badges and the stream name so the
 * video fills the page, and the controls appear when the pointer moves. The
 * fullscreen button asks for real fullscreen where the browser allows it and
 * switches to the same layout otherwise.
 */
function installCinemaMode() {
  const syncFromFullscreen = () => {
    const element = document.fullscreenElement || document.webkitFullscreenElement;
    if (!element && document.body.classList.contains("cinema")) leaveCinema();
  };
  document.addEventListener("fullscreenchange", syncFromFullscreen);
  document.addEventListener("webkitfullscreenchange", syncFromFullscreen);
  for (const event of ["pointermove", "pointerdown", "pointerup", "keydown", "touchstart"]) {
    document.addEventListener(event, wakeControls, { passive: true });
  }
  wakeControls();
}

function wakeControls() {
  document.body.classList.remove("idle");
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(() => {
    if (!document.body.classList.contains("cinema")) return;
    // Never hide the buttons out from under a pointer that is using them.
    if (document.querySelector(".controls:hover, .volume:hover, .volume.is-dragging")) {
      wakeControls();
      return;
    }
    document.body.classList.add("idle");
  }, 2800);
}

function enterCinema() {
  document.body.classList.add("cinema");
  wakeControls();
  window.Streamy?.onCinemaChanged?.();
}

function leaveCinema() {
  document.body.classList.remove("cinema", "idle");
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = null;
  const element = document.fullscreenElement || document.webkitFullscreenElement;
  if (element) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.webkitExitFullscreen?.();
    }
  }
  window.Streamy?.onCinemaChanged?.();
}

function setVolume(percent) {
  const value = Math.max(0, Math.min(100, Number(percent)));
  audio.volume = value / 100;
  audio.muted = value === 0;
  if (value > 0) audio.previousVolume = audio.volume;
  applyAudioState();
  notifyAudioChange();
}

function toggleMute() {
  if (!audio.muted && audio.volume > 0) {
    audio.previousVolume = audio.volume;
    audio.muted = true;
  } else {
    audio.muted = false;
    audio.volume = audio.previousVolume || 0.75;
  }
  applyAudioState();
  notifyAudioChange();
}

function applyAudioState() {
  if (dom.video) {
    dom.video.muted = audio.muted;
    dom.video.volume = audio.muted ? 0 : audio.volume;
  }
  currentTransport?.setVolume?.(audio.volume);
  currentTransport?.setMuted?.(audio.muted);
}

function notifyAudioChange() {
  window.Streamy.onAudioChanged?.({
    volume: Math.round(audio.volume * 100),
    muted: audio.muted,
  });
}

async function togglePlayback() {
  if (!dom.video) return;
  try {
    if (dom.video.paused) await dom.video.play();
    else dom.video.pause();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Toggles player-only mode.
 *
 * Cinema mode does the part that always works: the video fills the page and the
 * rest of the UI goes away. Real fullscreen is requested on top of it, and
 * failing there must not leave the user with the normal page and no explanation.
 */
async function toggleFullscreen(targetElement) {
  if (document.body.classList.contains("cinema")) {
    leaveCinema();
    return;
  }
  enterCinema();
  const element = targetElement || dom.player || document.querySelector(".card--active") || document.documentElement;
  try {
    if (element.requestFullscreen) {
      await element.requestFullscreen({ navigationUI: "hide" });
      return;
    }
    if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
      return;
    }
  } catch {
    // The iframe refused; cinema mode is already in effect.
  }
  if (dom.video?.webkitEnterFullscreen) {
    try {
      dom.video.webkitEnterFullscreen();
    } catch {
      // Nothing left to try: the video already fills the page.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Manual SDP diagnostics                                              */
/* ------------------------------------------------------------------ */

function toggleManual(forceState) {
  manualMode = typeof forceState === "boolean" ? forceState : !manualMode;
  if (dom.workspace) dom.workspace.hidden = manualMode;
  if (dom.manual) dom.manual.hidden = !manualMode;
  if (dom.manualToggle) dom.manualToggle.classList.toggle("active", manualMode);

  if (manualMode) {
    closeTransport();
    setStatus("Manual test", "");
    if (dom.manualPreviewBody && dom.player) dom.manualPreviewBody.appendChild(dom.player);
    if (dom.playerHint) dom.playerHint.hidden = false;
    if (dom.playerHintText) dom.playerHintText.textContent = "Waiting for offer to begin…";
  } else {
    setStatus(selectedStream ? "Connecting" : (currentStreams.length ? "Live" : "No streams live"), selectedStream ? "pending" : "");
    window.Streamy.onSelectedStreamChanged?.(selectedStream);
  }
}

async function connectManual() {
  resetManualPeer();
  showMessage("");
  if (dom.answer) dom.answer.value = "";
  if (dom.copy) dom.copy.disabled = true;

  if (!dom.offer || !dom.offer.value.trim()) {
    showError(new Error("Paste the offer before creating an answer."));
    return;
  }

  let offer;
  try {
    offer = parseDescription(dom.offer.value, "offer");
  } catch (error) {
    showError(error);
    return;
  }

  if (dom.connect) dom.connect.disabled = true;
  setStatus("Connecting", "pending");
  if (dom.playerHint) dom.playerHint.hidden = false;
  if (dom.playerHintText) dom.playerHintText.textContent = "Establishing manual peer connection…";

  try {
    const connection = createManualPeer();
    await connection.setRemoteDescription(offer);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await waitForICEGathering(connection);
    if (dom.answer) dom.answer.value = JSON.stringify(connection.localDescription);
    if (dom.copy) dom.copy.disabled = false;
    setStatus("Answer ready", "pending");
    showMessage("Copy the answer and paste it into the streamy-manual terminal.");
  } catch (error) {
    showError(error);
    if (dom.connect) dom.connect.disabled = false;
    resetManualPeer();
  }
}

function createManualPeer() {
  resetManualPeer();
  const connection = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
  manualPeer = connection;

  connection.addEventListener("track", (event) => {
    if (!dom.video) return;
    dom.video.srcObject = event.streams[0] || new MediaStream([event.track]);
    dom.video.hidden = false;
    if (dom.playerHint) dom.playerHint.hidden = true;
    applyAudioState();
    dom.video.play().catch(() => {
      showMessage("The connection is ready. Click the stream to play audio/video.");
    });
  });

  connection.addEventListener("connectionstatechange", () => {
    if (manualPeer !== connection) return;
    const state = connection.connectionState;
    setStatus(connectionLabel(state), state === "connected" ? "connected" : state === "failed" ? "error" : "pending");
    if (state === "failed") {
      showMessage("The peer connection failed. Reconnect, or check firewall/NAT restrictions.");
    }
  });

  return connection;
}

function resetManualPeer() {
  if (manualPeer) {
    manualPeer.close();
    manualPeer = null;
  }
  if (dom.video) dom.video.srcObject = null;
}

function parseDescription(value, expectedType) {
  const input = value.trim();
  if (!input) throw new Error("Paste the offer before creating an answer.");
  const description = input.startsWith("{") ? JSON.parse(input) : { type: expectedType, sdp: input };
  if (description.type !== expectedType || typeof description.sdp !== "string" || !description.sdp.trim()) {
    throw new Error(`Expected a non-empty ${expectedType} SDP description.`);
  }
  return description;
}

function waitForICEGathering(connection) {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("ICE gathering timed out. Check network connectivity and try again."));
    }, 15000);
    const onStateChange = () => {
      if (connection.iceGatheringState === "complete") {
        cleanup();
        resolve();
      } else if (connection.signalingState === "closed") {
        cleanup();
        reject(new Error("Connection was closed before ICE gathering completed."));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onStateChange);
    };
    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function copyAnswer() {
  if (!dom.answer || !dom.answer.value) return;
  try {
    await navigator.clipboard.writeText(dom.answer.value);
    showMessage("Answer copied to clipboard! Paste it into the host terminal.");
  } catch {
    dom.answer.focus();
    dom.answer.select();
    showMessage("Clipboard access was blocked. The answer is selected; copy it manually.");
  }
}

function resetManual() {
  closeTransport();
  resetManualPeer();
  if (dom.offer) dom.offer.value = "";
  if (dom.answer) dom.answer.value = "";
  if (dom.connect) dom.connect.disabled = false;
  if (dom.copy) dom.copy.disabled = true;
  resetPlayerSurface();
  setStatus("Waiting for offer", "");
  showMessage("");
  if (dom.playerHintText) dom.playerHintText.textContent = "Waiting for offer to begin…";
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function reconnect() {
  if (manualMode) {
    resetManual();
    return;
  }
  if (!currentTransport) {
    if (selectedStream && roomCredentials) connectWebRTC(selectedStream);
    return;
  }
  const transport = currentTransport;
  if (typeof transport.reconnect === "function") void transport.reconnect();
  else void transport.connect();
}

function parseICEServers(encoded) {
  if (!encoded) return DEFAULT_ICE_SERVERS;
  try {
    const servers = JSON.parse(encoded);
    if (!Array.isArray(servers) || servers.some((server) =>
      !server || !(typeof server.urls === "string" || Array.isArray(server.urls)))) {
      throw new Error("Invalid ICE server list.");
    }
    return servers;
  } catch (error) {
    showError(new Error(`The viewer link has invalid ICE settings: ${error.message}`));
    return DEFAULT_ICE_SERVERS;
  }
}

function mergeICEServers(preferred, additional) {
  const servers = [...preferred];
  const seen = new Set(servers.map((server) => JSON.stringify(server)));
  for (const server of additional) {
    const key = JSON.stringify(server);
    if (!seen.has(key)) {
      seen.add(key);
      servers.push(server);
    }
  }
  return servers;
}

function setStatus(text, state) {
  if (dom.status) {
    dom.status.textContent = text;
    dom.status.dataset.state = state || "";
  }
  window.Streamy.onStatusChanged?.(text, state);
}

function showMessage(text) {
  if (dom.message) dom.message.textContent = text;
  if (dom.viewerMessage) {
    dom.viewerMessage.textContent = text || "";
    dom.viewerMessage.hidden = !text || manualMode;
  }
  window.Streamy.onMessageChanged?.(text);
}

function showError(error) {
  const text = error instanceof Error ? error.message : String(error);
  setStatus("Could not connect", "error");
  showMessage(text);
  if (dom.playerHint) dom.playerHint.hidden = false;
  if (dom.playerHintText) dom.playerHintText.textContent = text;
}

function hintForStatus(text) {
  if (/host|waiting/i.test(text)) return "Waiting for the host to go live…";
  if (/retry|reconnect|second/i.test(text)) return text;
  if (/full/i.test(text)) return "This stream has reached its viewer limit.";
  return "Connecting to the stream…";
}

function connectionLabel(state) {
  switch (state) {
    case "connected": return "Connected";
    case "connecting": return "Connecting";
    case "disconnected": return "Interrupted";
    case "failed": return "Connection failed";
    case "closed": return "Disconnected";
    default: return "Negotiating";
  }
}
