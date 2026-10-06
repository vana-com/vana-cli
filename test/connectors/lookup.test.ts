import {
  formatUnknownSourceMessage,
  lookupSource,
} from "../../src/connectors/lookup.js";

const catalog = [
  { id: "claude-code-local", name: "Claude Code" },
  { id: "claude-export", name: "Claude" },
  { id: "github", name: "GitHub" },
  { id: "instagram", name: "Instagram" },
  { id: "instagram-ads", name: "Instagram Ads" },
];

describe("lookupSource", () => {
  it("takes an exact id first", () => {
    expect(lookupSource("github", catalog).match?.id).toBe("github");
  });

  it("matches ids and names with case, spaces and dashes ignored", () => {
    expect(lookupSource("GitHub", catalog).match?.id).toBe("github");
    expect(lookupSource("Claude Code", catalog).match?.id).toBe(
      "claude-code-local",
    );
    expect(lookupSource("claude-code", catalog).match?.id).toBe(
      "claude-code-local",
    );
    expect(lookupSource("claude", catalog).match?.id).toBe("claude-export");
  });

  it("matches the one id that extends the input", () => {
    expect(lookupSource("claude-code", catalog).match?.id).toBe(
      "claude-code-local",
    );
  });

  it("never picks between two candidates", () => {
    const result = lookupSource("insta", catalog);
    expect(result.match).toBeNull();
  });

  it("only suggests a near miss, never runs it", () => {
    expect(lookupSource("githb", catalog)).toEqual({
      match: null,
      suggestion: { id: "github", name: "GitHub" },
    });
    expect(lookupSource("claude-cod-local", catalog).suggestion?.id).toBe(
      "claude-code-local",
    );
  });

  it("suggests nothing for an unrelated word", () => {
    expect(lookupSource("nonexistent", catalog)).toEqual({
      match: null,
      suggestion: null,
    });
  });
});

describe("formatUnknownSourceMessage", () => {
  it("adds the suggestion when there is one", () => {
    expect(formatUnknownSourceMessage("githb", catalog[2])).toBe(
      "Unknown source: githb. Did you mean github? Run `vana sources` to see available options.",
    );
    expect(formatUnknownSourceMessage("x", null)).toBe(
      "Unknown source: x. Run `vana sources` to see available options.",
    );
  });
});
