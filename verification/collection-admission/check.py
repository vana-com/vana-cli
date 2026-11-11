#!/usr/bin/env python3
"""Check collection admission and replay the two guards against CLI source."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REVISION = "a55d0a0006da6a743b6452796435afa6ed177dd8"
SOURCE = "src/cli/collection-readiness.ts"
TEST = "test/cli/collection-readiness.test.ts"
NO_EXTERNAL_IO = "verification/setup-resume/fixtures/no-external-io.ts"
BLOBS = {
    SOURCE: "c4ad048c7c42fff2f10122ff41156c7a59367a6e",
    TEST: "d8f868bb147dacbe420873e945fbf2bf50d03050",
    "src/core/source-export.ts": "af46b8ad4f4a64d92f6962ec9e8626d952319ef8",
    "src/personal-server/index.ts": "7bc722ef96d3e97b626c192a404bb8f1d27ba8ce",
    "test/setup/isolate-home.ts": "0341171c4dcd2df5e42f226a42bc7a9551d7ae73",
    NO_EXTERNAL_IO: "ad91a47d1321bbf34acdba2b7a726291ac3a9cc7",
}
TLC_HASH = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
CONTROLS = {
    "no-foreign-guard": (
        "ForeignProbeNeedsConsent",
        "if (!allowForeignServer) {",
        "if (false) {",
        "refuses another account's server without testing its credentials",
    ),
    "no-owner-recheck": (
        "CurrentOwnerAtAdmission",
        "if (!current.authenticated || !sameExportOwner(owner, current.owner)) {",
        "if (false) {",
        "does not bind collection to an account switched during approval",
    ),
}


def capture(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def run(args, cwd, log, env=None):
    result = subprocess.run(
        args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=90,
    )
    log.write_text(result.stdout)
    return result.returncode, result.stdout


def check_models(out, java, jar):
    modeldir = out / "models"
    shutil.copytree(HERE / "models", modeldir)
    results = {}
    for case in ("current", *CONTROLS):
        log = out / f"{case}-tlc.log"
        code, output = run([
            java, "-Xmx512m", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
            "-workers", "1", "-fp", "0", "-metadir", str(out / f"{case}-states"),
            "-config", f"{case}.cfg", "CollectionAdmission.tla",
        ], modeldir, log)
        count = re.search(r"(\d+) distinct states found", output)
        violation = re.search(r"Invariant (\w+) is violated", output)
        expected = CONTROLS[case][0] if case in CONTROLS else None
        observed = violation[1] if violation else None
        if (
            code != (12 if expected else 0) or observed != expected or not count
            or (expected is None and "No error has been found" not in output)
        ):
            raise RuntimeError(f"Unexpected TLC verdict. See {log}")
        results[case] = {"states": int(count[1]), "violation": observed}
    return results


def replay(out, vitest):
    with tempfile.TemporaryDirectory(prefix="vana-collection-admission-") as tmp:
        snapshot = Path(tmp)
        archive = subprocess.check_output(
            ["git", "archive", REVISION, "--", "src", "package.json",
             TEST, "test/setup/isolate-home.ts"],
            cwd=ROOT,
        )
        with tarfile.open(fileobj=io.BytesIO(archive)) as handle:
            handle.extractall(snapshot, members=[
                member for member in handle.getmembers() if member.isfile() or member.isdir()
            ], filter="data")
        (snapshot / NO_EXTERNAL_IO).parent.mkdir(parents=True)
        shutil.copy2(ROOT / NO_EXTERNAL_IO, snapshot / NO_EXTERNAL_IO)
        (snapshot / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (snapshot / "vitest.formal.config.mts").write_text(
            "export default {test:{"
            f"include:[{json.dumps(TEST)}],"
            f"setupFiles:['test/setup/isolate-home.ts',{json.dumps(NO_EXTERNAL_IO)}]"
            "}};\n"
        )
        command = ["node", str(vitest), "run", "--config", "vitest.formal.config.mts", "--reporter=verbose"]
        env = {**os.environ, "CI": "true", "TMPDIR": tmp, "NO_COLOR": "1"}
        source = snapshot / SOURCE
        original = source.read_bytes()

        def passing(label):
            log = out / f"{label}-replay.log"
            code, output = run(command, snapshot, log, env)
            count = re.search(r"^ *Tests +([0-9]+) passed \(\1\) *$", output, re.MULTILINE)
            if code or not count:
                raise RuntimeError(f"Expected passing replays. See {log}")
            return int(count[1])

        baseline = passing("baseline")
        for name, (_, anchor, mutation, selected) in CONTROLS.items():
            if original.count(anchor.encode()) != 1:
                raise RuntimeError(f"Scratch mutation anchor drift: {name}")
            log = out / f"{name}-replay.log"
            try:
                source.write_bytes(original.replace(anchor.encode(), mutation.encode()))
                code, output = run([*command, "-t", selected], snapshot, log, env)
            finally:
                source.write_bytes(original)
            if code != 1 or f"> {selected}" not in output or "AssertionError: expected" not in output:
                raise RuntimeError(f"Expected selected assertion failure. See {log}")
        restored = passing("restored")
        if baseline != restored or source.read_bytes() != original:
            raise RuntimeError("Scratch replay was not restored")
        return {"baseline": baseline, "caught_controls": list(CONTROLS), "restored": restored}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    for owner, expected in BLOBS.items():
        if (
            capture(["git", "hash-object", str(ROOT / owner)]) != expected
            or (owner != NO_EXTERNAL_IO and capture(["git", "rev-parse", f"{REVISION}:{owner}"]) != expected)
        ):
            raise RuntimeError(f"Source drift in {owner}. Reconcile the model before advancing its pin.")
    java = os.environ.get("JAVA") or capture(["mise", "which", "java", "--tool", "java@temurin-25"])
    jar = Path(os.environ.get("TLA2TOOLS") or (
        Path(capture(["mise", "where", "github:tlaplus/tlaplus@1.7.4"])) / "tla2tools.jar"
    )).resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != TLC_HASH:
        raise RuntimeError("Use the pinned TLC 1.7.4 jar")
    vitest = ROOT / "node_modules/vitest/vitest.mjs"
    if not vitest.is_file() or not shutil.which("node"):
        raise RuntimeError("Use Node and the repository's installed Vitest")
    out = args.out.resolve()
    out.mkdir()
    summary = {
        "source_revision": REVISION,
        "source_blobs": BLOBS,
        "tool": "TLC 1.7.4",
        "models": check_models(out, java, str(jar)),
        "replays": replay(out, vitest),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Checked collection admission. Evidence in {out}")


if __name__ == "__main__":
    main()
