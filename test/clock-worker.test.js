import test from "node:test";
import assert from "node:assert/strict";

import worker from "../clock-worker/src/index.js";

test("clock worker returns millisecond timestamps without caching", async () => {
  const response = await worker.fetch(
    new Request("https://clock.example/time", {
      headers: { Origin: "https://drifter.example" },
    }),
    { ALLOWED_ORIGINS: "https://drifter.example" },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://drifter.example");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(body.precision, 1);
  assert.ok(Number.isFinite(body.serverReceiveTime));
  assert.ok(Number.isFinite(body.serverSendTime));
});

test("clock worker rejects an origin outside its allowlist", async () => {
  const response = await worker.fetch(
    new Request("https://clock.example/time", {
      headers: { Origin: "https://other.example" },
    }),
    { ALLOWED_ORIGINS: "https://drifter.example" },
  );

  assert.equal(response.status, 403);
});

test("clock worker rejects other paths", async () => {
  const response = await worker.fetch(new Request("https://clock.example/"), {});
  assert.equal(response.status, 404);
});
