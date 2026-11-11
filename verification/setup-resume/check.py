#!/usr/bin/env python3
"""Verify the pinned setup-resume code in a disposable offline snapshot."""

import argparse
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

SOURCE_REVISION = "a55d0a0006da6a743b6452796435afa6ed177dd8"
OWNERS = {'src/cli/app/request.ts': 'adb502d804e1d0b77df9dfcaeba7c2ed797fcff9', 'src/cli/app/test-credit.ts': 'e347931d67126e125de682d14c06cfc2d659495d', 'src/core/test-credit.ts': 'fe8e30a1b1479efb1d69f0c96ed6f8eb45fe02a2', 'src/core/requests-store.ts': 'a963a68a387d68ee30a7fdb9e279534ffb8ed37d', 'src/cli/app/requests.ts': '2d24676082e008ee9a54b4e0dc2f98f3c8ba6055'}
JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def command(argv, cwd, env=None, timeout=90):
    return subprocess.run(
        argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout
    )


def checked(argv, cwd):
    result = command(argv, cwd)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Check a committed revision instead of the working-tree patch")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    revision = checked(["git", "rev-parse", args.ref or SOURCE_REVISION], REPO)
    for owner, expected in OWNERS.items():
        actual = checked(["git", "rev-parse", f"{revision}:{owner}"], REPO) if args.ref else checked(["git", "hash-object", str(REPO / owner)], REPO)
        if actual != expected:
            raise RuntimeError(
                f"Model/source drift: {owner} differs from its checked blob. "
                "Review the model mapping before updating OWNERS."
            )
    jar = os.environ.get("TLA2TOOLS")
    if not jar:
        jar = str(
            Path(checked(["mise", "where", "github:tlaplus/tlaplus@1.7.4"], REPO))
            / "tla2tools.jar"
        )
    if hashlib.sha256(Path(jar).read_bytes()).hexdigest() != JAR_SHA256:
        raise RuntimeError("TLC jar differs from the pinned v1.7.4 SHA256")
    java = os.environ.get("JAVA") or checked(
        ["mise", "which", "java", "--tool", "java@temurin-25"], REPO
    )
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="setup-resume-check-"))
    if args.out:
        out.mkdir(parents=True, exist_ok=False)
    snapshot = out / "snapshot"
    snapshot.mkdir()
    archive = subprocess.check_output(["git", "archive", revision], cwd=REPO)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        # The archive has an unrelated absolute fixture symlink; never follow it.
        tar.extractall(
            snapshot,
            members=[m for m in tar.getmembers() if not (m.issym() or m.islnk())],
            filter="data",
        )
    if not args.ref:
        for owner in OWNERS:
            shutil.copy2(REPO / owner, snapshot / owner)
    for owner_test in ["test/cli/app-test-credit.test.ts", "test/cli/app-request-recovery.test.ts"]:
        shutil.copy2(REPO / owner_test, snapshot / owner_test)
    (snapshot / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
    for source in (HERE / "fixtures").iterdir():
        if source.name == "vitest.formal.config.ts":
            target = snapshot / source.name
        elif source.name == "no-external-io.ts":
            target = snapshot / "test/setup" / source.name
        else:
            target = snapshot / "test/cli" / source.name
        shutil.copy2(source, target)
    modeldir = out / "models"
    shutil.copytree(HERE / "models", modeldir)
    node = shutil.which("node")
    testcmd = [node, str(snapshot / "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.formal.config.ts", "--reporter=verbose"]
    summary = {"revision": revision, "owners": OWNERS, "source_mode": "commit" if args.ref else "verified working-tree files", "live_funding": False, "live_reads": False, "models": {}}
    summary["model_files_sha256"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(modeldir.iterdir()) if p.is_file()}
    passing = ["overview", "single", "concurrent", "concurrent-crash", "claim", "existing-credit", "changed-context"]
    negative = ["no-persist", "new-funding-key", "new-consent-key", "post-known-operation", "no-readiness", "no-context", "regress-funding"]
    for case in passing + negative:
        state_dir = out / f"tlc-{case}"
        state_dir.mkdir()
        result = command([
            java, "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
            "-workers", "1", "-fp", "0", "-metadir", str(state_dir),
            "-config", str(modeldir / f"{case}.cfg"), str(modeldir / "SetupResume.tla"),
        ], modeldir)
        (out / f"{case}-tlc.log").write_text(result.stdout + result.stderr)
        expected = 0 if case in passing else 12
        if result.returncode != expected:
            raise RuntimeError(f"{case}: expected TLC exit {expected}, got {result.returncode}; see {out}")
        count = re.search(r"(\d+) distinct states found", result.stdout)
        violation = re.search(r"Invariant (\w+) is violated", result.stdout)
        expected_rule = dict(zip(negative, ["DurableBeforePost", "OneFundingOperation", "OneConsentRequest", "KnownFundingIsGetOnly", "ConsentNeedsReadyCredit", "ChangedResumeRejected", "TerminalFundingRetained"]))
        if case in negative and (not violation or violation[1] != expected_rule[case]):
            raise RuntimeError(f"{case}: did not break its intended invariant")
        summary["models"][case] = {"exit": result.returncode, "states": int(count[1]) if count else None, "violation": violation[1] if violation else None}
    baseline = command(testcmd, snapshot)
    (out / "baseline-tests.log").write_text(baseline.stdout + baseline.stderr)
    if baseline.returncode:
        raise RuntimeError(f"Real-code replay failed; inspect {out / 'baseline-tests.log'}")
    originals = {owner: (snapshot / owner).read_bytes() for owner in OWNERS}
    def changed(owner, old, new):
        source = originals[owner].decode()
        if source.count(old) != 1:
            raise RuntimeError(f"Mutation anchor drift: {owner}: {old}")
        return source.replace(old, new)
    mutations = [
        ("no-persist", "src/cli/app/request.ts", "requests.saveIntent(intent);", "void intent;", "setup-overlap", "does not transmit after a pre-POST journal write failure"),
        ("new-funding-key", "src/core/test-credit.ts", "idempotencyKey: input.idempotencyKey", "idempotencyKey: randomUUID()", "app-test-credit", "resumes the same funding after"),
        ("new-consent-key", "src/cli/app/request.ts", "controller.createAccessRequest(intent.input)", "controller.createAccessRequest({ ...intent.input, idempotencyKey: randomUUID() })", "app-request-recovery", "persists the exact consent intent before POST"),
        ("post-known-operation", "src/cli/app/test-credit.ts", "operationId: intent.fundingProgress?.operationId,", "operationId: undefined,", "app-test-credit", "resumes the same funding after"),
        ("no-readiness", "src/cli/app/request.ts", "if (fundingOutcome) return emitAppOutcome(options, fundingOutcome);", "void fundingOutcome;", "app-test-credit", "holds consent until finalization"),
        ("no-context", "src/cli/app/request.ts", "      payloadConflict\n", "      false\n", "app-request-recovery", "refuses changed resume inputs"),
        ("regress-funding", "src/core/requests-store.ts", 'intent.fundingProgress.status !== "pending"', "false", "setup-overlap", "retains terminal funding"),
    ]
    summary["mutations"] = {}
    try:
        for name, owner, old, new, file, selected in mutations:
            source = snapshot / owner
            source.write_text(changed(owner, old, new))
            result = command(testcmd + [f"test/cli/{file}.test.ts", "-t", selected], snapshot)
            (out / f"mutation-{name}.log").write_text(result.stdout + result.stderr)
            source.write_bytes(originals[owner])
            if result.returncode != 1 or "AssertionError" not in result.stdout + result.stderr:
                raise RuntimeError(f"{name}: expected a behavioral assertion failure; inspect {out}")
            summary["mutations"][name] = "caught by real-code assertion"
    finally:
        for owner, original in originals.items():
            (snapshot / owner).write_bytes(original)
    restored = command(testcmd, snapshot)
    (out / "restored-tests.log").write_text(restored.stdout + restored.stderr)
    if restored.returncode:
        raise RuntimeError(f"Restored baseline failed; inspect {out}")
    for owner, blob in OWNERS.items():
        if checked(["git", "hash-object", str(snapshot / owner)], REPO) != blob:
            raise RuntimeError(f"Scratch source was not restored: {owner}")
    summary["product_snapshot_restored"] = True
    summary["status"] = "passed: setup/resume safety under the documented bounds"
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"status": summary["status"], "evidence": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        result = main()
    except Exception as error:
        print(f"Verification error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
    raise SystemExit(result)
