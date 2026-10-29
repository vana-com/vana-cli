import search from "@inquirer/search";
import Fuse from "fuse.js";
import type { Key } from "node:readline";
import { withInputClosedGuard } from "./prompts.js";

interface SearchSelectChoice<T> {
  value: T;
  name: string;
  description?: string;
}

interface SearchSelectOptions<T> {
  message: string;
  choices: SearchSelectChoice<T>[];
  theme?: Record<string, unknown>;
  allowMissingSource?: boolean;
}

export interface MissingSourceSelection {
  missingSource: string;
}

/**
 * Fuzzy search select prompt. Type to filter, arrow keys to navigate.
 * Uses fuse.js for fuzzy matching over the choice name and description.
 */
export function searchSelect<T>(
  options: SearchSelectOptions<T> & { allowMissingSource: true },
): Promise<T | MissingSourceSelection>;
export function searchSelect<T>(
  options: SearchSelectOptions<T> & { allowMissingSource?: false },
): Promise<T>;
export async function searchSelect<T>(
  options: SearchSelectOptions<T>,
): Promise<T | MissingSourceSelection> {
  const { message, choices, theme } = options;

  const fuse = new Fuse(choices, {
    keys: [
      { name: "name", weight: 2 },
      { name: "description", weight: 1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  });

  return withInputClosedGuard(async (context) => {
    const shortcut = new AbortController();
    const stream: NodeJS.ReadableStream = context.input ?? process.stdin;
    let query = "";
    let hasMatches = choices.length > 0;
    let missing: MissingSourceSelection | undefined;
    const onKey = (_text: string, key: Key) => {
      if (!options.allowMissingSource) return;
      if (
        (key.ctrl && key.name === "o") ||
        (key.name === "return" && !hasMatches)
      ) {
        missing = { missingSource: query };
        shortcut.abort();
      }
    };
    stream.on("keypress", onKey);
    const promptTheme = theme as Parameters<typeof search>[0]["theme"];
    try {
      return await search(
        {
          message,
          pageSize: 12,
          source: async (input: string | undefined) => {
            query = input?.trim() ?? "";
            const results = query
              ? fuse.search(query).map((r) => r.item)
              : choices;
            hasMatches = results.length > 0;
            return results;
          },
          theme: options.allowMissingSource
            ? {
                ...promptTheme,
                style: {
                  ...promptTheme?.style,
                  keysHelpTip: () =>
                    `--------------------------------------------------\nType to search | Up/Down: browse | Enter: ${hasMatches ? "choose" : "source not listed"}\nCtrl+O: Source not listed | Ctrl+C: exit`,
                },
              }
            : promptTheme,
        },
        {
          ...context,
          signal: AbortSignal.any([context.signal!, shortcut.signal]),
        },
      );
    } catch (error) {
      if (missing) return missing;
      throw error;
    } finally {
      stream.removeListener("keypress", onKey);
    }
  });
}
