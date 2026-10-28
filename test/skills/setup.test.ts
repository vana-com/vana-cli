import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offerSkillSetup } from "../../src/skills/setup.js";
import { readCliState } from "../../src/core/state-store.js";

const sourceSkills = fileURLToPath(new URL("../../skills/", import.meta.url));
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "vana-skills-consent-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("VANA_HOME", path.join(home, ".vana"));
  vi.stubEnv("VANA_SKILLS_DIR", sourceSkills);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  // The accepted installation must use local release files, not network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network access");
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("the public skill setup offer", () => {
  it("copies all three skills and the required Builder reference only after a yes", async () => {
    await fs.mkdir(path.join(home, ".claude"));
    const ask = vi.fn(async () => {
      await expect(fs.access(path.join(home, ".agents"))).rejects.toThrow();
      await expect(
        fs.access(path.join(home, ".vana/skills")),
      ).rejects.toThrow();
      return true;
    });
    expect(await offerSkillSetup({ interactive: true }, { confirm: ask })).toBe(
      0,
    );
    for (const base of [".agents", ".claude"]) {
      for (const id of ["connect-data", "create-connector", "builder"]) {
        expect(
          await fs.readFile(
            path.join(home, base, "skills", `vana-${id}`, "SKILL.md"),
            "utf8",
          ),
        ).toBe(
          await fs.readFile(path.join(sourceSkills, id, "SKILL.md"), "utf8"),
        );
      }
      expect(
        await fs.readFile(
          path.join(
            home,
            base,
            "skills/vana-builder/reference/verification.md",
          ),
          "utf8",
        ),
      ).toBe(
        await fs.readFile(
          path.join(sourceSkills, "builder/reference/verification.md"),
          "utf8",
        ),
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    await offerSkillSetup({ interactive: true }, { confirm: ask });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a no preserves existing agent files and is not asked again", async () => {
    const existing = path.join(home, ".agents/skills/vana-builder/SKILL.md");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, "my existing instructions");
    const ask = vi.fn(async () => false);
    await offerSkillSetup({ interactive: true }, { confirm: ask });
    expect(await fs.readFile(existing, "utf8")).toBe(
      "my existing instructions",
    );
    await expect(fs.access(path.join(home, ".vana/skills"))).rejects.toThrow();
    await offerSkillSetup({ interactive: true }, { confirm: ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    // An explicit setup command can revisit that decision.
    await offerSkillSetup({ interactive: true, force: true }, { confirm: ask });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("non-interactive setup neither asks, downloads, nor writes any state", async () => {
    const ask = vi.fn(async () => true);
    expect(
      await offerSkillSetup({ interactive: false }, { confirm: ask }),
    ).toBe(0);
    expect(await fs.readdir(home)).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("missing required files fail setup instead of downloading or reporting complete", async () => {
    const bundle = path.join(home, "incomplete-bundle");
    await fs.cp(sourceSkills, bundle, { recursive: true });
    await fs.rm(path.join(bundle, "builder/reference/verification.md"));
    vi.stubEnv("VANA_SKILLS_DIR", bundle);
    const ask = vi.fn(async () => true);
    expect(await offerSkillSetup({ interactive: true }, { confirm: ask })).toBe(
      1,
    );
    expect((await readCliState()).config?.skillsPromptCompleted).not.toBe(true);
    await expect(
      fs.access(path.join(home, ".agents/skills/vana-builder/SKILL.md")),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
