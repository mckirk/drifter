import {
  clockOffsetFromSample,
  createPresetUrl,
  expectedPosition,
  formatDuration,
  median,
  ntpSample,
  parsePresetUrl,
  selectBestClockSample,
  sha256Hex,
  timestampsFromTimeApiPayload,
  timestampsFromWorkerPayload,
  toLocalDateTimeValue,
} from "./drifter-core.js";
import qrcode from "./vendor/qrcode.mjs";

const STORAGE_KEY = "drifter.settings.v1";
const PUBLIC_CLOCK_ENDPOINT = "https://timeapi.io/api/Time/current/zone?timeZone=UTC";
const PRECISION_CLOCK_SAMPLES = 7;
const COARSE_CLOCK_SAMPLES = 5;
const CUSTOM_CLOCK_REFRESH_MS = 60_000;
const PUBLIC_CLOCK_REFRESH_MS = 5 * 60_000;
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
  fileFingerprint: document.querySelector("#file-fingerprint"),
  fileHash: document.querySelector("#file-hash"),
  hashStatus: document.querySelector("#hash-status"),
  copyHashButton: document.querySelector("#copy-hash"),
  rememberedFile: document.querySelector("#remembered-file"),
  presetNotice: document.querySelector("#preset-notice"),
  presetDetail: document.querySelector("#preset-detail"),
  clearPresetButton: document.querySelector("#clear-preset"),
  startTime: document.querySelector("#start-time"),
  quickStart: document.querySelector("#quick-start"),
  sessionPresetQr: document.querySelector("#session-preset-qr"),
  sessionPresetUrl: document.querySelector("#session-preset-url"),
  sessionShare: document.querySelector("#session-share"),
  copySessionPresetButton: document.querySelector("#copy-session-preset"),
  shareSessionPresetButton: document.querySelector("#share-session-preset"),
  sessionShareStatus: document.querySelector("#session-share-status"),
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
  liveSync: document.querySelector("#live-sync"),
  syncNowButton: document.querySelector("#sync-now"),
  playbackSyncNote: document.querySelector("#playback-sync-note"),
  pauseButton: document.querySelector("#pause-button"),
  leaveButton: document.querySelector("#leave-button"),
};

const state = {
  file: null,
  objectUrl: null,
  fileHash: null,
  hashStatus: "idle",
  hashRequest: 0,
  requiredHash: null,
  sharedPresetUrl: null,
  startAt: null,
  clockOffset: 0,
  clockSource: "local",
  clockUncertainty: Infinity,
  clockProvider: "device",
  clockSyncedAt: 0,
  clockSyncPromise: null,
  mode: "setup",
  ticker: null,
  correctionTicker: null,
  clockRefreshTicker: null,
  startTimer: null,
  wakeLock: null,
  liveSyncEnabled: false,
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
        sha256: state.fileHash,
      }
    : previous.file;

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      startAt: Number.isFinite(state.startAt) ? state.startAt : previous.startAt,
      file,
      liveSyncEnabled: state.liveSyncEnabled,
    }),
  );
}

function restoreSettings() {
  const saved = loadSettings();
  const defaultStart = Math.ceil((Date.now() + 2 * 60_000) / 60_000) * 60_000;
  const preset = parsePresetUrl(location.href);
  state.startAt = preset?.startAt ?? (Number.isFinite(saved.startAt) ? saved.startAt : defaultStart);
  state.requiredHash = preset?.sha256 ?? null;
  state.liveSyncEnabled = saved.liveSyncEnabled === true;
  elements.liveSync.checked = state.liveSyncEnabled;
  updatePlaybackSyncControl();
  elements.startTime.value = toLocalDateTimeValue(state.startAt);

  if (preset) {
    const localStart = new Date(preset.startAt).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "long",
    });
    elements.presetNotice.hidden = false;
    elements.presetDetail.textContent = `${localStart} · expected SHA-256 ${abbreviateHash(preset.sha256)}`;
  }

  if (saved.file?.name) {
    elements.rememberedFile.hidden = false;
    elements.rememberedFile.textContent = `Last used: ${saved.file.name}. Select it again to rejoin.`;
  }
}

