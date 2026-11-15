import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerConnectorDesktopCommands,
  runConnectorDesktop,
} from "../../src/cli/connector-desktop.js";

afterEach(() => {
  vi.restoreAllMocks();
});
describe("connectors desktop command", () => {
  it("keeps frozen handoff syntax separate from Factory resume and accepts packaging options", async () => {
    const program = new Command().exitOverride();
    registerConnectorDesktopCommands(program.command("connectors"), () => ({}));
    const parent = program.commands[0];
    const desktop = parent.commands.find(
      (command) => command.name() === "desktop",
    )!;
    expect(desktop.helpInformation()).toContain("--from <dir>");
    expect(desktop.helpInformation()).toContain("--streams <names>");
    expect(desktop.helpInformation()).toContain("--node <path>");
    expect(parent.commands.map((command) => command.name())).toEqual([
      "desktop",
      "desktop-status",
      "desktop-resume",
    ]);
  });

  it.skipIf(process.platform !== "darwin")(
    "returns a structured sign-in action without prompting or opening Desktop",
    async () => {
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((value) => {
        output += value;
        return true;
      });
      const open = vi.fn();
      const exit = await runConnectorDesktop(
        "prepare",
        "desktop_synthetic",
        { open: true },
        { json: true, noInput: true },
        { owner: () => null, open },
      );
      expect(exit).toBe(7);
      expect(JSON.parse(output)).toMatchObject({
        code: "owner_required",
        nextAction: { argv: ["vana", "login"] },
      });
      expect(open).not.toHaveBeenCalled();
    },
  );
});
