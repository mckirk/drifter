/** Return the clock offset represented by one request/response sample. */
export function clockOffsetFromSample(clientStart, clientEnd, serverTime) {
  return serverTime - (clientStart + clientEnd) / 2;
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
