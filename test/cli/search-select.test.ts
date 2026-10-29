import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSelect } from "../../src/cli/search-select.js";

afterEach(() => vi.restoreAllMocks());

function terminal() {
  const input = new PassThrough();
  let output = "";
  const waiting: Array<{ text: string; resolve: () => void }> = [];
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    input as typeof process.stdin,
  );
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    for (let i = waiting.length - 1; i >= 0; i -= 1) {
      if (output.includes(waiting[i].text)) waiting.splice(i, 1)[0].resolve();
    }
    return true;
  });
  return {
    input,
    read: () => output,
    clear: () => {
      output = "";
    },
    rendered: (text: string) =>
      output.includes(text)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ text, resolve })),
  };
}

const choices = Array.from({ length: 24 }, (_, i) => ({
  value: String(i + 1),
  name: `Source ${String(i + 1).padStart(2, "0")}`,
}));
const options = {
  message: "Choose a source",
  choices,
  allowMissingSource: true as const,
  theme: { icon: { cursor: ">" } },
};

describe("searchable source prompt", () => {
  it("shows 12 source rows and keeps missing-source access available after scrolling", async () => {
    const tty = terminal();
    const result = searchSelect(options);
    await tty.rendered("> Source 01");
    expect(tty.read()).toContain("Source 12");
    expect(tty.read()).not.toContain("Source 13");
    expect(tty.read()).toContain("Ctrl+O: Source not listed");
    for (let i = 2; i <= 15; i += 1) {
      tty.clear();
      tty.input.write("\x1b[B");
      await tty.rendered(`> Source ${String(i).padStart(2, "0")}`);
    }
    expect(tty.read()).toContain("Ctrl+O: Source not listed");
    tty.input.write("\x0f");
    expect(await result).toEqual({ missingSource: "" });
  });

  it("continues a no-results search with its query when Enter is pressed", async () => {
    const tty = terminal();
    const result = searchSelect(options);
    await tty.rendered("> Source 01");
    tty.clear();
    tty.input.write("Readwise");
    await tty.rendered("No results found");
    expect(tty.read()).toContain("Enter: source not listed");
    expect(tty.read()).toContain("Ctrl+O: Source not listed");
    tty.input.write("\r");
    expect(await result).toEqual({ missingSource: "Readwise" });
  });
});
