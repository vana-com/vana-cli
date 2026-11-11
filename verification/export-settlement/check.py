#!/usr/bin/env python3
"""Check export settlement and its negative controls on a pinned CLI revision."""

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
JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
LOCAL = "777cb1824825364aed2b665b5fa9bede59768565"
MAIN = "a55d0a0006da6a743b6452796435afa6ed177dd8"
OWNER_TEST = "test/cli/export-owner.test.ts"
STORE = "src/core/state-store.ts"
REJECT_PUBLISH = (
    "preserves A's admitted bytes when B's already-running collection loses publication"
)
REJECT_SETTLE = (
    "settles only the accepted generation when an earlier upload finishes after a newer collection"
)
SHARED_BLOBS = {
    STORE: "b44b264c30d1763ba8c68507abb86c81e88d9946",
    "src/core/source-export.ts": "af46b8ad4f4a64d92f6962ec9e8626d952319ef8",
    "src/personal-server/index.ts": "7bc722ef96d3e97b626c192a404bb8f1d27ba8ce",
}
SOURCES = {
    LOCAL: {
        **SHARED_BLOBS,
        "src/cli/index.ts": "0a441304a3f7ca729b9b614aa86f8ac472f1425a",
        OWNER_TEST: "48a2fe754dc2dfe9275eae8305438ead8027c5cf",
    },
    MAIN: {
        **SHARED_BLOBS,
        "src/cli/index.ts": "817051b3a0f7788c181eca9a684850451ca69766",
        OWNER_TEST: "3fbd1d57d23b7e3d086b84ecc0cd20e25cca5fad",
    },
}
CONTROLS = {
    "no-publish-guard": {
        "rule": "ForeignPendingReceiptPreserved",
        "test": REJECT_PUBLISH,
        "before": "        if (pendingExportBlockReason(current, exportGuard.publish.owner))\n          return false;",
        "after": "        void pendingExportBlockReason;",
        "failure": "expected +0 to be 5",
    },
    "no-settle-guard": {
        "rule": "VisibleResultMatchesReceipt",
        "test": REJECT_SETTLE,
        "before": "readExportReceipt(current.exportReceipt)?.id !== exportGuard.settle",
        "after": "(void readExportReceipt, false)",
        "failure": "expected +0 to be 5",
    },
}


def command(argv, cwd=REPO, env=None):
    return subprocess.run(
        argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=100
    )


def checked(argv):
    result = command(argv)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError(f"Expected a unique scratch mutation anchor: {before}")
    return source.replace(before, after)


def run_models(out):
    pinned_tool = "github:tlaplus/tlaplus@1.7.4"
    jar = Path(os.environ.get("TLA2TOOLS") or
               Path(checked(["mise", "where", pinned_tool])) / "tla2tools.jar").resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        raise RuntimeError("Use the pinned TLC 1.7.4 jar")
    java = os.environ.get("JAVA") or checked(
        ["mise", "which", "java", "--tool", "java@temurin-25"]
    )
    models = out / "models"
    shutil.copytree(HERE / "models", models)
    verdicts = {}
    for case in ("same-owner", "two-owners", *CONTROLS):
        expected = CONTROLS.get(case, {}).get("rule")
        result = command([
            java, "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC",
            "-workers", "1", "-fp", "0", "-metadir", str(out / f"tlc-{case}"),
            "-config", f"{case}.cfg", "ExportSettlement.tla",
        ], models)
        log = result.stdout + result.stderr
        (out / f"{case}-tlc.log").write_text(log)
        count = re.search(r"([\d,]+) distinct states found", log)
        if expected:
            success = result.returncode == 12 and f"Invariant {expected} is violated" in log
        else:
            success = (
                result.returncode == 0
                and "Model checking completed. No error has been found." in log
                and "0 states left on queue" in log
            )
        if not success or count is None:
            raise RuntimeError(f"Unexpected model verdict: see {out / f'{case}-tlc.log'}")
        verdicts[case] = {"states": int(count[1].replace(",", "")), "violation": expected}
    return verdicts


