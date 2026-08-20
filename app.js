import {
  clockOffsetFromSample,
  expectedPosition,
  formatDuration,
  median,
  toLocalDateTimeValue,
} from "./drifter-core.js";

const STORAGE_KEY = "drifter.settings.v1";
const CLOCK_SAMPLES = 5;
const HARD_DRIFT_SECONDS = 0.45;
const SOFT_DRIFT_SECONDS = 0.08;

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
  mode: "setup",
  ticker: null,
  correctionTicker: null,
  wakeLock: null,
};

function synchronizedNow() {
  return Date.now() + state.clockOffset;
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

function setClockDisplay(source, offset = 0) {
  elements.clockButton.classList.remove("synced", "local");
  if (source === "server") {
    elements.clockButton.classList.add("synced");
    const rounded = Math.round(offset / 100) / 10;
    elements.clockLabel.textContent = Math.abs(rounded) < 0.1 ? "Clock synced" : `Clock synced · ${rounded > 0 ? "+" : ""}${rounded}s`;
  } else if (source === "syncing") {
    elements.clockLabel.textContent = "Syncing clock…";
  } else {
    elements.clockButton.classList.add("local");
    elements.clockLabel.textContent = "Using device clock";
  }
}

async function syncClock() {
  setClockDisplay("syncing");
  elements.clockButton.disabled = true;
  const samples = [];

  try {
    for (let index = 0; index < CLOCK_SAMPLES; index += 1) {
      const clientStart = Date.now();
      const clockUrl = new URL(location.href);
      clockUrl.hash = "";
      clockUrl.searchParams.set("_clock", `${clientStart}-${index}`);
      const response = await fetch(clockUrl, {
        method: "HEAD",
        cache: "no-store",
      });
      const clientEnd = Date.now();
      const serverTime = Date.parse(response.headers.get("date"));
      if (!response.ok || !Number.isFinite(serverTime)) continue;
      samples.push({
        // HTTP dates have one-second precision; use the middle of that second.
        offset: clockOffsetFromSample(clientStart, clientEnd, serverTime + 500),
        roundTrip: clientEnd - clientStart,
      });
    }

    if (!samples.length) throw new Error("No usable clock response");
    const fastest = [...samples].sort((a, b) => a.roundTrip - b.roundTrip).slice(0, 3);
    state.clockOffset = median(fastest.map((sample) => sample.offset));
    state.clockSource = "server";
    setClockDisplay("server", state.clockOffset);
  } catch (error) {
    console.warn("Clock synchronization unavailable; using the device clock.", error);
    state.clockOffset = 0;
    state.clockSource = "local";
    setClockDisplay("local");
  } finally {
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
  await unlockAudio();
  await requestWakeLock();

  if (synchronizedNow() >= state.startAt) {
    await joinPlayback();
  } else {
    setMode("waiting");
  }
  startTickers();
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
  state.correctionTicker = window.setInterval(correctPlaybackDrift, 2500);
}

function stopTickers() {
  window.clearInterval(state.ticker);
  window.clearInterval(state.correctionTicker);
  state.ticker = null;
  state.correctionTicker = null;
}

function updatePlayer() {
  if (!Number.isFinite(state.startAt)) return;
  const differenceMs = state.startAt - synchronizedNow();
  const duration = elements.audio.duration;

  if (state.mode === "waiting") {
    const remaining = Math.max(0, differenceMs / 1000);
    elements.countdownValue.textContent = formatDuration(remaining, remaining >= 3600);
    elements.countdownLabel.textContent = "until the track starts";
    if (differenceMs <= 0) joinPlayback();
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
  elements.syncStatus.textContent = state.clockSource === "server" ? "Server aligned" : "Device clock";
}

function correctPlaybackDrift() {
  if (state.mode !== "playing" || elements.audio.paused) return;
  const expected = expectedPosition(synchronizedNow(), state.startAt, elements.audio.duration);
  const drift = expected - elements.audio.currentTime;

  if (Math.abs(drift) > HARD_DRIFT_SECONDS) {
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
elements.clockButton.addEventListener("click", syncClock);

elements.audio.addEventListener("loadedmetadata", () => {
  elements.durationTime.textContent = formatDuration(elements.audio.duration);
});

elements.audio.addEventListener("ended", () => setMode("ended"));
elements.audio.addEventListener("error", () => {
  if (state.file) setMode("error");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ["waiting", "playing", "paused"].includes(state.mode)) {
    requestWakeLock();
    if (state.mode === "playing") correctPlaybackDrift();
  }
});

window.addEventListener("beforeunload", releaseAudioUrl);

restoreSettings();
updateFormState();
syncClock();
