import { defineConfig, devices } from "@playwright/test";

const fakeMic = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"];

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,               // two-user flows share one backend
  fullyParallel: false,
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    // full flows (messages, photos, voice, calls) run on Chromium with a fake microphone
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: fakeMic } } },
    // responsive checks on phone-sized emulation (Pixel 7 = Chromium engine, iPhone 13 = WebKit engine)
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] }, testMatch: /responsive.*\.spec\.ts/ },
    { name: "mobile-safari", use: { ...devices["iPhone 13"] }, testMatch: /responsive.*\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    env: {
      VITE_SUPABASE_URL: process.env.SUPABASE_URL ?? "http://127.0.0.1:54321",
      VITE_SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "placeholder-anon-key",
    },
  },
});