def replay(snapshot, out, label, cases, control=None):
    report = out / f"{label}-tests.json"
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node 24 is required for the synthetic connector")
    preload = snapshot / "loopback-only.cjs"
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(snapshot),
        "VANA_PDPP_NODE": node,
        "NODE_OPTIONS": f"--require={json.dumps(str(preload))}",
        "CI": "true",
    }
    result = command(
        [
            node, "node_modules/vitest/vitest.mjs", "run", OWNER_TEST,
            "-t", "|".join(re.escape(test) for test in cases),
            "--reporter=json", f"--outputFile={report}",
        ],
        snapshot, env,
    )
    log = out / f"{label}-tests.log"
    log.write_text(result.stdout + result.stderr)
    if result.returncode != (1 if control else 0) or not report.is_file():
        raise RuntimeError(f"Unexpected replay exit: see {log}")
    assertions = [
        test
        for file in json.loads(report.read_text())["testResults"]
        for test in file["assertionResults"]
        if test["title"] in cases
    ]
    if sorted(test["title"] for test in assertions) != sorted(cases):
        raise RuntimeError(f"Missing replay assertions: see {report}")
    for test in assertions:
        if control:
            errors = " ".join(test["failureMessages"])
            if test["status"] != "failed" or control["failure"] not in errors:
                raise RuntimeError(f"Wrong mutation failure: see {report}")
        elif test["status"] != "passed":
            raise RuntimeError(f"Replay did not pass: see {report}")


def run_replays(revision, out):
    with tempfile.TemporaryDirectory(prefix="vana-export-replay-") as scratch:
        snapshot = Path(scratch)
        archive = subprocess.check_output(["git", "archive", revision], cwd=REPO)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(
                snapshot,
                members=[member for member in tar if not (member.issym() or member.islnk())],
                filter="data",
            )
        (snapshot / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
        shutil.copy2(HERE / "fixtures/loopback-only.cjs", snapshot / "loopback-only.cjs")
        owner_test = snapshot / OWNER_TEST
        owner_test.write_text(replace_once(
            owner_test.read_text(),
            "          ...cleanEnv,",
            "          ...cleanEnv,\n          NODE_OPTIONS: process.env.NODE_OPTIONS,",
        ))
        cases = (REJECT_PUBLISH, REJECT_SETTLE)
        replay(snapshot, out, "baseline", cases)
        source = snapshot / STORE
        original = source.read_bytes()
        for name, control in CONTROLS.items():
            try:
                source.write_text(replace_once(
                    original.decode(), control["before"], control["after"],
                ))
                replay(snapshot, out, name, (control["test"],), control)
            finally:
                source.write_bytes(original)
        replay(snapshot, out, "restored", cases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Check a pinned committed revision")
    parser.add_argument("--out", type=Path, help="New evidence directory")
    args = parser.parse_args()
    revision = checked(["git", "rev-parse", args.ref or MAIN])
    if revision not in SOURCES:
        raise RuntimeError("Unknown source revision. Reconcile the model before advancing SOURCES.")
    blobs = SOURCES[revision]
    for owner, expected in blobs.items():
        if checked(["git", "rev-parse", f"{revision}:{owner}"]) != expected:
            raise RuntimeError(f"Model source drift at {owner}")
        if not args.ref:
            if checked(["git", "hash-object", str(REPO / owner)]) != expected:
                raise RuntimeError(f"Working-tree model source drift at {owner}")
    if not (REPO / "node_modules/vitest/vitest.mjs").is_file():
        raise RuntimeError("Use existing repository dependencies")
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="vana-export-check-"))
    if args.out:
        out.mkdir(parents=True, exist_ok=False)
    verdicts = run_models(out)
    run_replays(revision, out)
    model_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((out / "models").iterdir())
        if path.is_file()
    }
    summary = {
        "status": "passed",
        "source_revision": revision,
        "source_blobs": blobs,
        "models": verdicts,
        "model_sha256": model_hashes,
        "baseline_assertions": 2,
        "caught_source_mutations": list(CONTROLS),
        "restored_assertions": 2,
        "transport": "synthetic loopback only",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"evidence": str(out), **summary}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Verification error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
