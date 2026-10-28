// Lifecycle scripts often have no terminal, and source checkouts may not be built.
// Defer those offers to the first interactive CLI run.
import { existsSync } from "node:fs";

if (
  process.stdin.isTTY &&
  process.stdout.isTTY &&
  existsSync(new URL("../dist/skills/setup.js", import.meta.url))
) {
  const { canOfferSkillSetup, offerSkillSetup } =
    await import("../dist/skills/setup.js");
  await offerSkillSetup({ interactive: canOfferSkillSetup() });
}
