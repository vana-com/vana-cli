/**
 * Finding a source from what a person typed. Commands take ids
 * (`claude-code-local`), while people type what `vana sources` shows them
 * (`Claude Code`, `claude-code`).
 */

/** The fields a lookup needs from a catalog entry. */
export interface LookupSource {
  id: string;
  name: string;
}

export interface SourceLookup<T extends LookupSource> {
  /** The one source the input names, when it names exactly one. */
  match: T | null;
  /** The closest id, offered as "Did you mean" when nothing matched. */
  suggestion: T | null;
}

/** Lowercase, with spaces, dashes, dots and underscores gone. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * Resolves `input` to a source: an exact id first, then an id or display
 * name with case, spaces and dashes ignored, then the single id that starts
 * with the input (`claude-code` for `claude-code-local`). Anything looser is
 * only a suggestion, never a match, so a typo cannot run the wrong source.
 */
export function lookupSource<T extends LookupSource>(
  input: string,
  sources: readonly T[],
): SourceLookup<T> {
  const exact = sources.find((source) => source.id === input);
  if (exact) return { match: exact, suggestion: null };

  const wanted = squash(input);
  if (!wanted) return { match: null, suggestion: null };

  const unique = (candidates: T[]): T | null =>
    candidates.length === 1 ? candidates[0] : null;

  const byForm = sources.filter(
    (source) => squash(source.id) === wanted || squash(source.name) === wanted,
  );
  const formMatch = unique(byForm);
  if (formMatch) return { match: formMatch, suggestion: null };

  const lowered = input.toLowerCase();
  const byPrefix = sources.filter((source) =>
    source.id.toLowerCase().startsWith(`${lowered}-`),
  );
  const prefixMatch = unique(byPrefix);
  if (prefixMatch) return { match: prefixMatch, suggestion: null };

  // Ambiguous forms or prefixes: offer the first, never pick one.
  if (byForm.length > 1 || byPrefix.length > 1) {
    return { match: null, suggestion: byForm[0] ?? byPrefix[0] };
  }

  let best: { source: T; distance: number } | null = null;
  for (const source of sources) {
    const distance = Math.min(
      editDistance(wanted, squash(source.id)),
      editDistance(wanted, squash(source.name)),
    );
    if (!best || distance < best.distance) best = { source, distance };
  }
  // Close enough to be the same word mistyped, not a different source.
  const limit = Math.max(2, Math.floor(wanted.length / 3));
  return {
    match: null,
    suggestion: best && best.distance <= limit ? best.source : null,
  };
}

/** `Unknown source: x. Did you mean y?` plus where the list is. */
export function formatUnknownSourceMessage(
  input: string,
  suggestion: LookupSource | null,
): string {
  const hint = suggestion ? ` Did you mean ${suggestion.id}?` : "";
  return `Unknown source: ${input}.${hint} Run \`vana sources\` to see available options.`;
}
