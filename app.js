import {
  clockOffsetFromSample,
  expectedPosition,
  formatDuration,
  median,
  ntpSample,
  selectBestClockSample,
  toLocalDateTimeValue,
} from "./drifter-core.js";

const STORAGE_KEY = "drifter.settings.v1";
const PRECISION_CLOCK_SAMPLES = 9;
const COARSE_CLOCK_SAMPLES = 5;
const CLOCK_REFRESH_MS = 60_000;
const CLOCK_FRESH_MS = 30_000;
const CLOCK_STALE_GRACE_MS = 5 * 60_000;
const HARD_DRIFT_SECONDS = 0.1;
const SOFT_DRIFT_SECONDS = 0.03;
const config = window.DRIFTER_CONFIG ?? {};

const elements = {
  audio: document.querySelector("#audio"),
  clockButton: document.querySelector("#sync-clock"),
  clockLabel: document.querySelector("#clock-label"),
  fileInput: document.querySelector("#audio-file"),
  fileTitle: document.querySelector("#file-title"),
  fileDetail: document.querySelector("#file-detail"),
  rememberedFile: document.querySelector("#remembered-file"),
  startTime: document.querySelector("#start-time"),
  quickStart: document.querySelector("#quick-start"),
  goButton: document.querySelector("#go-button"),
  formHint: document.querySelector("#form-hint"),
  setupPanel: document.querySelector(".setup-panel"),
  playerPanel: document.querySelector("#player-panel"),
  stateLabel: document.querySelector("#state-label"),
  syncStatus: document.querySelector("#sync-status"),
  playerTitle: document.querySelector("#player-title"),
  playerMessage: document.querySelector("#player-message"),
  countdownValue: document.querySelector("#countdown-value"),
  countdownLabel: document.querySelector("#countdown-label"),
  trackProgress: document.querySelector("#track-progress"),
  elapsedTime: document.querySelector("#elapsed-time"),
  durationTime: document.querySelector("#duration-time"),
  pauseButton: document.querySelector("#pause-button"),
  leaveButton: document.querySelector("#leave-button"),
};

const state = {
  file: null,
  objectUrl: null,
  startAt: null,
  clockOffset: 0,
  clockSource: "local",
  clockUncertainty: Infinity,
  clockSyncedAt: 0,
  clockSyncPromise: null,
  mode: "setup",
  ticker: null,
  correctionTicker: null,
  clockRefreshTicker: null,
  startTimer: null,
  wakeLock: null,
};

function clientNow() {
  return Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

function synchronizedNow() {
  return clientNow() + state.clockOffset;
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const previous = loadSettings();
  const file = state.file
    ? {
        name: state.file.name,
        size: state.file.size,
        lastModified: state.file.lastModified,
      }
    : previous.file;

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      startAt: Number.isFinite(state.startAt) ? state.startAt : previous.startAt,
      file,
    }),
  );
}

function restoreSettings() {
  const saved = loadSettings();
  const defaultStart = Math.ceil((Date.now() + 2 * 60_000) / 60_000) * 60_000;
  state.startAt = Number.isFinite(saved.startAt) ? saved.startAt : defaultStart;
  elements.startTime.value = toLocalDateTimeValue(state.startAt);

  if (saved.file?.name) {
    elements.rememberedFile.hidden = false;
    elements.rememberedFile.textContent = `Last used: ${saved.file.name}. Select it again to rejoin.`;
  }
}

function updateFormState() {
  const parsedStart = new Date(elements.startTime.value).getTime();
  const validStart = Number.isFinite(parsedStart);
  elements.goButton.disabled = !state.file || !validStart;

  if (!state.file) {
    elements.formHint.textContent = "Choose a track to continue.";
  } else if (!validStart) {
    elements.formHint.textContent = "Choose a valid shared start time.";
  } else {
    const difference = parsedStart - synchronizedNow();
    elements.formHint.textContent = difference > 0
      ? `Ready to start in ${formatDuration(difference / 1000, difference >= 3_600_000)}.`
      : "This start time has passed. Go will join the track in progress.";
  }
}

