import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.contract.test.ts"],
    testTimeout: 60_000,
  },
});
