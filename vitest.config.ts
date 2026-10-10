import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(
        new URL(
          "./examples/nextjs-starter/node_modules/server-only/empty.js",
          import.meta.url,
        ),
      ),
      "@": fileURLToPath(
        new URL("./examples/nextjs-starter/src", import.meta.url),
      ),
      "vana-cli/server": fileURLToPath(
        new URL("./src/server/index.ts", import.meta.url),
      ),
      "vana-cli/core": fileURLToPath(
        new URL("./src/core/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/isolate-home.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/index.ts"],
    },
  },
});
