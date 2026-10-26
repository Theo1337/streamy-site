export function installLobby() {
  // ---------- demo fallback data ----------
  const demoStreams = [
    { room: "demo-1", token: "demo_token_1___________________________________", name: "Theo", viewers: "2.4K", viewerCount: 2400, tone: "screen", isDemo: true },
    { room: "demo-2", token: "demo_token_2___________________________________", name: "Mira", viewers: "1.1K", viewerCount: 1100, tone: "avatar", isDemo: true },
    { room: "demo-3", token: "demo_token_3___________________________________", name: "Rin",  viewers: "842",  viewerCount: 842,  tone: "purple", isDemo: true },
  ];

  let isDemoActive = false;

  // ---------- icons (Lucide, inlined) ----------
  const icons = {
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    volume2: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
    volumeX: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    expand: '<path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/>',
    minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    refresh: '<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>',
    radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M12 12h.01M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
  };

  const icon = (name, size) =>
    `<svg class="icon icon-${size}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ""}</svg>`;

  function escapeHTML(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatViewers(count) {
    if (typeof count === "string") return count;
    const num = Number(count) || 0;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  }

  // ---------- DOM Elements ----------
  const stage = document.getElementById("stage");
  const countElement = document.getElementById("count");
  const lobbyEmpty = document.getElementById("lobby-empty");
  const demoToggleBtn = document.getElementById("demo-toggle-btn");
  const channelName = document.getElementById("channel-name");
  const playerStaging = document.getElementById("player-staging");

  if (demoToggleBtn) {
    demoToggleBtn.addEventListener("click", () => {
      isDemoActive = !isDemoActive;
      demoToggleBtn.textContent = isDemoActive ? "Hide Demo Grid" : "Preview Demo Grid";
      if (isDemoActive) {
        if (lobbyEmpty) lobbyEmpty.hidden = true;
        if (window.Streamy?.selectStream) {
          window.Streamy.selectStream(demoStreams[0]);
        }
      } else {
        const liveStreams = window.Streamy?.streams || [];
        if (liveStreams.length === 0 && lobbyEmpty) {
          lobbyEmpty.hidden = false;
        }
        window.Streamy?.deselectStream?.();
      }
      render();
    });
  }

  // ---------- templates ----------
  function tileContentHTML(stream) {
    if (stream.tone === "screen") {
      return `
        <div class="content content--screen">
          <div class="tabs"><span>TERMINAL</span><span>EDITOR</span><span>PREVIEW</span></div>
          <p class="l1">const stream = createStream('general')</p>
          <p class="l2">await stream.connect()</p>
          <p class="l3">{ status: live, viewers: 2400 }</p>
          <div class="bar b1"></div>
          <div class="bar b2"></div>
        </div>`;
    }
    if (stream.tone === "avatar") {
      return `<div class="content content--avatar"><div class="big-avatar">M</div></div>`;
    }
    if (stream.tone === "purple") {
      return `<div class="content content--purple">${icon("sparkles", "xl")}</div>`;
    }
    return `
      <div class="content content--live-preview">
        ${icon("radio", "xl")}
      </div>`;
  }

  function avatarHTML(stream) {
    if (stream.avatar && typeof stream.avatar === "string" && stream.avatar.startsWith("https://")) {
      return `<img class="streamer-avatar" src="${escapeHTML(stream.avatar)}" alt="${escapeHTML(stream.name)}" />`;
    }
    const initial = (stream.name.trim()[0] || "S").toUpperCase();
    return `<span class="streamer-avatar">${escapeHTML(initial)}</span>`;
  }

  function overlayHTML(stream) {
    const viewers = formatViewers(stream.viewerCount ?? stream.viewers);
    const name = stream.name;
    return `
      <div class="overlay">
        <div class="overlay-top">
          <span class="live-badge">LIVE</span>
          <span class="viewers" aria-label="${viewers} viewers">${icon("eye", "xs")}${viewers}</span>
        </div>
        <div class="streamer">
          ${avatarHTML(stream)}
          <p class="streamer-name">${escapeHTML(name)}</p>
        </div>
      </div>`;
  }

  function controlsHTML(stream) {
    const currentVolume = window.Streamy ? window.Streamy.volume : 75;
    // The fullscreen button is the only way to get rid of the surrounding UI
    // and give the video the whole page.
    const cinema = window.Streamy?.isCinema;
    const fullscreen = `<button class="icon-btn fullscreen-btn" aria-label="${
      cinema ? "Leave fullscreen" : `Open ${escapeHTML(stream.name)} fullscreen`
    }" aria-pressed="${cinema ? "true" : "false"}">${icon(
      cinema ? "minimize" : "expand",
      "sm",
    )}</button>`;
    return `
      <div class="controls">
        <div class="volume">
          <div class="volume-pop">
            <div class="volume-box">
              <input class="volume-slider" type="range" min="0" max="100" value="${currentVolume}"
                     aria-label="Volume for ${escapeHTML(stream.name)}" />
            </div>
          </div>
          <button class="icon-btn mute-btn" aria-label="Mute ${escapeHTML(stream.name)}"></button>
        </div>
        ${fullscreen}
      </div>`;
  }

  function switchButtonHTML(stream) {
    return `
      <div class="switch-button">
        <span>Switch to ${escapeHTML(stream.name)}</span>
        ${icon("radio", "sm")}
      </div>`;
  }

  function cardHTML(stream, variant) {
    const isActive = variant === "card--active";
    return `
      <article class="card ${variant}" data-room="${escapeHTML(stream.room || "")}" data-name="${escapeHTML(stream.name)}">
        ${isActive ? '<div class="card-media" id="card-media"></div>' : tileContentHTML(stream)}
        ${overlayHTML(stream)}
        ${isActive ? controlsHTML(stream) : switchButtonHTML(stream)}
      </article>`;
  }

  function getAvailableStreams() {
    const realStreams = window.Streamy?.streams || [];
    if (realStreams.length > 0) return realStreams;
    if (isDemoActive) return demoStreams;
    return [];
  }

  function streamKey(stream) {
    return stream?.room || stream?.name || "";
  }

  function layoutKey(streams, selected) {
    const active = selected || (streams.length === 1 ? streams[0] : null);
    const activeKey = streamKey(active);
    const rest = streams
      .map(streamKey)
      .filter((key) => key && key !== activeKey)
      .join("|");
    return `${activeKey}::${rest}`;
  }

  let lastLayoutKey = "";

  function stageHasFullscreen() {
    const el = document.fullscreenElement || document.webkitFullscreenElement;
    const nativeVideo = !!(document.webkitDisplayingFullscreen ||
      window.Streamy?.getVideoElement?.()?.webkitDisplayingFullscreen);
    // Cinema mode is the fallback when the Fullscreen API is unavailable, so it
    // has to freeze the layout too.
    const cinema = !!window.Streamy?.isCinema;
    return cinema || nativeVideo || !!(el && stage && (el === stage || stage.contains(el)));
  }

  function attachPlayer(active) {
    const playerEl = window.Streamy?.getPlayerElement();
    if (!playerEl) return;
    if (active) {
      const cardMedia = document.getElementById("card-media");
      if (cardMedia && playerEl.parentElement !== cardMedia) {
        cardMedia.appendChild(playerEl);
      }
      return;
    }
    if (playerStaging && playerEl.parentElement !== playerStaging) {
      playerStaging.appendChild(playerEl);
    }
  }

  // ---------- rendering ----------
  function render() {
    if (!stage) return;
    if (window.Streamy?.isManual) return;

    const unique = new Map();
    for (const stream of getAvailableStreams()) {
      const key = streamKey(stream);
      if (key && !unique.has(key)) unique.set(key, stream);
    }
    const streams = [...unique.values()];
    const selected = window.Streamy?.selectedStream;

    if (countElement) {
      countElement.textContent = `${streams.length} live stream${streams.length === 1 ? "" : "s"}`;
    }

    if (channelName) {
      channelName.textContent = selected ? selected.name : "General";
    }

    const active = selected || (streams.length === 1 ? streams[0] : null);

    // The fullscreen element is an active card, so rebuilding the stage would
    // drop the browser out of fullscreen after a few seconds. Leave the DOM
    // exactly as it is while fullscreen is active.
    if (stageHasFullscreen()) {
      if (active) attachPlayer(active);
      syncControls();
      return;
    }

    const nextKey = layoutKey(streams, selected);

    if (streams.length === 0) {
      lastLayoutKey = nextKey;
      stage.innerHTML = "";
      if (lobbyEmpty) lobbyEmpty.hidden = false;
      attachPlayer(null);
      return;
    }

    if (lobbyEmpty) lobbyEmpty.hidden = true;

    if (nextKey === lastLayoutKey && stage.querySelector(".card")) {
      attachPlayer(active);
      syncControls();
      return;
    }

    const remaining = active
      ? streams.filter((s) => streamKey(s) !== streamKey(active))
      : streams;
    const existingActive = stage.querySelector(".card--active");
    const keepFullscreenCard =
      stageHasFullscreen() &&
      existingActive &&
      active &&
      existingActive.dataset.room === streamKey(active);

    lastLayoutKey = nextKey;

    if (keepFullscreenCard) {
      const grid = stage.querySelector(".grid");
      if (remaining.length === 0) {
        if (grid) grid.remove();
      } else {
        const html = `<div class="grid grid--strip">${remaining.map((s) => cardHTML(s, "card--tile")).join("")}</div>`;
        if (grid) grid.outerHTML = html;
        else stage.insertAdjacentHTML("beforeend", html);
      }
      attachPlayer(active);
      syncControls();
      return;
    }

    stage.innerHTML =
      (active ? cardHTML(active, "card--active") : "") +
      (remaining.length > 0
        ? `<div class="grid ${active ? "grid--strip" : "grid--full"}">
             ${remaining.map((s) => cardHTML(s, "card--tile")).join("")}
           </div>`
        : "");

    attachPlayer(active);
    syncControls();
  }

  // Updates every slider + mute icon in place without interrupting dragging
  function syncControls() {
    if (!stage) return;
    const vol = window.Streamy ? window.Streamy.volume : 75;
    const isMuted = window.Streamy ? window.Streamy.muted : false;

    stage.querySelectorAll(".volume-slider").forEach((slider) => {
      slider.value = vol;
      slider.style.setProperty("--fill", vol + "%");
    });
    stage.querySelectorAll(".mute-btn").forEach((btn) => {
      btn.innerHTML = isMuted || vol === 0 ? icon("volumeX", "sm") : icon("volume2", "sm");
    });
  }

  // ---------- events (delegated) ----------
  if (stage) {
    // Stop all control events from bubbling up to the card
    ["click", "pointerdown", "pointerup", "mousedown", "mouseup"].forEach((evt) => {
      stage.addEventListener(evt, (e) => {
        if (e.target.closest(".controls")) {
          e.stopPropagation();
        }
      });
    });

    stage.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("volume-slider")) {
        const volumeWrapper = e.target.closest(".volume");
        if (volumeWrapper) volumeWrapper.classList.add("is-dragging");
      }
    });

    document.addEventListener("pointerup", () => {
      document.querySelectorAll(".volume.is-dragging").forEach((el) => {
        el.classList.remove("is-dragging");
      });
    });

    stage.addEventListener("input", (e) => {
      if (!e.target.classList.contains("volume-slider")) return;
      e.stopPropagation();
      const val = Number(e.target.value);
      if (window.Streamy?.setVolume) {
        window.Streamy.setVolume(val);
      }
      syncControls();
    });

    stage.addEventListener("click", (e) => {
      // Handle button clicks in controls directly
      if (e.target.closest(".mute-btn")) {
        e.stopPropagation();
        window.Streamy?.toggleMute?.();
        syncControls();
        return;
      }
      if (e.target.closest(".fullscreen-btn")) {
        e.stopPropagation();
        const activeCard = stage.querySelector(".card--active");
        window.Streamy?.toggleFullscreen?.(activeCard);
        return;
      }
      if (e.target.closest(".controls")) {
        e.stopPropagation();
        return;
      }

      // Clicking on the active stream card or video must NEVER reload or deselect!
      if (e.target.closest(".card--active")) {
        return;
      }

      // Only clicking an inactive stream tile switches streams
      const tileCard = e.target.closest(".card--tile");
      if (!tileCard) return;

      const room = tileCard.dataset.room;
      const name = tileCard.dataset.name;
      const streams = getAvailableStreams();
      const targetStream = streams.find((s) => (room ? s.room === room : s.name === name));
      if (targetStream) {
        window.Streamy?.selectStream?.(targetStream);
      }
    });
  }

  // While fullscreen is active render() deliberately leaves the stage alone.
  // Once the browser leaves fullscreen, do the pending layout update.
  function handleFullscreenChange() {
    if (!stageHasFullscreen()) {
      lastLayoutKey = "";
      render();
    }
  }
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
  const videoElement = window.Streamy?.getVideoElement?.();
  videoElement?.addEventListener("webkitendfullscreen", handleFullscreenChange);

  // Register with window.Streamy controller hooks
  if (window.Streamy) {
    window.Streamy.onStreamsUpdated = () => {
      render();
    };

    window.Streamy.onSelectedStreamChanged = (stream) => {
      render();
    };

    // Lightweight in-place update: just patch the overlay badges without
    // touching stage.innerHTML or disconnecting the <video> element.
    window.Streamy.onStreamMetadataChanged = (stream) => {
      if (!stage || !stream) return;
      const activeCard = stage.querySelector(".card--active");
      if (!activeCard) return;

      const viewers = formatViewers(stream.viewerCount ?? stream.viewers);

      // Update the viewer count badge
      const viewerBadge = activeCard.querySelector(".viewers");
      if (viewerBadge) {
        viewerBadge.setAttribute("aria-label", `${viewers} viewers`);
        viewerBadge.innerHTML = `${icon("eye", "xs")}${viewers}`;
      }

      // Update the streamer name
      const displayName = stream.name;
      const nameEl = activeCard.querySelector(".streamer-name");
      if (nameEl) nameEl.textContent = displayName;

      // Update channel name in topbar
      if (channelName) channelName.textContent = displayName;

      // Sync volume controls (safe, no DOM rebuild)
      syncControls();
    };

    window.Streamy.onAudioChanged = () => {
      syncControls();
    };

    // Patch the button in place: rebuilding the stage here would detach and
    // re-attach the player element in the middle of playback.
    window.Streamy.onCinemaChanged = () => {
      const cinema = !!window.Streamy?.isCinema;
      const button = stage?.querySelector(".card--active .fullscreen-btn");
      if (button) {
        button.setAttribute("aria-label", cinema ? "Leave fullscreen" : "Open fullscreen");
        button.setAttribute("aria-pressed", cinema ? "true" : "false");
        button.innerHTML = icon(cinema ? "minimize" : "expand", "sm");
      }
      if (!cinema) {
        lastLayoutKey = "";
        render();
      }
    };
  }

  // Initial render
  render();
}