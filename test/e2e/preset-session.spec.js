import { createHash } from "node:crypto";

import { devices, expect, test } from "@playwright/test";

const TRACK_NAME = "shared-drifter-track.wav";

function mobileContextOptions(browserName) {
  if (browserName === "firefox") {
    return {
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
    };
  }
  return devices["iPhone 13"];
}

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

async function expectNoInvisibleControlOverlays(page) {
  const overlays = await page.locator("a[href], button, input, select, summary, textarea").evaluateAll(
    (controls) => controls.flatMap((control) => {
      const style = getComputedStyle(control);
      const box = control.getBoundingClientRect();
      const isLargeInvisibleOverlay = style.opacity === "0" && box.width > 8 && box.height > 8;
      return isLargeInvisibleOverlay
        ? [{ tag: control.tagName, id: control.id, width: box.width, height: box.height }]
        : [];
    }),
  );
  expect(overlays).toEqual([]);
}

async function chooseTrackThroughVisiblePicker(page, track, expectedHash) {
  const dropTarget = page.locator(".file-drop");
  const fileInput = page.locator("#audio-file");
  await expect(dropTarget).toBeVisible();
  await expect(fileInput).toHaveAccessibleName(/Choose an audio file/);

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5_000 }),
    page.getByText("Choose an audio file", { exact: true }).tap(),
  ]);
  expect(fileChooser.isMultiple()).toBe(false);
  await fileChooser.setFiles({
    name: TRACK_NAME,
    mimeType: "audio/wav",
    buffer: track,
  });
  await expect(page.locator("#file-title")).toHaveText(TRACK_NAME);
  await expect(page.locator("#file-hash")).toHaveText(expectedHash);
}

async function localInputValue(page, timestamp) {
  return page.evaluate((value) => {
    const date = new Date(value);
    const local = new Date(value - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 19);
  }, timestamp);
}

test("a desktop creates a preset and a mobile joins the same session", async ({ browser, browserName }) => {
  const track = createSilentWav();
  const expectedHash = createHash("sha256").update(track).digest("hex");
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: "Europe/Berlin",
  });
  const mobile = await browser.newContext({
    ...mobileContextOptions(browserName),
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
        await expect(desktopPage.locator("#session-preset-qr svg")).toBeVisible();
        await expect(mobilePage.locator("#session-preset-qr svg")).toBeVisible();
        await expect(desktopPage.locator("#session-preset-url")).toHaveValue(presetUrl);
        await expect(mobilePage.locator("#session-preset-url")).toHaveValue(presetUrl);
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
    await Promise.allSettled([desktop.close(), mobile.close()]);
  }
});

