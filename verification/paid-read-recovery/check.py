#!/usr/bin/env python3
"""Verify the pinned paid-read code in a disposable offline snapshot."""

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
OWNERS = {'src/cli/app/read.ts': '225b144bf71c658a9324c576c387a66d3144d747', 'src/core/receipts.ts': '5f3b4307207441e06d7810c751608c31cac80d0d', 'src/core/receipts-lock.ts': '5b10b659badeee27ab5252cf41d4259568e35000'}
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
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="paid-read-check-"))
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
    for owner_test in ["test/cli/app-read-loop.test.ts", "test/core/receipts-lock.test.ts"]:
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
    summary = {"revision": revision, "owners": OWNERS, "source_mode": "commit" if args.ref else "verified working-tree files", "live_reads": False, "models": {}}
    for case, expected in [("single", 0), ("concurrent", 0), ("writers", 0), ("concurrent-crash", 0), ("no-save", 12), ("no-refusal", 12), ("no-read-lock", 12), ("no-write-lock", 12)]:
        state_dir = out / f"tlc-{case}"
        state_dir.mkdir()
        result = command([
            java, "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
            "-workers", "1", "-fp", "0", "-lncheck", "final",
            "-metadir", str(state_dir), "-config", str(modeldir / f"{case}.cfg"),
            str(modeldir / "PaidRead.tla"),
        ], modeldir)
        (out / f"{case}-tlc.log").write_text(result.stdout + result.stderr)
        if result.returncode != expected:
            raise RuntimeError(f"{case}: expected TLC exit {expected}, got {result.returncode}; see {out}")
        summary["models"][case] = result.returncode
    baseline = command(testcmd, snapshot)
    (out / "baseline-tests.log").write_text(baseline.stdout + baseline.stderr)
    if baseline.returncode:
        raise RuntimeError(f"Real-code replay failed; inspect {out / 'baseline-tests.log'}")
    originals = {owner: (snapshot / owner).read_bytes() for owner in OWNERS}
    read_text = originals["src/cli/app/read.ts"].decode()
    store_text = originals["src/core/receipts.ts"].decode()
    save_pattern = r"receipts\.saveReceipt\(storedKey, \{.*?\n\s*\}\);"
    if len(re.findall(save_pattern, read_text, re.S)) != 1 or read_text.count("if (stored) {") != 1:
        raise RuntimeError("Mutation anchors drifted; review the source")
    write_lock = 'const release = acquireReceiptLock(`${file}.lock`);'
    read_lock = 'const release = acquireReceiptLock(`${file}.${intent}.read.lock`);'
    if store_text.count(write_lock) != 1 or store_text.count(read_lock) != 1:
        raise RuntimeError("Lock mutation anchors drifted; review the source")
    summary["mutations"] = {}
    try:
        for name, owner, mutated, selected in [
            ("no-save", "src/cli/app/read.ts", re.sub(save_pattern, "void paymentQuote;", read_text, flags=re.S), "retains a paid read's exact header"),
            ("no-refusal", "src/cli/app/read.ts", read_text.replace("if (stored) {", "if (false) {"), "refuses a new payment after a saved receipt"),
            ("no-read-lock", "src/core/receipts.ts", store_text.replace(read_lock, "const release = () => {};"), "refuses an overlapping read"),
            ("no-write-lock", "src/core/receipts.ts", store_text.replace(write_lock, "const release = () => {};"), "refuses a competing write"),
        ]:
            source = snapshot / owner
            source.write_text(mutated)
            result = command(testcmd + ["test/cli/app-read-loop.test.ts", "-t", selected], snapshot)
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
        actual = checked(["git", "hash-object", str(snapshot / owner)], REPO)
        if actual != blob:
            raise RuntimeError(f"Scratch source was not restored: {owner}")
    summary["product_snapshot_restored"] = True
    summary["status"] = "passed: recovery, overlapping reads and independent state writes"
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
