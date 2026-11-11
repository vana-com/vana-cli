import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    include: [
      "test/cli/paid-read-process.test.ts",
      "test/cli/app-read-loop.test.ts",
      "test/core/receipts-lock.test.ts",
    ],
    setupFiles: ["test/setup/isolate-home.ts", "test/setup/no-external-io.ts"],
  },
});
