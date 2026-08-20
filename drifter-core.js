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
