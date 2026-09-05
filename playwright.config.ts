import { defineConfig, devices } from "@playwright/test";

const PORT = 4777;
const reporters = [
  ...(process.env.CI ? ([["github"]] as const) : []),
  ["list"] as const,
  ["html", { open: "never" }] as const,
];

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: reporters,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    colorScheme: "light",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    env: { PUBLIC_POSTHOG_KEY: "test-posthog-project-token" },
    command: "bun run --cwd apps/landing build && bun --cwd apps/api e2e/server.ts",
    url: `http://127.0.0.1:${PORT}/api/owner/session`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
