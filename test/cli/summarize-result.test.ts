import { describe, expect, it } from "vitest";

import { fixSingularCounts, summarizeResultData } from "../../src/cli/index.js";

// Synthetic results in the shapes current connectors write.
describe("summarizeResultData", () => {
  it("summarizes scoped GitHub keys and object exportSummary details", () => {
    const summary = summarizeResultData({
      platform: "github",
      exportSummary: {
        count: 10,
        label: "repositories",
        details: {
          repositories: 10,
          starred: 10,
          events: 300,
          contributions: 1417,
        },
      },
      "github.profile": { login: "octo" },
      "github.repositories": {
        repositories: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      },
      "github.starred": { starred: [{ full_name: "a/b" }] },
    });
    expect(summary?.lines).toEqual([
      "Profile: octo",
      "Repositories: 3",
      "Latest repos: alpha, beta",
      "Starred: 1",
      "Events: 300",
      "Contributions: 1417",
    ]);
  });

  it("counts ChatGPT conversations and memories", () => {
    const summary = summarizeResultData({
      exportSummary: { count: 2, label: "conversations" },
      "chatgpt.conversations": {
        conversations: [{ title: "a" }, { title: "b" }],
        total: 2,
      },
      "chatgpt.memories": { memories: [{ text: "x" }] },
    });
    expect(summary?.lines).toEqual(["Conversations: 2", "Memories: 1"]);
  });

  it("counts PDPP Slack and Instagram streams", () => {
    expect(
      summarizeResultData({
        platform: "slack_browser",
        company: "Slack",
        exportedAt: "2026-09-29T00:00:00Z",
        completedStreams: ["messages", "channels"],
        "slack_browser.messages": { messages: [{}, {}, {}] },
        "slack_browser.channels": { channels: [{ name: "general" }] },
      })?.lines,
    ).toEqual(["Messages: 3", "Channels: 1"]);
    expect(
      summarizeResultData({
        "instagram.profile": { username: "insta" },
        "instagram.posts": { posts: [{}, {}] },
        "instagram.following": { following: [{}] },
      })?.lines,
    ).toEqual(["Profile: insta", "Posts: 2", "Following: 1"]);
  });

  it("falls back to string details or count and label, singular when 1", () => {
    expect(
      summarizeResultData({ exportSummary: { details: "1 playlists" } })?.lines,
    ).toEqual(["1 playlist"]);
    expect(
      summarizeResultData({ exportSummary: { count: 1, label: "orders" } })
        ?.lines,
    ).toEqual(["1 order"]);
    expect(summarizeResultData({ exportSummary: {} })).toBe(null);
  });

  it("keeps flat legacy keys working", () => {
    expect(
      summarizeResultData({
        profile: { username: "tn" },
        playlists: [{ name: "Focus" }],
      })?.lines,
    ).toEqual(["Profile: tn", "Playlists: 1", "Playlist names: Focus"]);
  });
});

describe("fixSingularCounts", () => {
  it("only touches a count of exactly one", () => {
    expect(fixSingularCounts("1 activities, 11 repos, 21 stars")).toBe(
      "1 activity, 11 repos, 21 stars",
    );
    expect(fixSingularCounts("1 matches and 1.5 hours")).toBe(
      "1 match and 1.5 hours",
    );
  });
});
