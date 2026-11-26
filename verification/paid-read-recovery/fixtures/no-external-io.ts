import { beforeEach, vi } from "vitest";
beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("External network disabled for formal verification");
  });
});
