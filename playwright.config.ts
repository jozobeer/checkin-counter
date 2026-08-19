import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: "**/unit/**",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command: "npx wrangler dev --port 8787",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