test("a mobile chooses a file, creates a preset, and a desktop joins", async ({ browser, browserName }) => {
  const track = createSilentWav();
  const expectedHash = createHash("sha256").update(track).digest("hex");
  const mobile = await browser.newContext({
    ...mobileContextOptions(browserName),
    timezoneId: "America/New_York",
  });
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: "Europe/Berlin",
  });

  try {
    await Promise.all([makeContextLocal(mobile), makeContextLocal(desktop)]);
    const mobilePage = await mobile.newPage();
    const desktopPage = await desktop.newPage();

    await test.step("tapping the visible mobile file control opens the native picker", async () => {
      await mobilePage.goto("/");
      await expectNoInvisibleControlOverlays(mobilePage);
      await chooseTrackThroughVisiblePicker(mobilePage, track, expectedHash);
    });

    const sharedStart = Math.ceil((Date.now() + 10_000) / 1_000) * 1_000;
    const mobileStartValue = await localInputValue(mobilePage, sharedStart);
    let presetUrl;

    await test.step("the mobile creates a link and QR code", async () => {
      await mobilePage.locator("#start-time").fill(mobileStartValue);
      await mobilePage.locator("#start-time").dispatchEvent("change");
      await mobilePage.locator("#create-preset").click();

      await expect(mobilePage.locator("#preset-qr svg")).toBeVisible();
      presetUrl = await mobilePage.locator("#preset-url").inputValue();
      const parsedPreset = new URL(presetUrl);
      expect(parsedPreset.searchParams.get("sha256")).toBe(expectedHash);
      expect(Date.parse(parsedPreset.searchParams.get("start"))).toBe(sharedStart);
    });

    await test.step("the desktop opens and verifies the mobile preset", async () => {
      await desktopPage.goto(presetUrl);
      await expect(desktopPage.locator("#preset-notice")).toBeVisible();
      await expect(desktopPage.locator("#start-time")).not.toHaveValue(mobileStartValue);
      const desktopStart = await desktopPage.locator("#start-time").evaluate(
        (input) => new Date(input.value).getTime(),
      );
      expect(desktopStart).toBe(sharedStart);

      await chooseTrack(desktopPage, track, expectedHash);
      await expect(desktopPage.locator("#hash-status")).toHaveText("✓ Matches shared preset");
    });

    await test.step("mobile and desktop join and play on the shared timeline", async () => {
      await Promise.all([
        mobilePage.locator("#go-button").click(),
        desktopPage.locator("#go-button").click(),
      ]);
      await expect(mobilePage.locator("#state-label")).toHaveText("Waiting");
      await expect(desktopPage.locator("#state-label")).toHaveText("Waiting");
      await expect(mobilePage.locator("#state-label")).toHaveText("Playing", { timeout: 15_000 });
      await expect(desktopPage.locator("#state-label")).toHaveText("Playing", { timeout: 15_000 });

      await mobilePage.waitForTimeout(500);
      const [mobilePosition, desktopPosition] = await Promise.all([
        mobilePage.locator("#audio").evaluate((audio) => audio.currentTime),
        desktopPage.locator("#audio").evaluate((audio) => audio.currentTime),
      ]);
      expect(mobilePosition).toBeGreaterThan(0);
      expect(desktopPosition).toBeGreaterThan(0);
      expect(Math.abs(mobilePosition - desktopPosition)).toBeLessThan(0.35);
    });

    await test.step("the other labelled mobile control responds to visible text taps", async () => {
      const liveSync = mobilePage.locator("#live-sync");
      const liveSyncLabel = mobilePage.getByText("Live sync", { exact: true });
      await liveSyncLabel.tap();
      await expect(liveSync).not.toBeChecked();
      await liveSyncLabel.tap();
      await expect(liveSync).toBeChecked();
    });
  } finally {
    await Promise.allSettled([mobile.close(), desktop.close()]);
  }
});

test("playback can use manual sync instead of live correction", async ({ page, context }) => {
  const track = createSilentWav();
  const expectedHash = createHash("sha256").update(track).digest("hex");
  await makeContextLocal(context);
  await page.goto("/");
  await chooseTrack(page, track, expectedHash);

  const sharedStart = Date.now() - 3_000;
  await page.locator("#start-time").fill(await localInputValue(page, sharedStart));
  await page.locator("#start-time").dispatchEvent("change");
  await page.locator("#go-button").click();
  await expect(page.locator("#state-label")).toHaveText("Playing");

  await page.locator("#live-sync").uncheck();
  await expect(page.locator("#sync-now")).toBeVisible();
  await expect(page.locator("#sync-now")).toBeEnabled();
  await expect(page.locator("#playback-sync-note")).toContainText("runs freely");

  await page.locator("#audio").evaluate((audio) => { audio.currentTime = 0; });
  await page.waitForTimeout(1_200);
  const freeRunningPosition = await page.locator("#audio").evaluate((audio) => audio.currentTime);
  const sharedPosition = (Date.now() - sharedStart) / 1_000;
  expect(sharedPosition - freeRunningPosition).toBeGreaterThan(1.5);

  const positionBeforeManualSync = await page.locator("#audio").evaluate((audio) => audio.currentTime);
  await page.locator("#sync-now").click();
  await expect.poll(
    () => page.locator("#audio").evaluate((audio) => audio.currentTime),
    { timeout: 1_000 },
  ).toBeGreaterThan(positionBeforeManualSync + 1.5);
  await expect(page.locator("#live-sync")).not.toBeChecked();
  await expect(page.locator("#playback-sync-note")).toContainText("Synced just now");
});
