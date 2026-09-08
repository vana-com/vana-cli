# Skills

Tracked skill files under `.agents/skills` are optional technique for repeated,
non-obvious work in this repo. They are reviewed like any other repo code.
Use one only when the request or exact task matches its description; the code,
tests, and package scripts remain the primary map.

Editor availability: `pnpm skills:sync` symlinks every skill here into
`.cursor/skills`, and `pnpm skills:sync --target=claude` does the same for
`.claude/skills`. Both targets are gitignored, so never copy skills into them
by hand.

Review workflow skills (`autoreview`, `code-review`, `bug-repro-test-first`,
`atomic-commit-slicing`) were ported from `vana-com/unity-surfaces` by way of
`vana-com/vana-sdk`, and adapted to this repo's pnpm, ESLint, Prettier, and
Vitest toolchain. Keep them in sync with the upstream intent when editing; keep
the commands in sync with `package.json`.