function setClockDisplay(source, uncertainty = Infinity) {
  elements.clockButton.classList.remove("synced", "coarse", "local");
  if (source === "precision" && uncertainty < 100) {
    elements.clockButton.classList.add("synced");
    elements.clockLabel.textContent = `Synced · ±${Math.ceil(uncertainty)}ms`;
  } else if (source === "precision") {
    elements.clockButton.classList.add("coarse");
    elements.clockLabel.textContent = `Weak sync · ±${Math.ceil(uncertainty)}ms`;
  } else if (source === "stale") {
    elements.clockButton.classList.add("coarse");
    elements.clockLabel.textContent = `Sync retrying · ±${Math.ceil(uncertainty)}ms`;
  } else if (source === "coarse") {
    elements.clockButton.classList.add("coarse");
    elements.clockLabel.textContent = "Approx. clock · ±0.5s";
  } else if (source === "syncing") {
    elements.clockLabel.textContent = "Syncing clock…";
  } else {
    elements.clockButton.classList.add("local");
    elements.clockLabel.textContent = "Using device clock";
  }
}

function applyClockResult(result) {
  state.clockOffset = result.offset;
  state.clockSource = result.source;
  state.clockUncertainty = result.uncertainty;
  state.clockSyncedAt = clientNow();
  setClockDisplay(result.source, result.uncertainty);
  elements.clockButton.title = `Estimated clock adjustment: ${Math.round(result.offset)}ms`;
  if (state.mode === "waiting") schedulePlaybackStart();
}

