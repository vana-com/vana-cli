// Types for the parts of the vendored installer vana-cli calls. Written by
// hand against index.mjs at the vendored commit; see VENDOR.md.

export interface ConnectorLockEntry {
  connectorId: string;
  connectorKey: string;
  version: string | null;
  artifactKind: "pdpp-collection-profile";
  manifestPath: string;
  entrypointPath: string;
  provenancePath: string;
  oci: { registry: string; repository: string; digest: string };
}

export interface ConnectorLock {
  lockVersion: "2.0";
  connectors: ConnectorLockEntry[];
}

export interface InstallOptions {
  lock: ConnectorLock;
  source: null;
  installRoot: string;
  layout: "snapshot";
  allowTagResolution?: boolean;
}

export function installFromLock(options: InstallOptions): Promise<{
  installRoot: string;
  connectorCount: number;
  filesWritten: number;
  expectedPaths: string[];
}>;

export function verifyInstalled(
  options: Omit<InstallOptions, "allowTagResolution">,
): Promise<{
  ok: boolean;
  missing: string[];
  mismatched: string[];
}>;

export function parseConnectorOciReference(reference: string): {
  registry: string;
  repository: string;
  connectorKey: string;
  digest: string;
  version: string | null;
};
