import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirm,
  input,
  isPromptInputClosed,
  password,
  withInputClosedGuard,
} from "../../src/cli/prompts.js";

// A prompt whose input was gone used to hang until Node gave up on the
// unsettled top-level await and exited 13 (`vana login`, 2026-10-05).
describe("prompts with no input left", () => {
  let stderr = "";

  beforeEach(() => {
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const streams = () => ({
    input: new PassThrough(),
    output: new PassThrough(),
  });

  it("takes a yes/no question as no, and says so", async () => {
    const context = streams();
    const answer = confirm({ message: "Start?", default: true }, context);
    context.input.end();
    await expect(answer).resolves.toBe(false);
    expect(stderr).toContain("No input (stdin closed); taking that as no.");
  });

  it("still answers a yes/no question from input", async () => {
    const context = streams();
    const answer = confirm({ message: "Start?", default: false }, context);
    // The prompt attaches its reader a tick later.
    await new Promise((resolve) => setImmediate(resolve));
    context.input.write("y\n");
    await expect(answer).resolves.toBe(true);
  });

  it("throws a named error for a question with no safe answer", async () => {
    for (const prompt of [input, password]) {
      const context = streams();
      const answer = prompt({ message: "Name" }, context);
      context.input.end();
      const error = await answer.catch((caught: unknown) => caught);
      expect(isPromptInputClosed(error)).toBe(true);
    }
  });

  it("does not start a prompt on input that already ended", async () => {
    const context = streams();
    context.input.end();
    context.input.resume();
    await new Promise((resolve) => context.input.once("end", resolve));
    const run = vi.fn(async () => "never");
    const error = await withInputClosedGuard(run, context).catch(
      (caught: unknown) => caught,
    );
    expect(isPromptInputClosed(error)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("takes a ^D from a pty as no: readline closes and nothing is left to answer", async () => {
    // `script` with stdin at /dev/null types ^D into the prompt; at a real
    // tty readline closes on it without ending the stream, and the loop
    // runs dry. A PassThrough is no tty, so the dry loop is emitted here.
    const context = streams();
    const answer = confirm({ message: "Start?", default: true }, context);
    await new Promise((resolve) => setImmediate(resolve));
    context.input.write("\u0004");
    await new Promise((resolve) => setImmediate(resolve));
    process.emit("beforeExit", 0);
    await expect(answer).resolves.toBe(false);
  });

  it("passes other prompt errors through", async () => {
    const beforeExitListeners = process.listeners("beforeExit");
    const context = streams();
    const cancelled = Object.assign(new Error("ctrl-c"), {
      name: "ExitPromptError",
    });
    await expect(
      withInputClosedGuard(async () => {
        throw cancelled;
      }, context),
    ).rejects.toBe(cancelled);
    // And leaves no listeners behind.
    expect(context.input.listenerCount("end")).toBe(0);
    expect(context.input.listenerCount("close")).toBe(0);
    expect(process.listeners("beforeExit")).toEqual(beforeExitListeners);
  });
});
