import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "test/cli/app-test-credit.test.ts",
      "test/cli/app-request-recovery.test.ts",
      "test/cli/setup-overlap.test.ts",
    ],
    setupFiles: ["test/setup/isolate-home.ts", "test/setup/no-external-io.ts"],
  },
});
