#!/usr/bin/env python3
"""Check hosted provisioning create and delete against the model and a replay of the legacy routes."""

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
# The create and delete routes before BUI-1010, kept as witnesses that the
# replay tells each fixed route from the one it replaced.
LEGACY_REVISION = "a55d0a0006da6a743b6452796435afa6ed177dd8"
CREATE_ROUTE = "connect/src/app/api/servers/route.ts"
DELETE_ROUTE = "connect/src/app/api/servers/[id]/route.ts"
LEGACY_BLOBS = {
    CREATE_ROUTE: "118c75f3f1fd3f130cb831b5a04d6391a5a3b956",
    DELETE_ROUTE: "0260ec6d1b468546fcd64b102bda992149209785",
}
OWNERS = {
    CREATE_ROUTE: "3b15ca287645d99187ba92192ec2f8fa7b58440d",
    DELETE_ROUTE: "467765ed17d7f3fdab28ec4397c8fbb4e3704f9e",
    "connect/src/lib/db/neon.ts": "14a410383b3fe9072dbc30ba2d334a9ecb1af9c4",
    "connect/src/lib/api-auth.ts": "e2c1a60fda0a05a313a8c63cf509a41318016a54",
    "connect/src/lib/api-server.ts": "b196dafa9e0b89f59c1c7cbf7d55ee7e86e755cb",
    "connect/src/lib/api-error.ts": "5b0c1f5de52af344afd5addffa37377e7a26ee67",
    "connect/src/lib/server-provider/gcp.ts": "985af1d609a559f5ad5751dee29a8774f8514ea6",
    "connect/vitest.config.ts": "b7689c0dc27e999c37e7da456d26b9ab87298e9a",
}
JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
# The part the create route owns, and the whole property that DELETE also owns.
CREATE_PROPERTY = "CreateNeverSucceedsWithoutRow"
WHOLE_PROPERTY = "CreatedResourceHasTrackingRow"
MODELS = (
    ("current", None),
    ("legacy-create", CREATE_PROPERTY),
    ("stale-delete", WHOLE_PROPERTY),
    ("refuse-provisioning-delete", None),
)
GUARD_ANCHOR = "  const hasProviderState = (row: typeof server) =>"
GUARD = '''  if (server.state === "provisioning") {
    return apiError("conflict_error", "Wait for provisioning to finish.", 409);
  }

'''


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def run(argv, cwd, log, env=None):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=90)
    text = result.stdout + result.stderr
    log.write_text(text)
    return result.returncode, text


def check_models(out, java, jar):
    modeldir = out / "models"
    shutil.copytree(HERE / "models", modeldir)
    reports = {}
    for name, expected in MODELS:
        log = out / f"{name}-tlc.log"
        code, text = run(
            [java, "-XX:+UseParallelGC", "-Xmx768m", "-cp", jar, "tlc2.TLC",
             "-workers", "1", "-fp", "0", "-metadir", str(out / f"tlc-{name}"),
             "-config", f"{name}.cfg", "HostedProvisioning.tla"],
            modeldir, log,
        )
        state_count = re.search(r"(\d+) distinct states found", text)
        violated = re.search(r"Invariant (\w+) is violated", text)
        actual = violated[1] if violated else None
        if (
            code != (12 if expected else 0)
            or actual != expected
            or not state_count
            or (expected is None and "No error has been found" not in text)
        ):
            raise RuntimeError(f"Unexpected model outcome for {name}. See {log}")
        reports[name] = {"states": int(state_count[1]), "violation": actual}
    return reports


