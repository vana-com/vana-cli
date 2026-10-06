import { describe, expect, it } from "vitest";

import {
  UnknownScopeError,
  describeScopes,
  resolveScopeKey,
  scopeList,
  sliceScope,
} from "../../src/cli/data-slice.js";

// Synthetic results shaped like real connector output: scoped keys, the
// stream-named wrappers PDPP writes, ChatGPT's `{ conversations, total }`.
function chatgptResult(count: number, bodyBytes = 50) {
  return {
    platform: "chatgpt",
    exportSummary: { count, label: "conversations" },
    "chatgpt.conversations": {
      conversations: Array.from({ length: count }, (_, i) => ({
        id: `c${i}`,
        title: i % 10 === 0 ? `Rust borrow checker ${i}` : `Chat ${i}`,
        body: "x".repeat(bodyBytes),
      })),
      total: count,
    },
    "chatgpt.memories": { memories: [{ text: "likes tea" }] },
    "chatgpt.profile": { username: "alice", plan: "plus" },
  };
}

describe("scopeList", () => {
  it("reads bare arrays, stream-named wrappers and counter wrappers", () => {
    expect(scopeList("a.items", [1, 2])).toEqual([1, 2]);
    expect(scopeList("slack.messages", { messages: [1] })).toEqual([1]);
    expect(scopeList("x.convos", { list: [1, 2], total: 2 })).toEqual([1, 2]);
  });

  it("treats a profile-like object as one record", () => {
    expect(scopeList("github.profile", { login: "a", orgs: ["x"] })).toBe(null);
    expect(scopeList("x.y", "text")).toBe(null);
  });
});

describe("describeScopes", () => {
  it("lists every data scope with item counts and sizes, skipping metadata", () => {
    const scopes = describeScopes(chatgptResult(3));
    expect(scopes.map((s) => [s.scope, s.kind, s.items])).toEqual([
      ["chatgpt.conversations", "list", 3],
      ["chatgpt.memories", "list", 1],
      ["chatgpt.profile", "record", 1],
    ]);
    expect(scopes[0].bytes).toBeGreaterThan(150);
  });
});

describe("resolveScopeKey", () => {
  it("accepts the full key or an unambiguous last segment", () => {
    const data = chatgptResult(1);
    expect(resolveScopeKey(data, "chatgpt.memories")).toBe("chatgpt.memories");
    expect(resolveScopeKey(data, "Conversations")).toBe(
      "chatgpt.conversations",
    );
    expect(resolveScopeKey(data, "exportSummary")).toBe(null);
    expect(resolveScopeKey({ "a.x": [], "b.x": [] }, "x")).toBe(null);
  });
});

describe("sliceScope", () => {
  it("pages by offset and limit and says where the next page starts", () => {
    const slice = sliceScope(chatgptResult(45), {
      scope: "conversations",
      offset: 20,
      limit: 20,
    });
    expect(slice.scope).toBe("chatgpt.conversations");
    expect(slice.total).toBe(45);
    expect(slice.returned).toBe(20);
    expect((slice.items[0] as { id: string }).id).toBe("c20");
    expect(slice.nextOffset).toBe(40);
    expect(slice.note).toContain("offset 40");

    const last = sliceScope(chatgptResult(45), {
      scope: "conversations",
      offset: 40,
    });
    expect(last.returned).toBe(5);
    expect(last.nextOffset).toBe(null);
  });

  it("defaults to 20 items and caps limit at 500", () => {
    expect(
      sliceScope(chatgptResult(30), { scope: "conversations" }).returned,
    ).toBe(20);
    expect(
      sliceScope(chatgptResult(700, 1), {
        scope: "conversations",
        limit: 10_000,
      }).returned,
    ).toBe(500);
  });

  it("filters by a case-insensitive query before paging", () => {
    const slice = sliceScope(chatgptResult(100), {
      scope: "conversations",
      query: "RUST borrow",
      limit: 3,
    });
    expect(slice.matched).toBe(10);
    expect(slice.total).toBe(100);
    expect(slice.items.map((i) => (i as { id: string }).id)).toEqual([
      "c0",
      "c10",
      "c20",
    ]);
    expect(slice.nextOffset).toBe(3);
    expect(slice.note).toContain("same query");
  });

  it("stops before the byte cap and marks the page truncated", () => {
    const slice = sliceScope(chatgptResult(50, 10_000), {
      scope: "conversations",
      limit: 50,
      maxBytes: 100_000,
    });
    expect(slice.returned).toBeLessThan(10);
    expect(slice.truncated).toBe(true);
    expect(slice.nextOffset).toBe(slice.returned);
    expect(JSON.stringify(slice.items).length).toBeLessThanOrEqual(100_000);
  });

  it("returns a bounded preview of a single item over the cap", () => {
    const slice = sliceScope(chatgptResult(2, 300_000), {
      scope: "conversations",
      maxBytes: 100_000,
    });
    expect(slice.returned).toBe(1);
    expect(slice.truncated).toBe(true);
    const item = slice.items[0] as { _truncated: boolean; preview: string };
    expect(item._truncated).toBe(true);
    expect(Buffer.byteLength(item.preview)).toBeLessThanOrEqual(100_000);
    expect(slice.nextOffset).toBe(1);
  });

  it("returns a record scope whole as one item", () => {
    const slice = sliceScope(chatgptResult(1), { scope: "profile" });
    expect(slice.kind).toBe("record");
    expect(slice.items).toEqual([{ username: "alice", plan: "plus" }]);
  });

  it("names the available scopes when the scope is unknown", () => {
    expect(() =>
      sliceScope(chatgptResult(1), { scope: "repositories" }),
    ).toThrow(UnknownScopeError);
  });
});
