import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readLocalProfile } from "./local.js";
import { PDPP_PINS } from "./pins.js";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const requiredFiles = [
  "collection-profile.json",
  "code.tar.gz",
  "licenses.tar.gz",
  "source-declaration.json",
  "provenance.json",
  "config.json",
  "layers.json",
];
const allowedFiles = [...requiredFiles, "assets.tar.gz"];
const fileSchema = z
  .object({
    path: z.enum(allowedFiles as [string, ...string[]]),
    sha256: digestSchema,
    size: z.number().int().positive().max(MAX_FILE_BYTES),
  })
  .strict();
const descriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: z.string().regex(/^[a-f0-9]{32}$/),
    ownerAddress: z.string().regex(/^0x[a-f0-9]{40}$/),
    accountUrl: z.enum([
      "https://account.vana.org",
      "https://account-dev.vana.org",
    ]),
    environment: z.enum(["dev", "prod"]),
    network: z.enum(["moksha", "mainnet"]),
    connectorId: key,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    streams: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/))
      .min(1)
      .max(100)
      .refine((streams) => new Set(streams).size === streams.length),
    artifactDigest: digestSchema,
    files: z.array(fileSchema).min(7).max(8),
  })
  .strict();

/** Immutable local transport; Desktop independently verifies and approves it. */
export type DesktopHandoff = z.infer<typeof descriptorSchema>;
/** The intended Account authority, owner and chain; never a session token. */
export type DesktopHandoffContext = Pick<
  DesktopHandoff,
  "ownerAddress" | "accountUrl" | "environment" | "network"
>;
/** Bounded machine outcomes written by Desktop beside the immutable payload. */
export const desktopHandoffStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: z.string().regex(/^[a-f0-9]{32}$/),
    state: z.enum(["pending", "enabled", "disabled", "removed", "failed"]),
    connectorId: key,
    artifactDigest: digestSchema,
    code: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
    remedy: z.string().max(2000).optional(),
  })
  .strict();

/** A safe actionable failure; subprocess output is deliberately excluded. */
export class DesktopHandoffError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function identity(value: Omit<DesktopHandoff, "handoffId">): string {
  return hash(
    JSON.stringify({
      schemaVersion: value.schemaVersion,
      ownerAddress: value.ownerAddress,
      accountUrl: value.accountUrl,
      environment: value.environment,
      network: value.network,
      connectorId: value.connectorId,
      version: value.version,
      streams: value.streams,
      artifactDigest: value.artifactDigest,
      files: value.files,
    }),
  ).slice(0, 32);
}
function artifactDigest(files: DesktopHandoff["files"]): string {
  return `sha256:${hash(files.map((file) => `${file.path}\0${file.sha256}\0${file.size}\n`).join(""))}`;
}
/** Desktop resolves only this fixed same-Mac inbox, independently of VANA_HOME. */
export function desktopHandoffInbox(): string {
  return path.join(os.homedir(), ".vana", "desktop-handoffs");
}

async function regularBytes(file: string): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("invalid file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function realDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("invalid directory");
}

/** Verify descriptor identity and every frozen byte before status or resume. */
export async function readDesktopHandoff(
  inbox: string,
  id: string,
): Promise<DesktopHandoff> {
  try {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid id");
    await realDirectory(inbox);
    const directory = path.join(inbox, id);
    await realDirectory(directory);
    await realDirectory(path.join(directory, "payload"));
    const bytes = await regularBytes(path.join(directory, "handoff.json"));
    if (bytes.length > 64 * 1024) throw new Error("large descriptor");
    const descriptor = descriptorSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    const { handoffId, ...content } = descriptor;
    if (handoffId !== id || identity(content) !== id)
      throw new Error("wrong identity");
    if (
      descriptor.files.reduce((total, file) => total + file.size, 0) >
      MAX_TOTAL_BYTES
    )
      throw new Error("oversized payload");
    const names = descriptor.files.map((file) => file.path);
    if (
      names.join("\0") !== [...new Set(names)].sort().join("\0") ||
      requiredFiles.some((name) => !names.includes(name))
    )
      throw new Error("invalid inventory");
    if (artifactDigest(descriptor.files) !== descriptor.artifactDigest)
      throw new Error("wrong digest");
    const actual = (await fs.readdir(path.join(directory, "payload"))).sort();
    if (actual.join("\0") !== names.join("\0")) throw new Error("extra files");
    for (const file of descriptor.files) {
      const data = await regularBytes(
        path.join(directory, "payload", file.path),
      );
      if (data.length !== file.size || `sha256:${hash(data)}` !== file.sha256)
        throw new Error("changed bytes");
    }
    return descriptor;
  } catch {
    throw new DesktopHandoffError(
      "handoff_invalid",
      "The handoff is missing, malformed or changed. Package the connector again; do not enable this snapshot.",
    );
  }
}

