import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Command } from "commander";
import { z } from "zod";

import { CliExitCode } from "../core/exit-codes.js";
import {
  connectorPrTarget,
  SubmitError,
  submitConnectorPr,
} from "./connector-pr-submit.js";
import { isNewerVersion } from "./update-check.js";

const INDEX_PATH = "connector-implementation-index.json";
const commitId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const directoryKey = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const line = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

const evidenceSchema = z.strictObject({
  kind: z.literal("synthetic"),
  commit: z.string().regex(commitId),
  checkedAt: z.iso.datetime(),
  checks: z
    .array(
      z.strictObject({
        name: line,
        result: z.enum(["passed", "failed", "not run"]),
      }),
    )
    .min(1)
    .max(25),
});

const manifestSchema = z.looseObject({
  connector_key: z.string(),
  version: z.string().regex(version),
  streams: z.array(z.looseObject({ name: line })).min(1),
});

const indexSchema = z.strictObject({
  version: z.literal(1),
  connectors: z.array(
    z.looseObject({
      manifest: z.looseObject({ connector_key: z.string() }),
    }),
  ),
});

interface PrepOptions {
  checkout: string;
  base: string;
  head: string;
  summary: string;
  evidence?: string;
  confirm?: string;
}

class PrepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function localGit(checkout: string) {
  // A caller's Git environment must not redirect the explicit checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return (...args: string[]): string => {
    const result = spawnSync(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "--no-replace-objects",
        "-C",
        checkout,
        ...args,
      ],
      {
        env: { ...env, GIT_NO_LAZY_FETCH: "1" },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      },
    );
    if (result.status !== 0) {
      throw new PrepError(
        "local_git_failed",
        "Git could not read the local checkout or requested revisions. Check the checkout, refs and diff size.",
      );
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      result.stdout,
    );
  };
}

