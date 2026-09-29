import { describe, it, expect } from "vitest";
import { resolveScopes } from "../../src/personal-server/scope-resolver.js";
import type { ConnectorMetadata } from "../../src/connectors/registry.js";

describe("resolveScopes", () => {
  it("uses dotted keys directly when present in result", () => {
    const result = {
      "github.profile": { login: "alice" },
      "github.repos": [{ name: "my-repo" }],
    };

    const mappings = resolveScopes("github", result, null);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
      { scope: "github.repos", data: { items: [{ name: "my-repo" }] } },
    ]);
  });

  it("maps flat keys using metadata scopes", () => {
    const metadata: ConnectorMetadata = {
      id: "github",
      scopes: [
        { scope: "github.profile", label: "Profile" },
        { scope: "github.repos", label: "Repositories" },
      ],
    };
    const result = {
      profile: { login: "alice" },
      repos: [{ name: "my-repo" }],
    };

    const mappings = resolveScopes("github", result, metadata);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
      { scope: "github.repos", data: { items: [{ name: "my-repo" }] } },
    ]);
  });

  it("falls back to {source}.{key} without metadata", () => {
    const result = {
      profile: { login: "alice" },
      repos: [{ name: "my-repo" }],
    };

    const mappings = resolveScopes("github", result, null);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
      { scope: "github.repos", data: { items: [{ name: "my-repo" }] } },
    ]);
  });

  it("skips metadata scopes that have no matching key in result", () => {
    const metadata: ConnectorMetadata = {
      id: "github",
      scopes: [
        { scope: "github.profile", label: "Profile" },
        { scope: "github.stars", label: "Stars" },
      ],
    };
    const result = {
      profile: { login: "alice" },
    };

    const mappings = resolveScopes("github", result, metadata);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
    ]);
  });

  it("returns empty array for empty result", () => {
    const mappings = resolveScopes("github", {}, null);
    expect(mappings).toEqual([]);
  });

  it("excludes metadata-only keys (exportSummary, timestamp, version, platform) in fallback", () => {
    const result = {
      profile: { login: "alice" },
      exportSummary: { count: 1 },
      timestamp: "2026-01-01T00:00:00Z",
      version: "1.0",
      platform: "linux",
    };

    const mappings = resolveScopes("github", result, null);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
    ]);
  });

  it("excludes metadata-only keys from dotted-key strategy", () => {
    const result = {
      "github.profile": { login: "alice" },
      exportSummary: { count: 1 },
    };

    const mappings = resolveScopes("github", result, null);

    expect(mappings).toEqual([
      { scope: "github.profile", data: { login: "alice" } },
    ]);
  });

  it("resolves a PDPP result where no stream completed to nothing", () => {
    const result = {
      platform: "slack_browser",
      company: "Slack",
      exportedAt: "2026-09-29T00:00:00Z",
      completedStreams: [],
    };

    expect(resolveScopes("slack_browser", result, null)).toEqual([]);
  });

  it("keeps only completed streams from a partial PDPP result", () => {
    const result = {
      platform: "slack_browser",
      company: "Slack",
      exportedAt: "2026-09-29T00:00:00Z",
      completedStreams: ["messages"],
      "slack_browser.messages": { messages: [{ ts: "1" }] },
    };

    expect(resolveScopes("slack_browser", result, null)).toEqual([
      {
        scope: "slack_browser.messages",
        data: { messages: [{ ts: "1" }] },
      },
    ]);
  });

  it("never maps PDPP metadata through connector metadata scopes", () => {
    const metadata = {
      scopes: [{ scope: "slack_browser.company" }],
    } as unknown as ConnectorMetadata;
    const result = {
      platform: "slack_browser",
      company: "Slack",
      completedStreams: [],
    };

    expect(resolveScopes("slack_browser", result, metadata)).toEqual([]);
  });

  it("still maps a legacy flat result's company key in fallback", () => {
    const result = { company: { name: "Acme" }, exportedAt: "2026-01-01" };

    expect(resolveScopes("linkedin", result, null)).toEqual([
      { scope: "linkedin.company", data: { name: "Acme" } },
      { scope: "linkedin.exported_at", data: { value: "2026-01-01" } },
    ]);
  });

  it("normalizes camelCase dotted scopes to canonical snake_case", () => {
    const result = {
      "youtube.playlistItems": [{ id: "pl-1" }],
      "youtube.watchLater": [{ id: "vid-1" }],
    };

    const mappings = resolveScopes("youtube", result, null);

    expect(mappings).toEqual([
      {
        scope: "youtube.playlist_items",
        data: { items: [{ id: "pl-1" }] },
      },
      {
        scope: "youtube.watch_later",
        data: { items: [{ id: "vid-1" }] },
      },
    ]);
  });
});
