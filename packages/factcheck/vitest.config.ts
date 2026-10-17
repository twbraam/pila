import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.contract.test.ts", "node_modules"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