function updateFormState() {
  const parsedStart = new Date(elements.startTime.value).getTime();
  const validStart = Number.isFinite(parsedStart);
  const calculatingHash = state.hashStatus === "calculating";
  const hashMismatch = Boolean(
    state.requiredHash && state.fileHash && state.requiredHash !== state.fileHash,
  );
  const presetUnverified = Boolean(state.requiredHash && !state.fileHash);
  elements.goButton.disabled = !state.file || !validStart || calculatingHash || hashMismatch || presetUnverified;

  if (!state.file) {
    elements.formHint.textContent = state.requiredHash
      ? "Choose the local audio file referenced by this preset."
      : "Choose a track to continue.";
  } else if (calculatingHash) {
    elements.formHint.textContent = "Calculating the file fingerprint…";
  } else if (hashMismatch) {
    elements.formHint.textContent = "This file does not match the shared preset. Choose the matching file or ignore the preset.";
  } else if (presetUnverified) {
    elements.formHint.textContent = "The shared preset cannot be verified without a file fingerprint.";
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
  state.clockProvider = result.provider ?? result.source;
  state.clockSyncedAt = clientNow();
  setClockDisplay(result.source, result.uncertainty);
  elements.clockButton.title = `${result.label ?? "Clock"}; estimated adjustment: ${Math.round(result.offset)}ms`;
  if (state.mode === "waiting") schedulePlaybackStart();
}

async function samplePrecisionClock({ endpoint, label, parsePayload, provider }) {
  const samples = [];
  let serverPrecision = 1;
  let successfulResponses = 0;
  let consecutiveFailures = 0;

  for (let index = 0; index < PRECISION_CLOCK_SAMPLES; index += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    try {
      const clockUrl = new URL(endpoint);
      const nonce = crypto.randomUUID?.() ?? `${Math.round(performance.now())}-${index}`;
      clockUrl.searchParams.set("_drifter", nonce);
      const clientSend = clientNow();
      const response = await fetch(clockUrl, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const payload = await response.json();
      const clientReceive = clientNow();
      const timestamps = parsePayload(payload);

      if (!response.ok || !timestamps) {
        throw new Error("Invalid precision clock response");
      }

      serverPrecision = timestamps.precision;
      // The first successful request includes connection setup and is a warm-up.
      if (successfulResponses > 0) {
        samples.push(ntpSample(
          clientSend,
          timestamps.serverReceiveTime,
          timestamps.serverSendTime,
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
  return { ...best, source: "precision", provider, label };
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
    provider: "github",
    label: "GitHub header clock",
  };
}

async function performClockSync(silent) {
  if (!silent) setClockDisplay("syncing");
  elements.clockButton.disabled = true;

  const providers = [];
  if (config.clockEndpoint) {
    providers.push({
      endpoint: config.clockEndpoint,
      label: "Custom edge clock",
      parsePayload: timestampsFromWorkerPayload,
      provider: "worker",
    });
  }
  providers.push({
    endpoint: PUBLIC_CLOCK_ENDPOINT,
    label: "Public clock (TimeAPI.io)",
    parsePayload: timestampsFromTimeApiPayload,
    provider: "timeapi",
  });

  for (const provider of providers) {
    try {
      const result = await samplePrecisionClock(provider);
      applyClockResult(result);
      return result;
    } catch (error) {
      console.warn(`${provider.label} synchronization failed.`, error);
    }
  }

  const preciseClockAge = clientNow() - state.clockSyncedAt;
  if (state.clockSource === "precision" && preciseClockAge < CLOCK_STALE_GRACE_MS) {
    setClockDisplay("stale", state.clockUncertainty);
    return null;
  }

  try {
    const result = await sampleCoarseClock();
    applyClockResult(result);
    return result;
  } catch (error) {
    console.warn("Clock synchronization unavailable; using the device clock.", error);
    applyClockResult({
      offset: 0,
      uncertainty: Infinity,
      source: "local",
      provider: "device",
      label: "Device clock",
    });
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
    scheduleNextClockRefresh();
  }
}

function scheduleNextClockRefresh() {
  window.clearTimeout(state.clockRefreshTicker);
  const delay = state.clockProvider === "worker"
    ? CUSTOM_CLOCK_REFRESH_MS
    : PUBLIC_CLOCK_REFRESH_MS;
  state.clockRefreshTicker = window.setTimeout(async () => {
    if (document.visibilityState === "visible") await syncClock({ silent: true });
    else scheduleNextClockRefresh();
  }, delay);
}

function releaseAudioUrl() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
}

function abbreviateHash(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function invalidateShareResult() {
  state.sharedPresetUrl = null;
  elements.sessionPresetUrl.value = "";
  elements.sessionPresetQr.replaceChildren();
  elements.sessionShare.hidden = true;
  elements.copySessionPresetButton.textContent = "Copy link";
  elements.sessionShareStatus.textContent = "The QR code contains no audio; the file stays on this device.";
}

function updateHashDisplay() {
  elements.fileFingerprint.hidden = state.hashStatus === "idle";
  elements.hashStatus.classList.remove("verified", "mismatch", "error");
  elements.copyHashButton.hidden = !state.fileHash;
  elements.fileHash.textContent = state.fileHash ?? "";

  if (state.hashStatus === "calculating") {
    elements.hashStatus.textContent = "Calculating SHA-256…";
  } else if (state.hashStatus === "error") {
    elements.hashStatus.classList.add("error");
    elements.hashStatus.textContent = "Couldn’t calculate SHA-256";
  } else if (state.requiredHash && state.fileHash === state.requiredHash) {
    elements.hashStatus.classList.add("verified");
    elements.hashStatus.textContent = "✓ Matches shared preset";
  } else if (state.requiredHash && state.fileHash !== state.requiredHash) {
    elements.hashStatus.classList.add("mismatch");
    elements.hashStatus.textContent = "Does not match shared preset";
  } else if (state.fileHash) {
    elements.hashStatus.textContent = "SHA-256 fingerprint";
  }
}

async function selectFile(file) {
  if (!file) return;
  releaseAudioUrl();
  invalidateShareResult();
  state.file = file;
  state.fileHash = null;
  state.hashStatus = "calculating";
  const hashRequest = ++state.hashRequest;
  elements.copyHashButton.textContent = "Copy hash";
  state.objectUrl = URL.createObjectURL(file);
  elements.audio.src = state.objectUrl;
  elements.audio.load();
  elements.fileTitle.textContent = file.name;
  elements.fileDetail.textContent = `${formatFileSize(file.size)} · hashing locally…`;
  elements.rememberedFile.hidden = true;
  saveSettings();
  updateHashDisplay();
  updateFormState();

  try {
    const hash = await sha256Hex(await file.arrayBuffer());
    if (hashRequest !== state.hashRequest) return;
    state.fileHash = hash;
    state.hashStatus = "ready";
    elements.fileDetail.textContent = `${formatFileSize(file.size)} · stored only on this device`;
    saveSettings();
  } catch (error) {
    if (hashRequest !== state.hashRequest) return;
    state.hashStatus = "error";
    elements.fileDetail.textContent = `${formatFileSize(file.size)} · fingerprint unavailable`;
    console.error("Could not calculate the file fingerprint.", error);
  }
  updateHashDisplay();
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

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy was not available");
}

function createSharePreset() {
  const startAt = new Date(elements.startTime.value).getTime();
  if (!state.fileHash || !Number.isFinite(startAt)) return;
  const presetUrl = createPresetUrl(location.href, startAt, state.fileHash);
  const qr = qrcode(0, "M");
  qr.addData(presetUrl);
  qr.make();

  state.sharedPresetUrl = presetUrl;
  elements.sessionPresetUrl.value = presetUrl;
  const qrSvg = qr.createSvgTag({
    cellSize: 4,
    margin: 16,
    scalable: true,
    title: "Drifter preset QR code",
    alt: "Scan to open this start time and file fingerprint",
  });
  elements.sessionPresetQr.innerHTML = qrSvg;
  elements.sessionShare.hidden = state.mode === "setup";
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
  elements.sessionShare.hidden = !state.sharedPresetUrl;
  elements.playerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showSetup() {
  stopTickers();
  elements.audio.pause();
  elements.audio.playbackRate = 1;
  state.mode = "setup";
  elements.playerPanel.hidden = true;
  elements.sessionShare.hidden = true;
  elements.setupPanel.hidden = false;
  updateFormState();
  elements.setupPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function beginSession() {
  if (!state.file) return;
  const startAt = new Date(elements.startTime.value).getTime();
  if (!Number.isFinite(startAt)) return;

  state.startAt = startAt;
  createSharePreset();
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
  updatePlaybackSyncControl();
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

function updatePlaybackSyncControl(message) {
  elements.syncNowButton.hidden = state.liveSyncEnabled;
  elements.syncNowButton.disabled = !["playing", "paused"].includes(state.mode);
  elements.playbackSyncNote.textContent = message ?? (state.liveSyncEnabled
    ? "Automatically keeps playback aligned with the shared timeline."
    : "Playback runs freely. Use Sync now whenever you want to catch up.");
}

function syncPlaybackNow() {
  if (!["playing", "paused"].includes(state.mode)) return;
  const duration = elements.audio.duration;
  const target = expectedPosition(synchronizedNow(), state.startAt, duration);
  elements.audio.currentTime = target;
  elements.audio.playbackRate = 1;
  updatePlayer();
  updatePlaybackSyncControl("Synced just now. Live sync remains off.");
}

function setLiveSync(enabled) {
  state.liveSyncEnabled = enabled;
  elements.audio.playbackRate = 1;
  saveSettings();
  updatePlaybackSyncControl();
  if (enabled && state.mode === "playing") correctPlaybackDrift();
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
    ? `${state.clockProvider === "worker" ? "Custom" : "Public"} clock · ~${Math.ceil(state.clockUncertainty)}ms`
    : state.clockSource === "coarse"
      ? "Approximate clock"
      : "Device clock";
}

function correctPlaybackDrift() {
  if (!state.liveSyncEnabled || state.mode !== "playing" || elements.audio.paused) return;
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
  invalidateShareResult();
  updateFormState();
});

elements.quickStart.addEventListener("click", () => {
  state.startAt = Math.ceil((synchronizedNow() + 2 * 60_000) / 60_000) * 60_000;
  elements.startTime.value = toLocalDateTimeValue(state.startAt);
  saveSettings();
  invalidateShareResult();
  updateFormState();
});

elements.clearPresetButton.addEventListener("click", () => {
  state.requiredHash = null;
  elements.presetNotice.hidden = true;
  const url = new URL(location.href);
  url.searchParams.delete("start");
  url.searchParams.delete("sha256");
  history.replaceState(null, "", url);
  updateHashDisplay();
  updateFormState();
});

elements.copyHashButton.addEventListener("click", async () => {
  if (!state.fileHash) return;
  try {
    await copyText(state.fileHash);
    elements.copyHashButton.textContent = "Copied";
    window.setTimeout(() => { elements.copyHashButton.textContent = "Copy hash"; }, 1600);
  } catch (error) {
    console.error("Could not copy the fingerprint.", error);
    elements.copyHashButton.textContent = "Copy failed";
  }
});

async function copyPreset(button, status) {
  if (!state.sharedPresetUrl) return;
  try {
    await copyText(state.sharedPresetUrl);
    status.textContent = "Session link copied.";
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy link"; }, 1600);
  } catch (error) {
    console.error("Could not copy the preset link.", error);
    status.textContent = "Copy failed. Select the link above and copy it manually.";
  }
}

async function sharePreset(status) {
  if (!state.sharedPresetUrl || !navigator.share) return;
  try {
    await navigator.share({
      title: "Drifter listening preset",
      text: "Choose the matching audio file and join this shared start time.",
      url: state.sharedPresetUrl,
    });
    status.textContent = "Session shared.";
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Could not share the preset.", error);
      status.textContent = "Sharing was unavailable. Copy the link instead.";
    }
  }
}

elements.copySessionPresetButton.addEventListener("click", () => {
  copyPreset(elements.copySessionPresetButton, elements.sessionShareStatus);
});
elements.shareSessionPresetButton.addEventListener("click", () => sharePreset(elements.sessionShareStatus));

elements.goButton.addEventListener("click", beginSession);
elements.pauseButton.addEventListener("click", togglePause);
elements.liveSync.addEventListener("change", () => setLiveSync(elements.liveSync.checked));
elements.syncNowButton.addEventListener("click", syncPlaybackNow);
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

elements.shareSessionPresetButton.hidden = typeof navigator.share !== "function";
restoreSettings();
updateFormState();
syncClock();
