/**
 * The CLI's prompts, guarded against input that is gone.
 *
 * Inquirer does not settle a prompt whose input goes away: readline closes
 * (end of input, or the ^D a pty sends when its own stdin is /dev/null),
 * the event loop drains, and Node exits 13 with "unsettled top-level await"
 * (`vana login`, 2026-10-05). Every prompt goes through here instead, so
 * that is an answer: a yes/no question takes "no", the non-interactive
 * path; a question with no safe answer throws PromptInputClosedError, which
 * the CLI reports cleanly.
 */

import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
} from "@inquirer/prompts";

type PromptStream = NodeJS.ReadableStream & {
  readableEnded?: boolean;
  destroyed?: boolean;
};
type PromptContext = {
  input?: PromptStream;
  output?: NodeJS.WritableStream;
  signal?: AbortSignal;
};
type ConfirmConfig = Parameters<typeof inquirerConfirm>[0];
type InputConfig = Parameters<typeof inquirerInput>[0];
type PasswordConfig = Parameters<typeof inquirerPassword>[0];

export class PromptInputClosedError extends Error {
  constructor() {
    super(
      "No input: stdin closed before the question was answered. Run it at a terminal, or with --no-input.",
    );
    this.name = "PromptInputClosedError";
  }
}

export function isPromptInputClosed(error: unknown): boolean {
  return error instanceof Error && error.name === "PromptInputClosedError";
}

/**
 * Run a prompt that aborts with PromptInputClosedError when `input` ends or
 * closes, or when the process runs out of work while it waits: then nothing
 * is left that could ever answer it. Other errors (Ctrl+C) pass through.
 */
export async function withInputClosedGuard<T>(
  run: (context: PromptContext) => Promise<T>,
  context: PromptContext = {},
): Promise<T> {
  const input: PromptStream = context.input ?? process.stdin;
  const controller = new AbortController();
  const onClosed = () => {
    if (!controller.signal.aborted) {
      controller.abort(new PromptInputClosedError());
    }
  };
  if (input.readableEnded || input.destroyed) {
    throw new PromptInputClosedError();
  }
  input.once("end", onClosed);
  input.once("close", onClosed);
  process.once("beforeExit", onClosed);
  try {
    return await run({ ...context, input, signal: controller.signal });
  } catch (error) {
    if (
      controller.signal.aborted &&
      isPromptInputClosed(controller.signal.reason)
    ) {
      throw controller.signal.reason as PromptInputClosedError;
    }
    throw error;
  } finally {
    process.removeListener("beforeExit", onClosed);
    input.removeListener("end", onClosed);
    input.removeListener("close", onClosed);
  }
}

/** A yes/no question; end of input answers "no" and says so. */
export async function confirm(
  config: ConfirmConfig,
  context?: PromptContext,
): Promise<boolean> {
  try {
    return await withInputClosedGuard(
      (guarded) => inquirerConfirm(config, guarded),
      context,
    );
  } catch (error) {
    if (isPromptInputClosed(error)) {
      process.stderr.write("\n  No input (stdin closed); taking that as no.\n");
      return false;
    }
    throw error;
  }
}

export function input(
  config: InputConfig,
  context?: PromptContext,
): Promise<string> {
  return withInputClosedGuard(
    (guarded) => inquirerInput(config, guarded),
    context,
  );
}

export function password(
  config: PasswordConfig,
  context?: PromptContext,
): Promise<string> {
  return withInputClosedGuard(
    (guarded) => inquirerPassword(config, guarded),
    context,
  );
}
