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
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "firefox-mobile",
      grep: /mobile chooses a file/,
      use: { browserName: "firefox" },
    },
  ],
  webServer: {
    command: "node test/e2e/server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
