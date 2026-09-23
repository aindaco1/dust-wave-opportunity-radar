import { defineConfig } from "vitest/config";

// An explicit live suite, outside the offline test/**/*.test.ts glob.
export default defineConfig({ test: {
  environment: "node", include: ["test/jev.live.ts"], testTimeout: 600_000,
  fileParallelism: false, retry: 0, disableConsoleIntercept: true
} });
