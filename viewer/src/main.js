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
  canvas: document.querySelector("#canvas"),
  player: document.querySelector("#player"),
  playerHint: document.querySelector("#player-hint"),
  playerHintText: document.querySelector("#player-hint-text"),
  offer: document.querySelector("#offer"),
  answer: document.querySelector("#answer"),
  connect: document.querySelector("#connect"),
  reset: document.querySelector("#reset"),
  copy: document.querySelector("#copy"),
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

// Multi-transport state
const transports = new Map(); // room -> { transport, videoEl, isMain, stream }
const watchedStreams = new Set(); // room IDs being watched in bottom row
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
  // Close all transports and clean up video elements
  for (const [room, entry] of transports) {
    try { entry.transport.close(); } catch {}
    if (entry.videoEl && entry.videoEl.parentElement) {
      entry.videoEl.remove();
    }
  }
  transports.clear();
  watchedStreams.clear();
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

  let relayRoom = fragment.get("relay") || query.get("relay") || "";
  if (relayRoom === "1" || query.get("mode") === "relay") relayRoom = directRoom || "";

  if (relayRoom) {
    // Relay mode removed - fall back to lobby
    console.warn("Relay mode is no longer supported; showing lobby");
  }

  if (directRoom && directToken) {
    const credentials = {
      room: directRoom,
      token: directToken,
      signalURL,
      iceServers: parseICEServers(fragment.get("ice")),
    };
    roomCredentials = credentials; // For backward compatibility
    const stream = {
      room: directRoom,
      token: directToken,
      name: "Live Stream",
      avatar: "",
      viewerCount: 1,
      iceServers: credentials.iceServers,
    };
    currentStreams = [stream];
    selectedStream = stream;
    window.Streamy.onStreamsUpdated?.(currentStreams);
    window.Streamy.onSelectedStreamChanged?.(stream);
    connectWebRTC(stream, true, credentials);
    return;
  }

  void startLobby();
}