async function samplePrecisionClock(endpoint) {
  const samples = [];
  let serverPrecision = 1;
  let successfulResponses = 0;
  let consecutiveFailures = 0;

  for (let index = 0; index < PRECISION_CLOCK_SAMPLES; index += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    try {
      const clockUrl = new URL(endpoint);
      clockUrl.searchParams.set("nonce", `${Date.now()}-${index}`);
      const clientSend = clientNow();
      const response = await fetch(clockUrl, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      const payload = await response.json();
      const clientReceive = clientNow();

      if (
        !response.ok ||
        !Number.isFinite(payload.serverReceiveTime) ||
        !Number.isFinite(payload.serverSendTime)
      ) {
        throw new Error("Invalid precision clock response");
      }

      serverPrecision = Number.isFinite(payload.precision) ? payload.precision : 1;
      // The first successful request includes connection setup and is a warm-up.
      if (successfulResponses > 0) {
        samples.push(ntpSample(
          clientSend,
          payload.serverReceiveTime,
          payload.serverSendTime,
          clientReceive,
        ));
      }
      successfulResponses += 1;
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (!samples.length && consecutiveFailures >= 2) break;
      console.info("Clock sample failed; continuing with the remaining samples.", error);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (samples.length < 3) throw new Error("Not enough precision clock samples");
  const best = selectBestClockSample(samples, serverPrecision);
  if (!best) throw new Error("No usable precision clock samples");
  return { ...best, source: "precision" };
}

async function sampleCoarseClock() {
  const samples = [];

  for (let index = 0; index < COARSE_CLOCK_SAMPLES; index += 1) {
      const clientStart = clientNow();
      const clockUrl = new URL(location.href);
      clockUrl.hash = "";
      clockUrl.searchParams.set("_clock", `${clientStart}-${index}`);
      const response = await fetch(clockUrl, {
        method: "HEAD",
        cache: "no-store",
      });
      const clientEnd = clientNow();
      const serverTime = Date.parse(response.headers.get("date"));
      if (!response.ok || !Number.isFinite(serverTime)) continue;
      samples.push({
        // HTTP dates have one-second precision; use the middle of that second.
        offset: clockOffsetFromSample(clientStart, clientEnd, serverTime + 500),
        roundTrip: clientEnd - clientStart,
      });
  }

  if (!samples.length) throw new Error("No usable coarse clock response");
  const fastest = [...samples].sort((a, b) => a.roundTrip - b.roundTrip).slice(0, 3);
  return {
    offset: median(fastest.map((sample) => sample.offset)),
    uncertainty: 500 + fastest[0].roundTrip / 2,
    source: "coarse",
  };
}

async function performClockSync(silent) {
  if (!silent) setClockDisplay("syncing");
  elements.clockButton.disabled = true;

  if (config.clockEndpoint) {
    try {
      const result = await samplePrecisionClock(config.clockEndpoint);
      applyClockResult(result);
      return result;
    } catch (error) {
      console.warn("Precision clock synchronization failed.", error);
      const preciseClockAge = clientNow() - state.clockSyncedAt;
      if (state.clockSource === "precision" && preciseClockAge < CLOCK_STALE_GRACE_MS) {
        setClockDisplay("stale", state.clockUncertainty);
        return null;
      }
    }
  }

  try {
    const result = await sampleCoarseClock();
    applyClockResult(result);
    return result;
  } catch (error) {
    console.warn("Clock synchronization unavailable; using the device clock.", error);
    applyClockResult({ offset: 0, uncertainty: Infinity, source: "local" });
    return null;
  }
}

async function syncClock({ silent = false } = {}) {
  if (state.clockSyncPromise) return state.clockSyncPromise;
  state.clockSyncPromise = performClockSync(silent);
  try {
    return await state.clockSyncPromise;
  } finally {
    state.clockSyncPromise = null;
    elements.clockButton.disabled = false;
    updateFormState();
  }
}

function releaseAudioUrl() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
}

function selectFile(file) {
  if (!file) return;
  releaseAudioUrl();
  state.file = file;
  state.objectUrl = URL.createObjectURL(file);
  elements.audio.src = state.objectUrl;
  elements.audio.load();
  elements.fileTitle.textContent = file.name;
  elements.fileDetail.textContent = `${formatFileSize(file.size)} · stored only on this device`;
  elements.rememberedFile.hidden = true;
  saveSettings();
  updateFormState();
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "Audio file";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function unlockAudio() {
  elements.audio.muted = true;
  try {
    await elements.audio.play();
    elements.audio.pause();
  } catch (error) {
    console.warn("Audio could not be pre-authorized.", error);
  } finally {
    elements.audio.muted = false;
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (error) {
    console.info("Screen wake lock unavailable.", error);
  }
}

function showPlayer() {
  elements.setupPanel.hidden = true;
  elements.playerPanel.hidden = false;
  elements.playerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showSetup() {
  stopTickers();
  elements.audio.pause();
  elements.audio.playbackRate = 1;
  state.mode = "setup";
  elements.playerPanel.hidden = true;
  elements.setupPanel.hidden = false;
  updateFormState();
  elements.setupPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function beginSession() {
  if (!state.file) return;
  const startAt = new Date(elements.startTime.value).getTime();
  if (!Number.isFinite(startAt)) return;

  state.startAt = startAt;
  saveSettings();
  showPlayer();
  // Invoke these immediately so the click's user activation reaches the media
  // element even if we still need to finish a network clock exchange.
  const audioReady = unlockAudio();
  const wakeLockReady = requestWakeLock();
  const clockAge = clientNow() - state.clockSyncedAt;
  const clockReady = clockAge > CLOCK_FRESH_MS ? syncClock({ silent: true }) : Promise.resolve();
  await Promise.all([audioReady, wakeLockReady, clockReady]);

  if (synchronizedNow() >= state.startAt) {
    await joinPlayback();
  } else {
    setMode("waiting");
  }
  startTickers();
  if (state.mode === "waiting") schedulePlaybackStart();
}

function setMode(mode) {
  state.mode = mode;
  const copy = {
    waiting: ["Waiting", "Ready to drift", "Playback will begin at the shared time."],
    playing: ["Playing", "You’re drifting", "Playback follows the group's shared timeline."],
    paused: ["Paused locally", "Take a moment", "Rejoin whenever you're ready."],
    ended: ["Finished", "The track has ended", "Choose another start time to drift again."],
    error: ["Playback issue", "Couldn’t play this file", "Try choosing the audio file again."],
  }[mode];

  if (!copy) return;
  [elements.stateLabel.textContent, elements.playerTitle.textContent, elements.playerMessage.textContent] = copy;
  elements.pauseButton.disabled = mode === "waiting" || mode === "ended";
  elements.pauseButton.textContent = mode === "paused" ? "Rejoin" : mode === "error" ? "Try again" : "Pause";
}

async function joinPlayback() {
  const duration = elements.audio.duration;
  const target = expectedPosition(synchronizedNow(), state.startAt, duration);

  if (Number.isFinite(duration) && target >= duration) {
    elements.audio.pause();
    elements.audio.currentTime = duration;
    setMode("ended");
    return;
  }

  try {
    elements.audio.currentTime = target;
    elements.audio.playbackRate = 1;
    await elements.audio.play();
    const startupTarget = expectedPosition(synchronizedNow(), state.startAt, duration);
    if (Math.abs(startupTarget - elements.audio.currentTime) > SOFT_DRIFT_SECONDS) {
      elements.audio.currentTime = startupTarget;
    }
    setMode("playing");
  } catch (error) {
    console.error("Playback failed.", error);
    setMode("error");
  }
}

function togglePause() {
  if (state.mode === "paused" || state.mode === "error") {
    joinPlayback();
    return;
  }
  if (state.mode === "playing") {
    elements.audio.pause();
    elements.audio.playbackRate = 1;
    setMode("paused");
  }
}

function startTickers() {
  stopTickers();
  updatePlayer();
  state.ticker = window.setInterval(updatePlayer, 100);
  state.correctionTicker = window.setInterval(correctPlaybackDrift, 1000);
}

function stopTickers() {
  window.clearInterval(state.ticker);
  window.clearInterval(state.correctionTicker);
  window.clearTimeout(state.startTimer);
  state.ticker = null;
  state.correctionTicker = null;
  state.startTimer = null;
}

function schedulePlaybackStart() {
  window.clearTimeout(state.startTimer);
  if (state.mode !== "waiting") return;
  const delay = Math.max(0, state.startAt - synchronizedNow());
  state.startTimer = window.setTimeout(async () => {
    const remaining = state.startAt - synchronizedNow();
    if (remaining > 5) {
      schedulePlaybackStart();
      return;
    }
    state.startTimer = null;
    await joinPlayback();
  }, Math.min(delay, 2_147_000_000));
}

function updatePlayer() {
  if (!Number.isFinite(state.startAt)) return;
  const differenceMs = state.startAt - synchronizedNow();
  const duration = elements.audio.duration;

  if (state.mode === "waiting") {
    const remaining = Math.max(0, differenceMs / 1000);
    elements.countdownValue.textContent = formatDuration(remaining, remaining >= 3600);
    elements.countdownLabel.textContent = "until the track starts";
    if (differenceMs <= 0 && !state.startTimer) joinPlayback();
  } else {
    const expected = expectedPosition(synchronizedNow(), state.startAt, duration);
    elements.countdownValue.textContent = formatDuration(expected, expected >= 3600);
    elements.countdownLabel.textContent = state.mode === "paused" ? "group position while you pause" : "shared track position";
  }

  const displayPosition = state.mode === "paused"
    ? expectedPosition(synchronizedNow(), state.startAt, duration)
    : elements.audio.currentTime;
  elements.elapsedTime.textContent = formatDuration(displayPosition);
  elements.durationTime.textContent = formatDuration(duration);
  elements.trackProgress.max = Number.isFinite(duration) && duration > 0 ? duration : 1;
  elements.trackProgress.value = Number.isFinite(displayPosition) ? Math.min(displayPosition, elements.trackProgress.max) : 0;
  elements.syncStatus.textContent = state.clockSource === "precision"
    ? `Aligned within ~${Math.ceil(state.clockUncertainty)}ms`
    : state.clockSource === "coarse"
      ? "Approximate clock"
      : "Device clock";
}

function correctPlaybackDrift() {
  if (state.mode !== "playing" || elements.audio.paused) return;
  const expected = expectedPosition(synchronizedNow(), state.startAt, elements.audio.duration);
  const drift = expected - elements.audio.currentTime;

  if (Math.abs(drift) >= HARD_DRIFT_SECONDS) {
    elements.audio.currentTime = expected;
    elements.audio.playbackRate = 1;
  } else if (Math.abs(drift) > SOFT_DRIFT_SECONDS) {
    elements.audio.playbackRate = drift > 0 ? 1.02 : 0.98;
  } else {
    elements.audio.playbackRate = 1;
  }
}

elements.fileInput.addEventListener("change", (event) => selectFile(event.target.files?.[0]));

elements.startTime.addEventListener("change", () => {
  const startAt = new Date(elements.startTime.value).getTime();
  if (Number.isFinite(startAt)) {
    state.startAt = startAt;
    saveSettings();
  }
  updateFormState();
});

elements.quickStart.addEventListener("click", () => {
  state.startAt = Math.ceil((synchronizedNow() + 2 * 60_000) / 60_000) * 60_000;
  elements.startTime.value = toLocalDateTimeValue(state.startAt);
  saveSettings();
  updateFormState();
});

elements.goButton.addEventListener("click", beginSession);
elements.pauseButton.addEventListener("click", togglePause);
elements.leaveButton.addEventListener("click", showSetup);
elements.clockButton.addEventListener("click", () => syncClock());

elements.audio.addEventListener("loadedmetadata", () => {
  elements.durationTime.textContent = formatDuration(elements.audio.duration);
});

elements.audio.addEventListener("ended", () => setMode("ended"));
elements.audio.addEventListener("error", () => {
  if (state.file) setMode("error");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (clientNow() - state.clockSyncedAt > CLOCK_FRESH_MS) syncClock({ silent: true });
    if (["waiting", "playing", "paused"].includes(state.mode)) {
      requestWakeLock();
      if (state.mode === "waiting") schedulePlaybackStart();
      if (state.mode === "playing") correctPlaybackDrift();
    }
  }
});

window.addEventListener("beforeunload", releaseAudioUrl);

restoreSettings();
updateFormState();
syncClock();
state.clockRefreshTicker = window.setInterval(() => {
  if (document.visibilityState === "visible") syncClock({ silent: true });
}, CLOCK_REFRESH_MS);
