# Worklog

## 2026-10-29 — CLI-first agent bootstrap and human welcome

Accepted outcome: an ordinary request such as “Use Vana to collect my highlights from Readwise” can continue after CLI installation by reading bundled instructions through the CLI. Persistent installation into an agent harness is optional, explicitly confirmed, and is not needed by the running agent. Keep public skills self-contained and retain the single CLI PR #106.

Implement at the existing skills owner: `skills show` returns full instructions and required reference content without skill-cache or agent-configuration writes. Keep existing metadata and installed status in JSON. Make this bootstrap discoverable in public docs and CLI help. Remove harness-specific reload advice. Preserve the standalone distribution without adding skills.sh or a separate Node requirement.

For humans, bare interactive `vana` shows the approved welcome choices: connect my data, build an app using Vana data, finish setup. Direct commands and automated modes must remain prompt-free apart from their own requested actions. Reuse the current login/collection owners; do not change providers, accounts, networks or payment behavior.

Boundary: test-credit commits already on #106 are preserved. Another chat owns browser/transcript isolation repairs in the primary checkout. Do not run the old transcript capture here: it can reach a browser under a replaced HOME. Verify this change with controlled skill reads and real terminal UI captures, with browser and network access blocked; live authenticated collection is outside this task.

Finish: focused proof, normal safe repository checks, structured review, scoped commit/push to #106 and update the existing Linear project handoff. No merge or release is authorized.

Implemented: full CLI workflow reads, generic install success, optional persistent setup, and a finite welcome menu. The builder choice hands off to safe app-identity inspection before registration; the connect choice reuses login and source collection. Skill content remains the shared owner for CLI reads and persistent installs. Runtime/packaging evidence and review results belong in PR #106; the existing Linear project update carries the team handoff. The authenticated Readwise journey is not established by these bootstrap checks.
