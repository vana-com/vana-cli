import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getPdppHome, type HostRuntimeContract } from "./host.js";
import { pinOciReference, type PdppPin } from "./pins.js";
import { parseCollectionProfile, type PdppLaunch } from "./profile.js";
import type * as InstallerCoreModule from "../vendor/pdpp-connector-manager/index.mjs";
import type { ConnectorLock } from "../vendor/pdpp-connector-manager/index.mjs";

type InstallerCore = typeof InstallerCoreModule;

// Loaded on first use: sigstore and its dependencies are not worth paying for
// on every CLI start, and legacy sources never need them.
async function loadInstallerCore(): Promise<InstallerCore> {
  return (await import("../vendor/pdpp-connector-manager/index.mjs")) as InstallerCore;
}

const PROFILE_PATH = "profile/collection-profile.json";
const ENTRYPOINT_PATH = "dist/collection-profile.mjs";
const PROVENANCE_PATH = "provenance.json";

export function artifactRootFor(
  pin: PdppPin,
  installRoot = getPdppHome(),
): string {
  return path.join(installRoot, "collection-profiles", pin.id);
}

function lockFor(core: InstallerCore, pin: PdppPin): ConnectorLock {
  const reference = core.parseConnectorOciReference(pinOciReference(pin));
  return {
    lockVersion: "2.0",
    connectors: [
      {
        connectorId: pin.id,
        connectorKey: reference.connectorKey,
        version: pin.version,
        artifactKind: "pdpp-collection-profile",
        manifestPath: PROFILE_PATH,
        entrypointPath: ENTRYPOINT_PATH,
        provenancePath: PROVENANCE_PATH,
        oci: {
          registry: reference.registry,
          repository: reference.repository,
          digest: reference.digest,
        },
      },
    ],
  };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
}

/**
 * Read an installed artifact into a launch, refusing one whose manifest does
 * not describe the pinned connector.
 */
export async function readInstalledLaunch(
  pin: PdppPin,
  artifactRoot: string,
  installRoot: string,
): Promise<PdppLaunch> {
  const profile = parseCollectionProfile(
    await readJson(path.join(artifactRoot, PROFILE_PATH)),
    `${pin.name} profile`,
  );
  if (profile.connector_key !== pin.id || profile.version !== pin.version) {
    throw new Error(
      `The installed ${pin.name} connector is ${profile.connector_key} ${profile.version}, not the pinned ${pin.id} ${pin.version}.`,
    );
  }

  const provenance = (await readJson(
    path.join(artifactRoot, PROVENANCE_PATH),
  )) as { host_runtime_contract?: Partial<HostRuntimeContract> };
  const contract = provenance.host_runtime_contract;
  if (!contract || typeof contract.node !== "string") {
    throw new Error(
      `The ${pin.name} connector does not say which Node it needs.`,
    );
  }

  return {
    source: pin.id,
    displayName: profile.display_name ?? pin.name,
    version: profile.version,
    profile,
    args: [path.join(artifactRoot, ENTRYPOINT_PATH)],
    cwd: artifactRoot,
    nodeRange: contract.node,
    installRoot,
    hostPackages: Array.isArray(contract.packages) ? contract.packages : [],
    origin: "pinned",
  };
}

/**
 * Install the pinned artifact if needed and verify it, returning how to run
 * it. Nothing unverified is ever returned: an existing install is re-checked
 * against the registry's signed digest on every call, and a fresh one is
 * unpacked into a staging directory and moved into place only after the
 * installer has checked its signature and every file digest.
 */
export async function ensurePinnedArtifact(
  pin: PdppPin,
  logPath: string,
  installRoot = getPdppHome(),
): Promise<PdppLaunch> {
  const core = await loadInstallerCore();
  const lock = lockFor(core, pin);
  const artifactRoot = artifactRootFor(pin, installRoot);
  await fsp.mkdir(installRoot, { recursive: true });

  if (fs.existsSync(artifactRoot)) {
    const verified = await core.verifyInstalled({
      lock,
      source: null,
      installRoot,
      layout: "snapshot",
    });
    if (verified.ok) {
      await fsp.appendFile(
        logPath,
        `Verified ${pinOciReference(pin)}\n`,
        "utf8",
      );
      return readInstalledLaunch(pin, artifactRoot, installRoot);
    }
    await fsp.appendFile(
      logPath,
      `Installed ${pin.id} failed verification (missing: ${verified.missing.join(", ") || "none"}; changed: ${verified.mismatched.join(", ") || "none"}); reinstalling.\n`,
      "utf8",
    );
  }

  const staging = await fsp.mkdtemp(path.join(installRoot, ".staging-"));
  try {
    await core.installFromLock({
      lock,
      source: null,
      installRoot: staging,
      layout: "snapshot",
      allowTagResolution: false,
    });
    const stagedArtifact = artifactRootFor(pin, staging);
    // Validate before the swap so a bad artifact never replaces a good one.
    await readInstalledLaunch(pin, stagedArtifact, installRoot);

    await fsp.mkdir(path.dirname(artifactRoot), { recursive: true });
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rename(stagedArtifact, artifactRoot);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
  await fsp.appendFile(logPath, `Installed ${pinOciReference(pin)}\n`, "utf8");
  return readInstalledLaunch(pin, artifactRoot, installRoot);
}