/** Reuse is allowed only in the original Account, owner, service environment and chain. */
export function assertDesktopHandoffContext(
  descriptor: DesktopHandoff,
  context: DesktopHandoffContext,
): void {
  for (const field of [
    "ownerAddress",
    "accountUrl",
    "environment",
    "network",
  ] as const) {
    if (descriptor[field] !== context[field])
      throw new DesktopHandoffError(
        "handoff_context_changed",
        "This handoff belongs to another Account, owner, environment or network. Return to its original context or package a new handoff.",
      );
  }
}

/** Read native status only after checking the immutable handoff and matching identity. */
export async function readDesktopHandoffStatus(
  inbox: string,
  descriptor: DesktopHandoff,
): Promise<z.infer<typeof desktopHandoffStatusSchema> | null> {
  try {
    const bytes = await regularBytes(
      path.join(inbox, descriptor.handoffId, "status.json"),
    );
    if (bytes.length > 16 * 1024) throw new Error("large status");
    const status = desktopHandoffStatusSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (
      status.handoffId !== descriptor.handoffId ||
      status.connectorId !== descriptor.connectorId ||
      status.artifactDigest !== descriptor.artifactDigest
    )
      throw new Error("wrong status identity");
    return status;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DesktopHandoffError(
      "desktop_status_invalid",
      "Desktop returned an invalid status. Reopen the same handoff in Desktop to inspect it.",
    );
  }
}

function toolingEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
  };
}
function commandPath(name: string): string | null {
  try {
    return execFileSync("which", [name], {
      encoding: "utf8",
      env: toolingEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
function packagingTools(node: string): { node: string; tar: string } {
  const executable = path.isAbsolute(node) ? node : commandPath(node);
  try {
    if (
      !executable ||
      !/^v24\./.test(
        execFileSync(executable, ["--version"], {
          encoding: "utf8",
          env: toolingEnvironment(),
          stdio: ["ignore", "pipe", "ignore"],
        }),
      )
    )
      throw new Error();
  } catch {
    throw new DesktopHandoffError(
      "node24_required",
      "Packaging needs a real Node 24 executable. Select it on PATH or pass --node /absolute/path/to/node.",
    );
  }
  for (const name of [
    "gtar",
    "tar",
    "/opt/homebrew/bin/gtar",
    "/usr/local/bin/gtar",
  ]) {
    const candidate = path.isAbsolute(name) ? name : commandPath(name);
    try {
      if (
        candidate &&
        execFileSync(candidate, ["--version"], {
          encoding: "utf8",
          env: toolingEnvironment(),
          stdio: ["ignore", "pipe", "ignore"],
        }).includes("GNU tar")
      )
        return { node: executable, tar: candidate };
    } catch {
      /* Try the next installed implementation. */
    }
  }
  throw new DesktopHandoffError(
    "gnu_tar_required",
    "The public artifact builder requires GNU tar. On macOS install gnu-tar and rerun; BSD tar is unsupported.",
  );
}

function profileScopeSource(profile: unknown): string {
  const parsed = z
    .object({ source: z.object({ id: z.string() }) })
    .safeParse(profile);
  let sourceId: string | undefined;
  try {
    if (parsed.success)
      sourceId = new URL(parsed.data.source.id).pathname
        .split("/")
        .filter(Boolean)
        .at(-1);
  } catch {
    /* The bounded error below also covers malformed source URIs. */
  }
  if (!sourceId || !/^[a-z0-9][a-z0-9_]*$/.test(sourceId))
    throw new DesktopHandoffError(
      "invalid_source_scope",
      "The profile source.id URI must end in an SDK-compatible source name using lowercase letters, digits and underscores (for example desktop_synthetic). Keep the connector_key in kebab case; no source name is rewritten.",
    );
  if (PDPP_PINS.some((pin) => pin.id.replace(/-/g, "_") === sourceId))
    throw new DesktopHandoffError(
      "source_collision",
      "This source.id belongs to a public source. Choose a new source name; public-source replacement is unsupported.",
    );
  return sourceId;
}

/** Resolve consumer scopes from the verified frozen profile, independently of mutable source code. */
export async function desktopHandoffScopes(
  inbox: string,
  descriptor: DesktopHandoff,
): Promise<{ sourceId: string; scopes: string[] }> {
  const file = descriptor.files.find(
    (entry) => entry.path === "collection-profile.json",
  );
  const bytes = await regularBytes(
    path.join(
      inbox,
      descriptor.handoffId,
      "payload",
      "collection-profile.json",
    ),
  );
  if (
    !file ||
    bytes.length !== file.size ||
    `sha256:${hash(bytes)}` !== file.sha256
  )
    throw new DesktopHandoffError(
      "handoff_invalid",
      "The frozen profile changed. Do not use scopes from this snapshot.",
    );
  const sourceId = profileScopeSource(JSON.parse(bytes.toString("utf8")));
  return {
    sourceId,
    scopes: descriptor.streams.map((stream) => `${sourceId}.${stream}`),
  };
}

/** Build through the public upstream tool, then freeze only its explicit payload layers. */
export async function prepareDesktopHandoff(options: {
  checkout: string;
  source: string;
  streams?: string[];
  context: DesktopHandoffContext;
  node?: string;
  inbox?: string;
}): Promise<DesktopHandoff> {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(options.source))
    throw new DesktopHandoffError(
      "unsupported_layout",
      "Use the upstream connector directory name (lowercase letters, digits and underscores).",
    );
  const { files, profile } = await readLocalProfile(
    options.checkout,
    options.source,
  );
  const sourceId = profileScopeSource(profile);
  const connectorId = profile.connector_key;
  if (
    !key.safeParse(connectorId).success ||
    PDPP_PINS.some((pin) => pin.id.replace(/_/g, "-") === connectorId)
  )
    throw new DesktopHandoffError(
      "source_collision",
      "Desktop development handoffs require a new source name; public connector replacement is unsupported.",
    );
  const streams = [
    ...new Set(options.streams ?? profile.streams.map((stream) => stream.name)),
  ].sort();
  if (
    !streams.length ||
    streams.some(
      (stream) =>
        !/^[a-z0-9][a-z0-9_]*$/.test(stream) ||
        !profile.streams.some((declared) => declared.name === stream),
    )
  )
    throw new DesktopHandoffError(
      "invalid_streams",
      "Select declared streams with SDK-compatible scope names using lowercase letters, digits and underscores; hyphens are unsupported.",
    );
  if (
    !/^[a-z0-9][a-z0-9_]*$/.test(options.source) ||
    path.dirname(files.entry) !==
      path.join(files.root, "connectors", options.source)
  )
    throw new DesktopHandoffError(
      "unsupported_layout",
      "Packaging requires the current upstream connectors/<directory>/manifest.json layout.",
    );
  const builder = path.join(
    files.root,
    "scripts",
    "build-connector-oci-artifact.mjs",
  );
  await fs.access(builder).catch(() => {
    throw new DesktopHandoffError(
      "builder_missing",
      "Use a public data-connectors checkout containing scripts/build-connector-oci-artifact.mjs and its locked installed tools.",
    );
  });
  const tools = packagingTools(options.node ?? "node");
  const inbox = options.inbox ?? desktopHandoffInbox();
  await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
  await realDirectory(inbox);
  const temporary = await fs.mkdtemp(path.join(inbox, ".prepare-"));
  try {
    const toolBin = path.join(temporary, "bin");
    await fs.mkdir(toolBin, { mode: 0o700 });
    await fs.symlink(tools.tar, path.join(toolBin, "tar"));
    const payload = path.join(temporary, "payload");
    try {
      execFileSync(
        tools.node,
        [builder, "--connector", options.source, "--out", payload],
        {
          cwd: files.root,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
          // A build must not inherit provider secrets, PDPP browser endpoints or collection inputs.
          env: {
            PATH: `${toolBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
            HOME: os.homedir(),
            TMPDIR: os.tmpdir(),
          },
        },
      );
    } catch {
      throw new DesktopHandoffError(
        "packaging_failed",
        "The public artifact builder failed. Run its static checks locally and inspect its private diagnostics; no handoff was created.",
      );
    }
    const names = (await fs.readdir(payload)).sort();
    if (
      names.some((name) => !allowedFiles.includes(name)) ||
      requiredFiles.some((name) => !names.includes(name))
    )
      throw new DesktopHandoffError(
        "payload_invalid",
        "The builder output is incomplete or includes unsupported files. No handoff was created.",
      );
    const inventory: DesktopHandoff["files"] = [];
    for (const name of names) {
      const data = await regularBytes(path.join(payload, name));
      await fs.chmod(path.join(payload, name), 0o600);
      inventory.push({
        path: name,
        sha256: `sha256:${hash(data)}`,
        size: data.length,
      });
    }
    if (
      inventory.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES
    )
      throw new DesktopHandoffError(
        "payload_too_large",
        "The Desktop payload exceeds the 256 MiB total limit.",
      );
    const frozenProfile = JSON.parse(
      (
        await regularBytes(path.join(payload, "collection-profile.json"))
      ).toString("utf8"),
    );
    if (
      profileScopeSource(frozenProfile) !== sourceId ||
      frozenProfile.connector_key !== connectorId ||
      frozenProfile.version !== profile.version ||
      streams.some(
        (stream) =>
          !frozenProfile.streams?.some(
            (entry: { name: string }) => entry.name === stream,
          ),
      )
    )
      throw new DesktopHandoffError(
        "source_changed",
        "The manifest changed during packaging. Rerun packaging after edits finish.",
      );
    const content = {
      schemaVersion: 1 as const,
      ...options.context,
      connectorId,
      version: profile.version,
      streams,
      artifactDigest: artifactDigest(inventory),
      files: inventory,
    };
    const descriptor = descriptorSchema.parse({
      ...content,
      handoffId: identity(content),
    });
    await fs.writeFile(
      path.join(temporary, "handoff.json"),
      `${JSON.stringify(descriptor, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.rm(toolBin, { recursive: true });
    const destination = path.join(inbox, descriptor.handoffId);
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    return await readDesktopHandoff(inbox, descriptor.handoffId);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
