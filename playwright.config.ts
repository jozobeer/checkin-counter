import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: "**/unit/**",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command: "rm -rf .wrangler/test-state && npx wrangler dev --port 8787 --persist-to .wrangler/test-state",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
