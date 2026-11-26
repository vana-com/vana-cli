#!/usr/bin/env python3
"""Check the mainnet registration model and its offline CLI replays."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SOURCE_REVISION = "a55d0a0006da6a743b6452796435afa6ed177dd8"
SOURCE = "src/cli/app/mainnet-registration.ts"
TEST = "test/cli/app-mainnet-registration.test.ts"
NO_EXTERNAL_IO = "verification/setup-resume/fixtures/no-external-io.ts"
OWNERS = {
    SOURCE: "91ddcd4e45b7a2db29ec56f37a6d1af7e2ffa84f",
    "src/cli/app/register.ts": "3913660436ac5bf8d2ee7a81ff3072626b7942be",
    "src/core/app-registration-store.ts": "be4bf315897c7fc177b81479fe36428463c496c6",
    "src/core/app-profile.ts": "28e749ce192b697d37c166b67b3e42c9839979e1",
    "src/core/network.ts": "5d7ed00b5e234edb98f278243522b59dd8d433c5",
    "src/core/app-key.ts": "380b625fad6e98eb8f0c18bbd56a5e8ed83492e7",
    TEST: "9595034418fd6e002e8dca74ae60e0ef201fcd24",
    "test/setup/isolate-home.ts": "0341171c4dcd2df5e42f226a42bc7a9551d7ae73",
    NO_EXTERNAL_IO: "ad91a47d1321bbf34acdba2b7a726291ac3a9cc7",
}
JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
CONTROLS = {
    "no-save-context": (
        "ContextSavedBeforeRegistration",
        "store.saveRegistration(context);",
        "void store;",
        "retains the operation when confirmation stays pending",
        "expected null not to be null",
    ),
    "no-proof-wait": (
        "MatchingProofBeforeAssociation",
        "await waitForMainnetConfirmation(network, key, appUrl, request);",
        "void waitForMainnetConfirmation;",
        "waits for the gateway's pending proof",
        "expected 6 to be +0",
    ),
    "no-proof-identity": (
        "MatchingProofBeforeAssociation",
        "if (!matchesRegistration(body.data, key, appUrl)) {",
        "if (false) {",
        "does not associate a changed-owner confirmation",
        "expected +0 to be 2",
    ),
    "repeat-visible-registration": (
        "NoPostForVisibleRegistration",
        "if (!builder) {",
        "if (!builder || saved) {",
        "recovers a lost gateway response",
        "expected 6 to be +0",
    ),
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def run(argv, cwd, log, env=None):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=90)
    output = result.stdout + result.stderr
    log.write_text(output)
    return result.returncode, output


def check_models(out, java, jar):
    modeldir = out / "models"
    shutil.copytree(HERE / "models", modeldir)
    reports = {}
    for case in ("current", *CONTROLS):
        log = out / f"{case}-tlc.log"
        code, text = run(
            [java, "-XX:+UseParallelGC", "-Xmx768m", "-cp", jar, "tlc2.TLC",
             "-workers", "1", "-fp", "0", "-metadir", str(out / f"tlc-{case}"),
             "-config", f"{case}.cfg", "MainnetRegistration.tla"],
            modeldir, log,
        )
        state_count = re.search(r"(\d+) distinct states found", text)
        violated = re.search(r"Invariant (\w+) is violated", text)
        actual = violated[1] if violated else None
        expected = CONTROLS[case][0] if case in CONTROLS else None
        expected_code = 12 if expected else 0
        if (
            code != expected_code
            or actual != expected
            or not state_count
            or (expected is None and "No error has been found" not in text)
        ):
            raise RuntimeError(f"Unexpected model outcome for {case}. See {log}")
        reports[case] = {"states": int(state_count[1]), "violation": actual}
    return reports


def replay(revision, out):
    node = shutil.which("node")
    vitest = REPO / "node_modules/vitest/vitest.mjs"
    if not node or not vitest.is_file():
        raise RuntimeError("Use Node and the repository's installed Vitest")
    with tempfile.TemporaryDirectory(prefix="vana-mainnet-registration-") as tmp:
        snapshot = Path(tmp)
        archive = subprocess.check_output(
            ["git", "archive", revision, "--", "src", "package.json",
             TEST, "test/setup/isolate-home.ts"],
            cwd=REPO,
        )
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(
                snapshot,
                members=[m for m in tar.getmembers() if not (m.issym() or m.islnk())],
                filter="data",
            )
        (snapshot / NO_EXTERNAL_IO).parent.mkdir(parents=True)
        shutil.copy2(REPO / NO_EXTERNAL_IO, snapshot / NO_EXTERNAL_IO)
        (snapshot / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
        (snapshot / "vitest.formal.config.mts").write_text(
            "export default {test:{"
            f"include:[{json.dumps(TEST)}],"
            f"setupFiles:['test/setup/isolate-home.ts',{json.dumps(NO_EXTERNAL_IO)}]"
            "}};\n"
        )
        command = [node, str(vitest), "run", "--config", "vitest.formal.config.mts", "--reporter=verbose"]
        env = {**os.environ, "CI": "true", "TMPDIR": tmp, "NO_COLOR": "1"}
        reports = {}
        source = snapshot / SOURCE
        original = source.read_bytes()

        def require_passing(name):
            log = out / f"{name}-tests.log"
            code, text = run(command, snapshot, log, env)
            count = re.search(r"^ *Tests +([0-9]+) passed \(\1\) *$", text, re.MULTILINE)
            if code != 0 or not count:
                raise RuntimeError(f"Expected passing tests. See {log}")
            return int(count[1])

        reports["baseline"] = require_passing("baseline")
        for name, (_, old, new, selection, assertion) in CONTROLS.items():
            contents = original.decode()
            if contents.count(old) != 1:
                raise RuntimeError(f"Mutation anchor drift for {name}")
            log = out / f"{name}-mutation.log"
            try:
                source.write_text(contents.replace(old, new))
                code, text = run([*command, "-t", selection], snapshot, log, env)
            finally:
                source.write_bytes(original)
            if code != 1 or f"AssertionError: {assertion}" not in text or selection not in text:
                raise RuntimeError(f"Expected a selected behavioral failure. See {log}")
            reports[name] = "selected test rejected the source mutation"
        reports["restored"] = require_passing("restored")
        if reports["restored"] != reports["baseline"] or source.read_bytes() != original:
            raise RuntimeError("Scratch replay was not restored")
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Check the named revision if its source blobs match")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    revision = git("rev-parse", args.ref or SOURCE_REVISION)
    for owner, expected in OWNERS.items():
        path = REPO / owner
        if owner == NO_EXTERNAL_IO:
            if git("hash-object", str(path)) != expected:
                raise RuntimeError(f"Replay fixture drift in {owner}")
            continue
        actual = git("rev-parse", f"{revision}:{owner}") if args.ref else git("hash-object", str(path))
        if actual != expected:
            raise RuntimeError(f"Model/source drift in {owner}. Reconcile the model before advancing its source record.")
        if git("rev-parse", f"{revision}:{owner}") != expected:
            raise RuntimeError(f"Replay revision does not contain the pinned {owner}")

    jar = os.environ.get("TLA2TOOLS")
    if not jar:
        tools = subprocess.check_output(["mise", "where", "github:tlaplus/tlaplus@1.7.4"], cwd=REPO, text=True).strip()
        jar = str(Path(tools) / "tla2tools.jar")
    jar = str(Path(jar).resolve())
    if hashlib.sha256(Path(jar).read_bytes()).hexdigest() != JAR_SHA256:
        raise RuntimeError("Use the pinned TLC 1.7.4 jar")
    java = os.environ.get("JAVA") or subprocess.check_output(
        ["mise", "which", "java", "--tool", "java@temurin-25"], cwd=REPO, text=True
    ).strip()
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="vana-mainnet-proof-"))
    if args.out:
        out.mkdir(parents=True, exist_ok=False)
    models = check_models(out, java, jar)
    replays = replay(revision, out)
    summary = {
        "revision": revision, "source_blobs": OWNERS, "tool": "TLC 1.7.4",
        "models": models, "replays": replays, "scratch_source_restored": True,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Checked mainnet registration. Evidence in {out}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Verification error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
