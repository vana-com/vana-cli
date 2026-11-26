#!/usr/bin/env python3
"""Check a stopped server's restart boundary in a disposable source snapshot."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
REVISION = "a55d0a0006da6a743b6452796435afa6ed177dd8"
SOURCE = "src/cli/server-start.ts"
TEST = "test/personal-server/server-start.test.ts"
BLOBS = {
    SOURCE: "55fc49d9f7e9d5b543ed6761a7c2eb283d0535b2",
    TEST: "af5ff6c4d65028349bf295bb485c9408a24d3c1b",
}
TLC_HASH = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
MODEL_CASES = {
    "current": "NoLaunchAfterStop",
    "backoff": None,
    "no-backoff-fence": "BackoffStopPreventsLaunch",
    "port-fence": None,
}


def run(args, cwd=REPO):
    return subprocess.run(
        args, cwd=cwd, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=90,
    )


def output(args):
    result = run(args)
    if result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout.strip()


def run_model(out, models, java, jar, case, violation):
    result = run([
        java, "-Xmx768m", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
        "-workers", "1", "-config", f"{case}.cfg", "-metadir",
        str(out / f"{case}-states"), "ServerSupervision.tla",
    ], models)
    (out / f"{case}-tlc.log").write_text(result.stdout)
    expected = f"Invariant {violation} is violated" if violation else "Model checking completed. No error has been found"
    if result.returncode != (12 if violation else 0) or expected not in result.stdout:
        raise RuntimeError(f"{case}: wrong model verdict. See {out}")
    return {"case": case, "violation": violation}


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError("Scratch replay anchor has drifted")
    return text.replace(before, after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    for file, blob in BLOBS.items():
        if output(["git", "hash-object", str(REPO / file)]) != blob:
            raise RuntimeError(f"Source drift: {file}. Reconcile the model first.")
    java = os.environ.get("JAVA") or output(["mise", "which", "java", "--tool", "java@temurin-25"])
    jar = os.environ.get("TLA2TOOLS") or str(
        Path(output(["mise", "where", "github:tlaplus/tlaplus@1.7.4"])) / "tla2tools.jar"
    )
    if hashlib.sha256(Path(jar).read_bytes()).hexdigest() != TLC_HASH:
        raise RuntimeError("TLC jar does not match the pinned 1.7.4 checksum")
    vitest = REPO / "node_modules/vitest/vitest.mjs"
    if not vitest.is_file():
        raise RuntimeError("The installed CLI Vitest is required")
    out.mkdir()
    models = out / "models"
    shutil.copytree(HERE / "models", models)
    results = [run_model(out, models, java, jar, case, expected) for case, expected in MODEL_CASES.items()]

    with tempfile.TemporaryDirectory(prefix="vana-server-supervision-") as tmp:
        snapshot = Path(tmp)
        archive = snapshot / "source.tar"
        with archive.open("wb") as handle:
            subprocess.run(["git", "archive", REVISION], cwd=REPO, stdout=handle, check=True)
        with tarfile.open(archive) as handle:
            handle.extractall(snapshot, members=[
                member for member in handle.getmembers() if member.isfile() or member.isdir()
            ], filter="data")
        archive.unlink()
        (snapshot / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
        replay = (HERE / "fixtures/stop-replay.txt").read_text()
        test = snapshot / TEST
        anchor = '  it("backs off and gives up on a server that keeps crashing",'
        test.write_text(replace_once(test.read_text(), anchor, replay + anchor))
        source = snapshot / SOURCE
        original = source.read_text()
        guard = '''      if (waited === "stopped" || stopping) {
        io.say("Stopped.");
        io.event({ type: "server-stopped" });
        return CliExitCode.OK;
      }
'''
        port_anchor = "      if (!port) {\n"
        fixed = replace_once(original, port_anchor, guard.replace('waited === "stopped" || stopping', "stopping") + port_anchor)
        mutant = replace_once(original, guard, "")

        def check_replay(name, stage, expected_failure=False):
            result = run([
                "node", str(vitest), "run", TEST, "--reporter=verbose",
                "-t", f"does not launch a replacement after Stop during the {stage}",
            ], snapshot)
            (out / f"{name}-replay.log").write_text(result.stdout)
            expected = (
                "to not include 'server-restarted'" if expected_failure
                else "1 passed"
            )
            if result.returncode != int(expected_failure) or expected not in result.stdout:
                raise RuntimeError(f"{name}: wrong replay verdict. See {out}")
            return {"replay": name, "failure_reproduced": expected_failure}

        replays = [
            check_replay("baseline-backoff", "restart wait"),
            check_replay("baseline-port", "port probe", True),
        ]
        try:
            source.write_text(mutant)
            replays.append(check_replay("removed-backoff-fence", "restart wait", True))
            source.write_text(fixed)
            replays.append(check_replay("added-port-fence", "port probe"))
        finally:
            source.write_text(original)
        replays += [
            check_replay("restored-backoff", "restart wait"),
            check_replay("restored-port", "port probe", True),
        ]
        if output(["git", "hash-object", str(source)]) != BLOBS[SOURCE]:
            raise RuntimeError("Scratch source was not restored")
    (out / "summary.json").write_text(json.dumps({
        "source_revision": REVISION,
        "expected_outcomes_observed": True,
        "known_finding": "NoLaunchAfterStop",
        "models": results,
        "replays": replays,
    }, indent=2) + "\n")
    print(f"Expected verdicts observed. Current port-probe restart finding reproduced. {out}")


if __name__ == "__main__":
    main()
