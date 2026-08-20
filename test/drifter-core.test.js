import test from "node:test";
import assert from "node:assert/strict";

import {
  clockOffsetFromSample,
  expectedPosition,
  formatDuration,
  median,
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
