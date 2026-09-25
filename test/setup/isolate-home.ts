import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file runs against its own throwaway home. Tests that forgot to
// isolate themselves wrote connector results into the real ~/.vana/results
// of whoever ran the suite (fixtures replaced a real GitHub and Oura export
// on 2026-09-25). os.homedir() follows HOME, so ~/.vana, ~/.claude and the
// rest land here; tests that set their own HOME or VANA_HOME still win.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.VANA_HOME;
