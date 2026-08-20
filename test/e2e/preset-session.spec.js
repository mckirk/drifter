import { createHash } from "node:crypto";

import { devices, expect, test } from "@playwright/test";

const TRACK_NAME = "shared-drifter-track.wav";

function createSilentWav(durationSeconds = 30, sampleRate = 8_000) {
  const dataLength = durationSeconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function makeContextLocal(context) {
  await context.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await context.route("https://timeapi.io/**", (route) => {
    const now = new Date();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        day: now.getUTCDate(),
        hour: now.getUTCHours(),
        minute: now.getUTCMinutes(),
        seconds: now.getUTCSeconds(),
        milliSeconds: now.getUTCMilliseconds(),
        timeZone: "UTC",
      }),
    });
  });
}

async function chooseTrack(page, track, expectedHash) {
  await page.locator("#audio-file").setInputFiles({
    name: TRACK_NAME,
    mimeType: "audio/wav",
    buffer: track,
  });
  await expect(page.locator("#file-hash")).toHaveText(expectedHash);
}

async function localInputValue(page, timestamp) {
  return page.evaluate((value) => {
    const date = new Date(value);
    const local = new Date(value - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 19);
  }, timestamp);
}

test("a desktop creates a preset and a mobile joins the same session", async ({ browser }) => {
  const track = createSilentWav();
  const expectedHash = createHash("sha256").update(track).digest("hex");
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: "Europe/Berlin",
  });
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    timezoneId: "America/New_York",
  });

  try {
    await Promise.all([makeContextLocal(desktop), makeContextLocal(mobile)]);
    const desktopPage = await desktop.newPage();
    const mobilePage = await mobile.newPage();

    await test.step("the desktop creates a link and QR code", async () => {
      await desktopPage.goto("/");
      await chooseTrack(desktopPage, track, expectedHash);

      const sharedStart = Math.ceil((Date.now() + 10_000) / 1_000) * 1_000;
      const desktopStartValue = await localInputValue(desktopPage, sharedStart);
      await desktopPage.locator("#start-time").fill(desktopStartValue);
      await desktopPage.locator("#start-time").dispatchEvent("change");
      await desktopPage.locator("#create-preset").click();

      await expect(desktopPage.locator("#preset-qr svg")).toBeVisible();
      const presetUrl = await desktopPage.locator("#preset-url").inputValue();
      const parsedPreset = new URL(presetUrl);
      expect(parsedPreset.searchParams.get("sha256")).toBe(expectedHash);
      expect(Date.parse(parsedPreset.searchParams.get("start"))).toBe(sharedStart);

      await test.step("the mobile opens and verifies the preset in its own time zone", async () => {
        await mobilePage.goto(presetUrl);
        await expect(mobilePage.locator("#preset-notice")).toBeVisible();
        await expect(mobilePage.locator("#start-time")).not.toHaveValue(desktopStartValue);
        const mobileStart = await mobilePage.locator("#start-time").evaluate(
          (input) => new Date(input.value).getTime(),
        );
        expect(mobileStart).toBe(sharedStart);

        await chooseTrack(mobilePage, track, expectedHash);
        await expect(mobilePage.locator("#hash-status")).toHaveText("✓ Matches shared preset");
      });

      await test.step("both devices join and play on the shared timeline", async () => {
        await Promise.all([
          desktopPage.locator("#go-button").click(),
          mobilePage.locator("#go-button").click(),
        ]);
        await expect(desktopPage.locator("#state-label")).toHaveText("Waiting");
        await expect(mobilePage.locator("#state-label")).toHaveText("Waiting");
        await expect(desktopPage.locator("#state-label")).toHaveText("Playing", { timeout: 15_000 });
        await expect(mobilePage.locator("#state-label")).toHaveText("Playing", { timeout: 15_000 });

        await desktopPage.waitForTimeout(500);
        const [desktopPosition, mobilePosition] = await Promise.all([
          desktopPage.locator("#audio").evaluate((audio) => audio.currentTime),
          mobilePage.locator("#audio").evaluate((audio) => audio.currentTime),
        ]);
        expect(desktopPosition).toBeGreaterThan(0);
        expect(mobilePosition).toBeGreaterThan(0);
        expect(Math.abs(desktopPosition - mobilePosition)).toBeLessThan(0.35);
      });
    });
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
  }
});
