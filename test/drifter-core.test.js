import test from "node:test";
import assert from "node:assert/strict";

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
} from "../drifter-core.js";

test("calculates a clock offset at the network midpoint", () => {
  assert.equal(clockOffsetFromSample(1_000, 1_200, 1_600), 500);
});

test("calculates median values", () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 30, 20, 40]), 25);
  assert.equal(median([]), 0);
});

test("calculates a four-timestamp NTP sample", () => {
  assert.deepEqual(ntpSample(1_000, 1_300, 1_305, 1_110), {
    offset: 247.5,
    roundTrip: 105,
  });
});

test("selects the lowest-delay clock sample and estimates uncertainty", () => {
  const result = selectBestClockSample([
    { offset: 42, roundTrip: 80 },
    { offset: 40, roundTrip: 20 },
    { offset: 41, roundTrip: 35 },
  ]);
  assert.equal(result.offset, 40);
  assert.equal(result.roundTrip, 20);
  assert.equal(result.uncertainty, 11);
});

test("normalizes the custom Worker clock response", () => {
  assert.deepEqual(
    timestampsFromWorkerPayload({
      serverReceiveTime: 1_000,
      serverSendTime: 1_001,
      precision: 2,
    }),
    { serverReceiveTime: 1_000, serverSendTime: 1_001, precision: 2 },
  );
  assert.equal(timestampsFromWorkerPayload({ serverReceiveTime: "nope" }), null);
});

test("normalizes TimeAPI.io's UTC calendar response", () => {
  const result = timestampsFromTimeApiPayload({
    year: 2026,
    month: 8,
    day: 20,
    hour: 17,
    minute: 42,
    seconds: 12,
    milliSeconds: 345,
    timeZone: "UTC",
  });
  const timestamp = Date.UTC(2026, 7, 20, 17, 42, 12, 345);
  assert.deepEqual(result, {
    serverReceiveTime: timestamp,
    serverSendTime: timestamp,
    precision: 1,
  });
  assert.equal(timestampsFromTimeApiPayload({ year: 2026 }), null);
  assert.equal(timestampsFromTimeApiPayload({
    year: 2026,
    month: 8,
    day: 20,
    hour: 17,
    minute: 42,
    seconds: 12,
    milliSeconds: 345,
    timeZone: "Europe/Berlin",
  }), null);
});

test("maps wall time onto track position", () => {
  assert.equal(expectedPosition(5_000, 10_000), 0);
  assert.equal(expectedPosition(12_500, 10_000), 2.5);
  assert.equal(expectedPosition(50_000, 10_000, 30), 30);
});

test("formats short and long durations", () => {
  assert.equal(formatDuration(65.9), "1:05");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(Number.NaN), "—:—");
});

test("formats a timestamp for a datetime-local control", () => {
  const timestamp = new Date(2026, 7, 20, 18, 5, 9).getTime();
  assert.equal(toLocalDateTimeValue(timestamp), "2026-08-20T18:05:09");
});

test("calculates a lowercase SHA-256 fingerprint", async () => {
  const hash = await sha256Hex(new TextEncoder().encode("Drifter"));
  assert.equal(hash, "c89cf5e4dfd1e990e4e8c2e8c4e4762993e5c63eeefae0affb0cbe9702fb03ce");
});

test("creates and parses portable preset URLs", () => {
  const startAt = Date.UTC(2026, 7, 20, 17, 42, 12);
  const sha256 = "a".repeat(64);
  const url = createPresetUrl("https://example.com/drifter/?theme=dark#setup", startAt, sha256);
  assert.equal(
    url,
    `https://example.com/drifter/?start=2026-08-20T17%3A42%3A12.000Z&sha256=${sha256}`,
  );
  assert.deepEqual(parsePresetUrl(url), { startAt, sha256 });
});

test("rejects partial and malformed presets", () => {
  assert.equal(parsePresetUrl("https://example.com/?start=2026-08-20T17:42:12Z"), null);
  assert.equal(parsePresetUrl("https://example.com/?start=nope&sha256=" + "a".repeat(64)), null);
  assert.throws(() => createPresetUrl("https://example.com/", Date.now(), "short"));
});
