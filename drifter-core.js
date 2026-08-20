/** Return the clock offset represented by one request/response sample. */
export function clockOffsetFromSample(clientStart, clientEnd, serverTime) {
  return serverTime - (clientStart + clientEnd) / 2;
}

/**
 * Calculate an NTP-style sample from the four timestamps in one exchange.
 * All values are Unix epoch milliseconds.
 */
export function ntpSample(clientSend, serverReceive, serverSend, clientReceive) {
  const serverProcessing = Math.max(0, serverSend - serverReceive);
  return {
    offset: ((serverReceive - clientSend) + (serverSend - clientReceive)) / 2,
    roundTrip: Math.max(0, clientReceive - clientSend - serverProcessing),
  };
}

/** Select the sample least affected by network queueing and estimate its error. */
export function selectBestClockSample(samples, serverPrecision = 1) {
  const sorted = samples
    .filter((sample) => Number.isFinite(sample.offset) && Number.isFinite(sample.roundTrip))
    .sort((a, b) => a.roundTrip - b.roundTrip);

  if (!sorted.length) return null;
  const best = sorted[0];
  const nearby = sorted.slice(0, Math.min(5, sorted.length));
  const jitter = median(nearby.map((sample) => Math.abs(sample.offset - best.offset)));
  return {
    ...best,
    jitter,
    uncertainty: Math.ceil(Math.max(best.roundTrip / 2, jitter) + serverPrecision),
  };
}

/** Normalize the bundled Worker response into the timestamps used by NTP math. */
export function timestampsFromWorkerPayload(payload) {
  if (
    !Number.isFinite(payload?.serverReceiveTime) ||
    !Number.isFinite(payload?.serverSendTime)
  ) {
    return null;
  }
  return {
    serverReceiveTime: payload.serverReceiveTime,
    serverSendTime: payload.serverSendTime,
    precision: Number.isFinite(payload.precision) ? payload.precision : 1,
  };
}

/** Normalize TimeAPI.io's UTC calendar response without relying on local parsing. */
export function timestampsFromTimeApiPayload(payload) {
  if (payload?.timeZone && payload.timeZone !== "UTC") return null;
  const milliseconds = payload?.milliSeconds ?? payload?.milliseconds;
  const fields = [
    payload?.year,
    payload?.month,
    payload?.day,
    payload?.hour,
    payload?.minute,
    payload?.seconds,
    milliseconds,
  ];
  if (!fields.every(Number.isFinite)) return null;

  const timestamp = Date.UTC(
    payload.year,
    payload.month - 1,
    payload.day,
    payload.hour,
    payload.minute,
    payload.seconds,
    milliseconds,
  );
  if (!Number.isFinite(timestamp)) return null;

  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== payload.year ||
    parsed.getUTCMonth() !== payload.month - 1 ||
    parsed.getUTCDate() !== payload.day ||
    parsed.getUTCHours() !== payload.hour ||
    parsed.getUTCMinutes() !== payload.minute ||
    parsed.getUTCSeconds() !== payload.seconds ||
    parsed.getUTCMilliseconds() !== milliseconds
  ) {
    return null;
  }

  return {
    serverReceiveTime: timestamp,
    serverSendTime: timestamp,
    precision: 1,
  };
}

/** Median is resistant to a single slow or cached clock request. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The position a device should currently be playing in a shared session. */
export function expectedPosition(nowMs, startAtMs, durationSeconds = Infinity) {
  const elapsed = Math.max(0, (nowMs - startAtMs) / 1000);
  return Math.min(elapsed, Number.isFinite(durationSeconds) ? durationSeconds : elapsed);
}

export function formatDuration(totalSeconds, includeHours = false) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—:—";
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  if (includeHours || hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function toLocalDateTimeValue(timestamp) {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

const SHA256_PATTERN = /^[a-f\d]{64}$/i;

/** Return the lowercase SHA-256 fingerprint for an ArrayBuffer or typed array. */
export async function sha256Hex(data) {
  const bytes = ArrayBuffer.isView(data)
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  if (!(bytes instanceof ArrayBuffer)) throw new TypeError("Expected binary data");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parse a complete Drifter preset from a URL. Invalid or partial presets are ignored. */
export function parsePresetUrl(value) {
  try {
    const url = new URL(value, "https://drifter.invalid/");
    const start = url.searchParams.get("start");
    const sha256 = url.searchParams.get("sha256")?.toLowerCase();
    const startAt = Date.parse(start ?? "");
    if (!Number.isFinite(startAt) || !SHA256_PATTERN.test(sha256 ?? "")) return null;
    return { startAt, sha256 };
  } catch {
    return null;
  }
}

/** Build a portable preset URL with an unambiguous UTC start and file fingerprint. */
export function createPresetUrl(baseUrl, startAt, sha256) {
  if (!Number.isFinite(startAt) || !SHA256_PATTERN.test(sha256 ?? "")) {
    throw new TypeError("A valid start time and SHA-256 fingerprint are required");
  }
  const url = new URL(baseUrl);
  // Presets are intentionally minimal: do not forward tracking or unrelated
  // parameters from the page that created them.
  url.search = "";
  url.searchParams.set("start", new Date(startAt).toISOString());
  url.searchParams.set("sha256", sha256.toLowerCase());
  url.hash = "";
  return url.toString();
}
