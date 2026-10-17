import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/sw",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  reporter: "list",
});