function prepare(key: string, options: PrepOptions) {
  if (!directoryKey.test(key) || !line.safeParse(options.summary).success) {
    throw new PrepError(
      "invalid_input",
      "Use the connector's snake_case directory name and a one-line change summary.",
    );
  }
  const checkout = realpathSync(options.checkout);
  const git = localGit(checkout);
  if (
    realpathSync(git("rev-parse", "--show-toplevel").trimEnd()) !== checkout
  ) {
    throw new PrepError(
      "invalid_checkout",
      "Pass the root of the PDP-Connect checkout.",
    );
  }
  const resolveCommit = (ref: string) =>
    git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}").trim();
  const base = resolveCommit(options.base);
  const head = resolveCommit(options.head);
  if (git("merge-base", base, head).trim() !== base) {
    throw new PrepError(
      "base_not_ancestor",
      "Rebase the selected commit onto the intended PDP-Connect base before preparing the diff.",
    );
  }

  const prefix = "connectors/" + key + "/";
  const comparison = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-relative",
    base,
    head,
    "--",
  ];
  const changed = git("diff", "--name-only", "-z", ...comparison)
    .split("\0")
    .filter(Boolean);
  if (
    !changed.some((file) => file.startsWith(prefix)) ||
    changed.some(
      (file) =>
        (file !== INDEX_PATH && !file.startsWith(prefix)) ||
        /\p{Cc}/u.test(file),
    )
  ) {
    throw new PrepError(
      "connector_diff_required",
      "Select a commit range changing only the chosen connector and its generated index entry.",
    );
  }
  // Raw modes expose symlinks and Git links, including deletions. Neither
  // belongs in this review format.
  const raw = git("diff", "--raw", "-z", ...comparison).split("\0");
  if (
    raw.some(
      (entry, index) =>
        index % 2 === 0 &&
        entry &&
        !/^:(?:000000|100644|100755) (?:000000|100644|100755) /.test(entry),
    )
  ) {
    throw new PrepError(
      "non_regular_file",
      "The connector diff must contain only regular files.",
    );
  }
  if (
    git("diff", "--numstat", "-z", ...comparison)
      .split("\0")
      .some((entry) => entry.startsWith("-\t"))
  ) {
    throw new PrepError(
      "binary_diff",
      "The connector diff must contain only text files.",
    );
  }
  const manifestPath = prefix + "manifest.json";
  const current = manifestSchema.parse(
    JSON.parse(git("show", head + ":" + manifestPath)),
  );
  const previous = git("ls-tree", base, "--", manifestPath)
    ? manifestSchema.parse(JSON.parse(git("show", base + ":" + manifestPath)))
    : null;
  if (
    current.connector_key !== key.replaceAll("_", "-") ||
    (previous && previous.connector_key !== current.connector_key)
  ) {
    throw new PrepError(
      "connector_key_mismatch",
      "Keep the manifest connector key consistent with the directory and the base manifest.",
    );
  }
  if (previous && !isNewerVersion(previous.version, current.version)) {
    throw new PrepError(
      "version_bump_required",
      "Increase the connector manifest version before preparing this update.",
    );
  }

  const beforeIndex = indexSchema.parse(
    JSON.parse(git("show", base + ":" + INDEX_PATH)),
  );
  const afterIndex = indexSchema.parse(
    JSON.parse(git("show", head + ":" + INDEX_PATH)),
  );
  const isSelected = (
    entry: z.infer<typeof indexSchema>["connectors"][number],
  ) => entry.manifest.connector_key === current.connector_key;
  const selected = afterIndex.connectors.filter(isSelected);
  if (
    selected.length !== 1 ||
    selected[0].entry !== "./" + prefix + "index.ts" ||
    !isDeepStrictEqual(selected[0].manifest, current)
  ) {
    throw new PrepError(
      "stale_connector_index",
      "Regenerate the PDP-Connect implementation index so its entry matches the selected manifest.",
    );
  }
  if (
    !isDeepStrictEqual(
      beforeIndex.connectors.filter((entry) => !isSelected(entry)),
      afterIndex.connectors.filter((entry) => !isSelected(entry)),
    )
  ) {
    throw new PrepError(
      "unrelated_index_change",
      "Keep other connectors' implementation index entries unchanged.",
    );
  }

  const evidence = options.evidence
    ? evidenceSchema.safeParse(
        JSON.parse(readFileSync(options.evidence, "utf8")),
      )
    : undefined;
  if (evidence && !evidence.success) {
    throw new PrepError(
      "invalid_evidence",
      "Supply a reviewed synthetic summary with kind, commit, checkedAt and checks containing name and result.",
    );
  }
  const verification = evidence?.data ?? null;
  if (verification && verification.commit !== head) {
    throw new PrepError(
      "stale_evidence",
      "The evidence names a different commit. Check the selected revision and prepare a fresh summary.",
    );
  }
  const evidenceGaps = [
    ...(verification ? [] : ["No verification summary supplied."]),
    ...(verification?.checks
      .filter((check) => check.result !== "passed")
      .map((check) => check.name + ": " + check.result) ?? []),
    "Live provider behavior and Vana app availability remain unverified.",
  ];
  const prBody = [
    "## What this does",
    "",
    options.summary,
    "",
    "Connector: " +
      current.connector_key +
      " " +
      (previous ? previous.version + " → " : "") +
      current.version,
    "Streams: " + current.streams.map((stream) => stream.name).join(", "),
    "",
    "## How it was verified",
    "",
    ...(verification
      ? [
          "Reported synthetic checks at " +
            verification.checkedAt +
            " on " +
            head +
            ".",
          "",
          ...verification.checks.map(
            (check) => "- " + check.name + " — " + check.result,
          ),
          "",
        ]
      : []),
    ...evidenceGaps.map((gap) => "- " + gap),
    "",
    "Assisted-by: AI",
    "",
  ].join("\n");

  return {
    target: connectorPrTarget,
    baseBranch: "main",
    base,
    head,
    connector: current.connector_key,
    version: current.version,
    previousVersion: previous?.version ?? null,
    streams: current.streams.map((stream) => stream.name),
    files: changed,
    verification,
    evidenceGaps,
    prBody,
    diff: git(
      "diff",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=3",
      ...comparison,
    ),
  };
}

function prepareSubmission(
  options: PrepOptions,
  preview: ReturnType<typeof prepare>,
) {
  const git = localGit(options.checkout);
  const commit = git("cat-file", "commit", preview.head);
  const headers = commit.slice(0, commit.indexOf("\n\n"));
  const parents = headers
    .split("\n")
    .filter((entry) => entry.startsWith("parent "));
  if (
    !preview.previousVersion ||
    preview.head.length !== 40 ||
    parents.length !== 1 ||
    parents[0] !== "parent " + preview.base
  ) {
    throw new PrepError(
      "single_connector_update_required",
      "Submit one commit updating an existing connector, directly on the reviewed PDP-Connect main revision.",
    );
  }
  if (
    !git(
      "show",
      "-s",
      "--format=%(trailers:key=Signed-off-by,valueonly)",
      preview.head,
    ).trim()
  ) {
    throw new PrepError(
      "signoff_required",
      "PDP-Connect requires a Signed-off-by trailer. Sign off the commit and refresh its evidence.",
    );
  }
  if (!preview.verification) {
    throw new PrepError(
      "evidence_required",
      "Supply a reviewed synthetic verification summary before submitting.",
    );
  }
  const submission = submitConnectorPr(
    {
      ...preview,
      title: options.summary,
      objects: git(
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ).trimEnd(),
    },
    options.confirm,
  );
  return submission.kind === "confirmation_required"
    ? { ...submission, ...preview, title: options.summary, commit }
    : submission;
}

function terminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function printPreview(preview: ReturnType<typeof prepare>) {
  process.stdout.write(
    terminalText(
      "Target: " +
        preview.target +
        " (" +
        preview.baseBranch +
        ")\n" +
        "Base: " +
        preview.base +
        "\n" +
        "Head: " +
        preview.head +
        "\n" +
        "Files:\n" +
        preview.files.map((file) => "  " + file).join("\n") +
        "\n\nDraft PR body\n\n" +
        preview.prBody +
        "\nReview this diff and evidence before sharing.\n\n" +
        preview.diff,
    ),
  );
}

function printSubmission(submission: ReturnType<typeof prepareSubmission>) {
  if (submission.kind === "pull_request") {
    const state =
      submission.draft && submission.state === "open"
        ? "draft"
        : submission.state;
    process.stdout.write(
      (submission.reused ? "Existing GitHub PR (" : "GitHub PR (") +
        state +
        "): " +
        submission.url +
        "\n" +
        (submission.draft && submission.state === "open"
          ? "When ready, mark the draft ready for review on GitHub.\n"
          : "Follow the review and respond to requests on GitHub.\n"),
    );
    return;
  }
  process.stdout.write(
    terminalText(
      "Public GitHub submission preview\n" +
        "GitHub account: @" +
        submission.login +
        "\n" +
        "Fork: " +
        submission.fork +
        " (" +
        submission.branch +
        ")\n" +
        "Draft PR title: " +
        submission.title +
        "\n\n" +
        "Commit metadata and message\n\n" +
        submission.commit +
        "\n",
    ),
  );
  printPreview(submission);
  process.stdout.write(
    "\nTo publish this commit to your fork and open a draft PR, rerun with --confirm " +
      submission.confirmation +
      "\n",
  );
}

function registerCommand(
  parent: Command,
  getOptions: () => { json?: boolean },
  submit: boolean,
) {
  const command = parent
    .command(submit ? "submit-pr <directory>" : "prepare-pr <directory>")
    .description(
      submit
        ? "Review and explicitly submit a committed connector update as a GitHub draft PR"
        : "Preview a committed PDP-Connect connector diff and draft PR body locally",
    )
    .requiredOption(
      "--checkout <directory>",
      "Local data-connectors checkout root",
    )
    .requiredOption(
      "--base <commit>",
      "Local revision of the intended upstream main base",
    )
    .option("--head <commit>", "Connector revision to review", "HEAD")
    .requiredOption("--summary <text>", "One-line description for the draft PR")
    .option(
      "--evidence <file>",
      "Reviewed JSON with kind: synthetic, commit, checkedAt and checks [{name, result}]",
    )
    .addHelpText(
      "after",
      submit
        ? "\nUses GitHub CLI sign-in and an existing public fork. Run without --confirm to review.\n"
        : "\nUses committed files only. Review the diff and evidence before sharing them.\n",
    );
  if (submit)
    command.option(
      "--confirm <digest>",
      "Confirm the exact GitHub submission preview",
    );
  command.action((key: string, options: PrepOptions) => {
    const json = getOptions().json;
    try {
      const preview = prepare(key, options);
      const submission = submit
        ? prepareSubmission(options, preview)
        : undefined;
      if (json) {
        process.stdout.write(JSON.stringify(submission ?? preview) + "\n");
      } else if (submission) {
        printSubmission(submission);
      } else {
        process.stdout.write("Local connector PR preview\n");
        printPreview(preview);
      }
      process.exitCode =
        submission?.kind === "confirmation_required"
          ? CliExitCode.CONFIRMATION_REQUIRED
          : CliExitCode.OK;
    } catch (error) {
      const failure =
        error instanceof PrepError || error instanceof SubmitError
          ? error
          : new PrepError(
              submit ? "invalid_submission" : "invalid_local_input",
              submit
                ? "Could not read the local submission or GitHub response. Check the checkout and retry the same submission."
                : "Check the checkout path, committed manifest, and reviewed evidence JSON.",
            );
      if (json) {
        process.stdout.write(
          JSON.stringify({
            error: { code: failure.code, message: failure.message },
          }) + "\n",
        );
      } else {
        process.stderr.write(failure.message + "\n");
      }
      process.exitCode =
        failure instanceof SubmitError ? failure.exitCode : CliExitCode.FAILURE;
    }
  });
}

/** Register the local preview and public submission commands. */
export function registerConnectorPrCommands(
  parent: Command,
  getOptions: () => { json?: boolean },
): void {
  registerCommand(parent, getOptions, false);
  registerCommand(parent, getOptions, true);
}
