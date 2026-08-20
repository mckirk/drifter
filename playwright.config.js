import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 35_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/e2e/server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
