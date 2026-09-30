import { describe, expect, it } from "vitest";
import { renderField } from "../../src/cli/app/outcome.js";

describe("human-mode data rendering", () => {
  it("prints primitives as they are", () => {
    expect(renderField("txHash", "0xabc", "  ")).toBe("  txHash: 0xabc\n");
    expect(renderField("gasless", true, "  ")).toBe("  gasless: true\n");
  });

  it("never prints [object Object]", () => {
    const out = [
      renderField("deposits", { submitted: 0, finalized: 1, failed: 0 }, "  "),
      renderField("rows", [{ a: 1 }, { b: { c: 2 } }], "  "),
      renderField("nested", { inner: { deeper: [1, 2] } }, "  "),
    ].join("");
    expect(out).not.toContain("[object Object]");
  });

  it("puts a flat record on one line", () => {
    expect(
      renderField("deposits", { submitted: 0, finalized: 1, failed: 0 }, "  "),
    ).toBe("  deposits: submitted 0, finalized 1, failed 0\n");
  });

  it("joins a list of values and says none for an empty one", () => {
    expect(renderField("balances", ["0.2 USDC.e available"], "  ")).toBe(
      "  balances: 0.2 USDC.e available\n",
    );
    expect(renderField("balances", [], "  ")).toBe("  balances: none\n");
  });

  it("lists records one per line, and nests deeper values", () => {
    expect(renderField("rows", [{ a: 1, b: "x" }, { a: 2 }], "  ")).toBe(
      "  rows:\n    - a 1, b x\n    - a 2\n",
    );
    expect(renderField("rows", [{ a: { b: 1 } }], "  ")).toBe(
      "  rows:\n    -\n      a: b 1\n",
    );
    expect(renderField("nested", { inner: { deeper: [1, 2] } }, "  ")).toBe(
      "  nested:\n    inner:\n      deeper: 1, 2\n",
    );
  });
});