def replay(ref, out):
    node = shutil.which("node")
    deps = REPO / "connect/node_modules"
    vitest = deps / "vitest/vitest.mjs"
    if not node or not vitest.is_file():
        raise RuntimeError("Use Node and Connect's installed Vitest")
    legacy = {}
    for route, blob in LEGACY_BLOBS.items():
        if git("rev-parse", f"{LEGACY_REVISION}:{route}") != blob:
            raise RuntimeError(f"Legacy route blob drift in {route}")
        legacy[route] = subprocess.check_output(
            ["git", "show", f"{LEGACY_REVISION}:{route}"], cwd=REPO,
        )
    with tempfile.TemporaryDirectory(prefix="vana-hosted-provisioning-") as tmp:
        snapshot = Path(tmp)
        connect = snapshot / "connect"
        if ref:
            archive = subprocess.check_output(
                ["git", "archive", ref, "--", "connect"], cwd=REPO,
            )
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(
                    snapshot,
                    members=[m for m in tar.getmembers() if not (m.issym() or m.islnk())],
                    filter="data",
                )
        else:
            shutil.copytree(
                REPO / "connect", connect,
                ignore=shutil.ignore_patterns("node_modules", ".next"),
            )
        (connect / "node_modules").symlink_to(deps, target_is_directory=True)
        fixture = "src/app/api/servers/provision-delete-race.test.ts"
        shutil.copy2(HERE / "replay.test.ts", connect / fixture)
        command = [node, str(vitest), "run", fixture, "--environment", "node", "--reporter=verbose"]
        create = snapshot / CREATE_ROUTE
        delete = snapshot / DELETE_ROUTE
        originals = {create: create.read_bytes(), delete: delete.read_bytes()}
        delete_source = originals[delete].decode()
        if delete_source.count(GUARD_ANCHOR) != 1:
            raise RuntimeError("Delete guard anchor drift")

        def require_outcome(name, route):
            log = out / f"{name}-replay.log"
            env = {
                **os.environ, "CI": "true", "TMPDIR": tmp, "NO_COLOR": "1",
                "VANA_HOSTED_REPLAY": route,
            }
            code, text = run(command, connect, log, env)
            if code != 0 or not re.search(r"^ *Tests +3 passed \(3\) *$", text, re.MULTILINE):
                raise RuntimeError(f"Unexpected replay outcome for {name}. See {log}")

        require_outcome("fixed", "fixed")
        for name, path, route in (
            ("legacy-create", create, CREATE_ROUTE),
            ("legacy-delete", delete, DELETE_ROUTE),
        ):
            try:
                path.write_bytes(legacy[route])
                require_outcome(name, name)
            finally:
                path.write_bytes(originals[path])
        try:
            delete.write_text(delete_source.replace(GUARD_ANCHOR, GUARD + GUARD_ANCHOR))
            require_outcome("guarded", "guarded")
        finally:
            delete.write_bytes(originals[delete])
        require_outcome("restored", "fixed")
        if any(path.read_bytes() != original for path, original in originals.items()):
            raise RuntimeError("Scratch route was not restored")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="Check the named revision instead of the working tree if its source blobs match")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    revision = git("rev-parse", args.ref) if args.ref else None
    for owner, expected in OWNERS.items():
        current = git("rev-parse", f"{revision}:{owner}") if revision else git("hash-object", str(REPO / owner))
        if current != expected:
            raise RuntimeError(f"Model/source drift in {owner}. Reconcile the model before advancing its source record.")
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
    out = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="vana-hosted-proof-"))
    if args.out:
        out.mkdir(parents=True, exist_ok=False)
    models = check_models(out, java, jar)
    replay(revision, out)
    summary = {
        "revision": revision or "working tree", "source_blobs": OWNERS, "tool": "TLC 1.7.4",
        "legacy_revision": LEGACY_REVISION,
        "models": models,
        "replays": {
            "fixed": "reservation and provider holds: DELETE 200, POST 409, resource deprovisioned once, no token stored. "
                     "delete-read hold: DELETE 200, POST 201, the late handles deprovisioned once",
            "legacy-create": "old create route: reservation and provider holds leave the resource listed nowhere with no cleanup",
            "legacy-delete": "old delete route: the delete-read hold leaves the resource listed nowhere with no cleanup",
            "guarded": "scratch DELETE guard: DELETE 409, POST 201, provider handles listed, in all three schedules",
            "restored": "the fixed outcomes reproduced again",
        },
        "scratch_source_restored": True,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Checked the fixed create and delete paths, both legacy witnesses and the scratch guard. Evidence in {out}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Verification error: {error}", file=sys.stderr)
        raise SystemExit(2) from error