async function loadConfig() {
  try {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (response.ok) config = await response.json();
  } catch {
    // A missing config is fine: the built-in signaling URL still works.
  }

  // Fetch latest release from GitHub to construct download URL dynamically
  // Pattern: https://github.com/Theo1337/streamy-app/releases/download/v{version}/Streamy-Setup.exe
  // Note: /releases/latest excludes pre-releases, so we use /releases and filter
  try {
    const repo = "Theo1337/streamy-app";
    const releaseResponse = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      headers: { "Accept": "application/vnd.github.v3+json" },
      cache: "no-store"
    });
    if (releaseResponse.ok) {
      const releases = await releaseResponse.json();
      // Find the latest non-draft release (including pre-releases)
      const release = releases.find(r => !r.draft);
      if (release) {
        const version = release.tag_name.replace(/^v/, ""); // Remove 'v' prefix if present
        const downloadURL = `https://github.com/${repo}/releases/download/v${version}/Streamy-Setup.exe`;
        if (dom.downloadBtn) {
          dom.downloadBtn.href = downloadURL;
        }
      } else if (config.downloadURL && dom.downloadBtn) {
        // Fallback to config.json downloadURL if no releases found
        dom.downloadBtn.href = config.downloadURL;
      }
    } else if (config.downloadURL && dom.downloadBtn) {
      // Fallback to config.json downloadURL if GitHub API fails
      dom.downloadBtn.href = config.downloadURL;
    }
  } catch {
    // Fallback to config.json downloadURL if GitHub API fails
    if (config.downloadURL && dom.downloadBtn) {
      dom.downloadBtn.href = config.downloadURL;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Multi-Transport Management                                          */
/* ------------------------------------------------------------------ */

function getOrCreateVideoElement(room, isMain = false) {
  let entry = transports.get(room);
  if (entry?.videoEl) return entry.videoEl;

  const videoEl = document.createElement("video");
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.volume = 0;
  videoEl.autoplay = true;
  videoEl.dataset.room = room;
  videoEl.style.width = "100%";
  videoEl.style.height = "100%";
  videoEl.style.objectFit = isMain ? "contain" : "cover";
  videoEl.style.background = "#000";

  if (!entry) {
    entry = { transport: null, videoEl, isMain: false, stream: null };
    transports.set(room, entry);
  } else {
    entry.videoEl = videoEl;
  }
  return videoEl;
}

function connectWebRTC(stream, isMain = false, credentials) {
  if (!credentials) return;

  // Check if already connected to this room
  let entry = transports.get(stream.room);
  if (entry?.transport) {
    // Already connected, just update isMain flag
    entry.isMain = isMain;
    entry.stream = stream;
    if (isMain) {
      entry.videoEl.style.objectFit = "contain";
      moveVideoToMain(entry.videoEl);
      selectedStream = stream;
      window.Streamy.onSelectedStreamChanged?.(stream);
    } else {
      entry.videoEl.style.objectFit = "cover";
      attachWatchedVideo(stream.room, entry.videoEl);
    }
    applyAudioState();
    return;
  }

  const videoEl = getOrCreateVideoElement(stream.room, isMain);
  const transport = new WebRtcTransport({
    room: credentials.room,
    token: credentials.token,
    signalURL: credentials.signalURL,
    iceServers: credentials.iceServers,
  });

  entry = { transport, videoEl, isMain, stream };
  transports.set(stream.room, entry);

  attachTransport(transport, stream.room);
  void transport.connect();

  if (isMain) {
    moveVideoToMain(videoEl);
    if (dom.playerHint) dom.playerHint.hidden = false;
    if (dom.playerHintText) dom.playerHintText.textContent = `Connecting to ${stream?.name || "stream"}…`;
  }
}

function attachTransport(transport, room) {
  transport.onStatus((text, state) => {
    // A watched stream may be promoted to the main player after the transport
    // was created, so read the current role instead of closing over it.
    const entry = transports.get(room);
    if (entry?.isMain) {
      setStatus(text, state);
      if (dom.playerHintText && state !== "connected") {
        dom.playerHintText.textContent = hintForStatus(text);
      }
    }
  });
  transport.onVideo((value) => showVideo(room, value));
  transport.onAudio((value) => handleAudio(value, room));
}

function disconnectStream(room) {
  watchedStreams.delete(room);
  const entry = transports.get(room);
  if (entry) {
    try { entry.transport.close(); } catch {}
    // Remove video element from DOM
    if (entry.videoEl && entry.videoEl.parentElement) {
      entry.videoEl.remove();
    }
    transports.delete(room);
  }
  // If we disconnected the main stream, clear selection
  if (selectedStream?.room === room) {
    selectedStream = null;
    window.Streamy.onSelectedStreamChanged?.(null);
    resetPlayerSurface();
    setStatus(currentStreams.length ? "Select a stream" : "No streams live", "");
  }
}

function makeMainStream(room) {
  const entry = transports.get(room);
  if (!entry) {
    // Not connected in the bottom row: just select it normally.
    const stream = currentStreams.find((candidate) => candidate.room === room);
    if (stream) selectStream(stream);
    return;
  }

  const previous = selectedStream && selectedStream.room !== room
    ? transports.get(selectedStream.room)
    : null;

  // The promoted stream is no longer part of the bottom row.
  watchedStreams.delete(room);
  entry.isMain = true;

  // Keep the previous main stream playing in the bottom row instead of
  // dropping its connection when the user enlarges another stream.
  if (previous && previous.stream?.room && previous.stream.room !== room) {
    watchedStreams.add(previous.stream.room);
    previous.isMain = false;
  }

  for (const [candidateRoom, candidate] of transports) {
    candidate.isMain = candidateRoom === room;
  }

  // Move video element to main player
  moveVideoToMain(entry.videoEl);

  // Update selected stream
  selectedStream = entry.stream;
  window.Streamy.onSelectedStreamChanged?.(entry.stream);

  // Update roomCredentials to this stream's credentials for reconnection
  if (entry.stream) {
    roomCredentials = {
      room: entry.stream.room,
      token: entry.stream.token,
      signalURL: config.signalURL || DEFAULT_SIGNAL_URL,
      iceServers: mergeICEServers(DEFAULT_ICE_SERVERS, entry.stream.iceServers || []),
    };
  }

  applyAudioState();

  // Update status - the stream is already connected, so show connected
  setStatus("Connected", "connected");
  window.Streamy.onStreamsUpdated?.(currentStreams);
}

function moveVideoToMain(videoEl) {
  // Put the video element inside the #player container, replacing the static video
  if (dom.player) {
    const oldVideo = dom.player.querySelector("video");
    if (oldVideo && oldVideo !== videoEl) {
      oldVideo.remove();
    }
    // Insert videoEl as first child (before player-hint)
    const hint = dom.player.querySelector("#player-hint");
    if (hint) {
      dom.player.insertBefore(videoEl, hint);
    } else {
      dom.player.appendChild(videoEl);
    }
    // Update object-fit for main stream
    videoEl.style.objectFit = "contain";
  }
  if (dom.playerHint) dom.playerHint.hidden = true;
  // Apply audio state to main video
  applyAudioState();
}

function showVideo(room, value) {
  if (!value) return;

  const entry = transports.get(room);
  if (!entry) return;

  const videoEl = entry.videoEl;
  if (!videoEl) return;

  videoEl.hidden = false;
  if (value.kind === "stream") {
    videoEl.srcObject = value.stream;
  }

  // Read the live role so a stream promoted from the bottom row starts playing
  // in the main player even if its track arrived while it was a thumbnail.
  if (entry.isMain) {
    videoEl.style.objectFit = "contain";
    moveVideoToMain(videoEl);
    applyAudioState();
    // Hide the "Connecting..." hint when video starts
    if (dom.playerHint) dom.playerHint.hidden = true;
  } else {
    videoEl.style.objectFit = "cover";
    // For watched streams, attach video to the watched tile media container
    attachWatchedVideo(room, videoEl);
  }

  const playing = videoEl.play();
  if (playing && typeof playing.catch === "function") {
    playing.catch(() => {});
  }
}

// Attach a watched stream's video element to its tile in the grid
function attachWatchedVideo(room, videoEl) {
  if (!videoEl?.srcObject) return;
  // Find the live tile media container for this room
  const mediaContainer = document.querySelector(`.tile-media[data-room="${room}"]`);
  if (!mediaContainer) return;

  // If video is already in the container, do nothing
  if (mediaContainer.contains(videoEl)) return;

  // Clear any existing content and add the video
  mediaContainer.replaceChildren(videoEl);
}

function handleAudio(value, room) {
  if (!value) return;

  const entry = transports.get(room);
  if (entry && !entry.isMain) {
    // A bottom-row preview failing must not hijack the main player's status.
    if (value.error) {
      disconnectStream(room);
      window.Streamy.onStreamsUpdated?.(currentStreams);
    }
    return;
  }

  if (value.error) {
    showError(new Error(value.error));
    return;
  }
  if (value.unsupported) {
    showMessage("This browser cannot decode the stream's audio; video continues without sound.");
  }
}

function resetPlayerSurface() {
  if (dom.canvas) {
    dom.canvas.hidden = true;
    const context = dom.canvas.getContext("2d");
    context?.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  }
  // Clean up the player container - remove any dynamic video elements, restore static video
  if (dom.player) {
    const videos = dom.player.querySelectorAll("video");
    for (const video of videos) {
      video.srcObject = null;
      if (video.hasAttribute("src")) {
        video.removeAttribute("src");
        try { video.load(); } catch {}
      }
      // Remove dynamic video elements (those with data-room attribute)
      if (video.dataset.room) {
        video.remove();
      }
    }
    // Ensure static video element exists in player
    if (!dom.player.querySelector("#video")) {
      const staticVideo = document.createElement("video");
      staticVideo.id = "video";
      staticVideo.playsInline = true;
      staticVideo.muted = true;
      staticVideo.volume = 0;
      staticVideo.autoplay = true;
      staticVideo.hidden = false;
      const hint = dom.player.querySelector("#player-hint");
      if (hint) {
        dom.player.insertBefore(staticVideo, hint);
      } else {
        dom.player.appendChild(staticVideo);
      }
      // Update dom.video reference
      dom.video = staticVideo;
      setMediaElement(dom.video);
    }
  }
  if (dom.video) dom.video.hidden = false;
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

  // Drop bottom-row previews whose stream went offline.
  for (const room of [...watchedStreams]) {
    if (!validStreams.some((stream) => stream.room === room)) {
      disconnectStream(room);
    }
  }

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
      // Only the main stream is gone; bottom-row previews keep playing.
      disconnectStream(selectedStream.room);
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

  const previous = selectedStream;
  selectedStream = stream;
  if (stream.isDemo) {
    // Close all transports when switching to demo
    for (const [room, entry] of transports) {
      try { entry.transport.close(); } catch {}
      if (entry.videoEl && entry.videoEl.parentElement) {
        entry.videoEl.remove();
      }
    }
    transports.clear();
    watchedStreams.clear();
    resetPlayerSurface();
    setStatus("Demo stream", "");
    window.Streamy.onSelectedStreamChanged?.(stream);
    return;
  }

  // Selecting a stream makes it the main player, so it leaves the bottom row.
  watchedStreams.delete(stream.room);

  const credentials = {
    room: stream.room,
    token: stream.token,
    signalURL: config.signalURL || DEFAULT_SIGNAL_URL,
    iceServers: mergeICEServers(DEFAULT_ICE_SERVERS, stream.iceServers || []),
  };

  roomCredentials = credentials; // Keep for backward compatibility with manual mode

  // Stop the stream that used to be main. Bottom-row streams stay connected.
  if (previous && previous.room && previous.room !== stream.room && !watchedStreams.has(previous.room)) {
    const previousEntry = transports.get(previous.room);
    if (previousEntry) {
      try { previousEntry.transport.close(); } catch {}
      if (previousEntry.videoEl && previousEntry.videoEl.parentElement) {
        previousEntry.videoEl.remove();
      }
      transports.delete(previous.room);
    }
  }

  audio.muted = true;
  applyAudioState();
  notifyAudioChange();
  showMessage("");

  window.Streamy.onSelectedStreamChanged?.(stream);
  connectWebRTC(stream, true, credentials);
}

function deselectStream() {
  // Close all transports and clean up video elements
  for (const [room, entry] of transports) {
    try { entry.transport.close(); } catch {}
    if (entry.videoEl && entry.videoEl.parentElement) {
      entry.videoEl.remove();
    }
  }
  transports.clear();
  watchedStreams.clear();
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
    get watchedStreams() { return watchedStreams; },

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

    // Multistream API
    watchStream: (stream) => {
      if (!stream || !stream.room || stream.isDemo) return;
      // Already the main stream, or already in the bottom row.
      if (selectedStream?.room === stream.room) return;
      if (watchedStreams.has(stream.room)) return;
      watchedStreams.add(stream.room);
      const credentials = {
        room: stream.room,
        token: stream.token,
        signalURL: config.signalURL || DEFAULT_SIGNAL_URL,
        iceServers: mergeICEServers(DEFAULT_ICE_SERVERS, stream.iceServers || []),
      };
      connectWebRTC(stream, false, credentials);
      window.Streamy.onStreamsUpdated?.(currentStreams);
    },
    unwatchStream: (room) => {
      if (!room || selectedStream?.room === room) return;
      disconnectStream(room);
      window.Streamy.onStreamsUpdated?.(currentStreams);
    },
    makeMainStream: (room) => {
      makeMainStream(room);
    },
    // Re-attach existing <video> elements after the stage was re-rendered.
    syncVideos: () => {
      for (const [room, entry] of transports) {
        if (!entry.videoEl || entry.isMain || !entry.videoEl.srcObject) continue;
        entry.videoEl.style.objectFit = "cover";
        const media = document.querySelector(`.tile-media[data-room="${room}"]`);
        if (media && !media.contains(entry.videoEl)) {
          media.replaceChildren(entry.videoEl);
        }
      }
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
  // Apply to main video element
  if (dom.video) {
    dom.video.muted = audio.muted;
    dom.video.volume = audio.muted ? 0 : audio.volume;
  }
  // Only the main stream is audible; the bottom-row previews stay muted.
  for (const [, entry] of transports) {
    if (!entry.videoEl) continue;
    const isMain = entry.isMain;
    entry.videoEl.muted = isMain ? audio.muted : true;
    entry.videoEl.volume = isMain && !audio.muted ? audio.volume : 0;
  }
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
    // Close all transports when entering manual mode
    for (const [room, entry] of transports) {
      try { entry.transport.close(); } catch {}
      if (entry.videoEl && entry.videoEl.parentElement) {
        entry.videoEl.remove();
      }
    }
    transports.clear();
    watchedStreams.clear();
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
  if (!selectedStream || !roomCredentials) return;

  // Drop the old connection so connectWebRTC creates a fresh transport.
  const entry = transports.get(selectedStream.room);
  if (entry) {
    try { entry.transport.close(); } catch {}
    if (entry.videoEl) entry.videoEl.srcObject = null;
    transports.delete(selectedStream.room);
  }

  connectWebRTC(selectedStream, true, roomCredentials);
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

// Legacy single transport reference for backward compatibility
let currentTransport = null;
Object.defineProperty(window, 'currentTransport', {
  get() {
    return selectedStream ? transports.get(selectedStream.room)?.transport : null;
  }
});