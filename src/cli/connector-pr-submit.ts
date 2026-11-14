import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { CliExitCode } from "../core/exit-codes.js";

const repository = "PDP-Connect/data-connectors";
/** The public repository that owns connector contributions. */
export const connectorPrTarget = "https://github.com/" + repository;
const loginSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i);

interface Submission {
  base: string;
  baseBranch: string;
  head: string;
  title: string;
  prBody: string;
  diff: string;
  objects: string;
}

/** An actionable error from the GitHub submission flow. */
export class SubmitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: CliExitCode = CliExitCode.FAILURE,
  ) {
    super(message);
  }
}

function githubEnvironment() {
  const env = { ...process.env };
  // Collection and CI tokens must not select the account publishing this PR.
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GH_DEBUG;
  delete env.DEBUG;
  return { ...env, GH_PROMPT_DISABLED: "1" };
}

function gh(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  return spawnSync("gh", args, {
    env,
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function api(
  env: NodeJS.ProcessEnv,
  endpoint: string,
  body?: Record<string, unknown>,
): unknown {
  const result = gh(
    env,
    [
      "api",
      "--hostname",
      "github.com",
      "--method",
      body === undefined ? "GET" : "POST",
      endpoint,
      ...(body === undefined ? [] : ["--input", "-"]),
    ],
    body === undefined ? undefined : JSON.stringify(body),
  );
  if (result.status !== 0) {
    throw new SubmitError(
      "github_request_failed",
      "GitHub did not confirm the request. Check GitHub access and retry the same submission.",
    );
  }
  return JSON.parse(result.stdout);
}

function githubLogin(env: NodeJS.ProcessEnv) {
  const result = gh(env, [
    "api",
    "--hostname",
    "github.com",
    "user",
    "--jq",
    ".login",
  ]);
  if (
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  ) {
    throw new SubmitError(
      "github_cli_missing",
      "Install GitHub CLI (gh), then run gh auth login --hostname github.com.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }
  const login = loginSchema.safeParse(result.stdout?.trim());
  if (result.status !== 0 || !login.success) {
    throw new SubmitError(
      "github_sign_in_required",
      "Could not verify a signed-in GitHub account. Check connectivity and run gh auth login --hostname github.com if signed out.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }
  return login.data;
}

function pushCommit(
  env: NodeJS.ProcessEnv,
  submission: Submission,
  fork: string,
  branch: string,
) {
  // Use only the reviewed commit's object store. Checkout and user Git config
  // can otherwise supply push hooks, URL rewrites, or other credentials.
  const directory = mkdtempSync(join(tmpdir(), "vana-connector-push-"));
  const gitEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
  Object.assign(gitEnv, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  });
  const git = (args: string[], objects?: string) =>
    spawnSync("git", ["--no-replace-objects", "-C", directory, ...args], {
      env: objects ? { ...gitEnv, GIT_OBJECT_DIRECTORY: objects } : gitEnv,
      stdio: "ignore",
      timeout: 120_000,
    });
  try {
    if (
      git(["init", "--quiet", "--bare", "--template=", "--object-format=sha1"])
        .status !== 0
    ) {
      throw new SubmitError(
        "git_init_failed",
        "Could not prepare the temporary Git push.",
      );
    }
    const ref = "refs/heads/" + branch;
    if (
      git(
        [
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          "--no-follow-tags",
          "--force-with-lease=" + ref + ":",
          fork + ".git",
          submission.head + ":" + ref,
        ],
        submission.objects,
      ).status !== 0
    ) {
      throw new SubmitError(
        "connector_push_failed",
        "Git did not confirm the push to your fork. Check write access and retry the same submission.",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const pullNumber = z.number().int().positive();
const pullSchema = z.object({
  number: pullNumber,
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  user: z.object({ login: loginSchema }),
  head: z.object({ sha: z.string(), label: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** Preview or submit a connector update under the builder's GitHub account. */
export function submitConnectorPr(
  submission: Submission,
  confirmation?: string,
) {
  const env = githubEnvironment();
  const login = githubLogin(env);
  const fork = "https://github.com/" + login + "/data-connectors";
  const branch = "vana/connector-" + submission.head;
  const headRef = login + ":" + branch;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        login,
        fork,
        branch,
        target: connectorPrTarget,
        base: submission.base,
        head: submission.head,
        baseBranch: submission.baseBranch,
        title: submission.title,
        body: submission.prBody,
        diff: submission.diff,
        draft: true,
      }),
    )
    .digest("hex");

  if (confirmation === undefined) {
    return {
      kind: "confirmation_required" as const,
      login,
      fork,
      branch,
      confirmation: digest,
    };
  }
  if (confirmation !== digest) {
    throw new SubmitError(
      "confirmation_mismatch",
      "The GitHub account or submission changed. Review the preview again before confirming.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }

  // Pin this operation to the reviewed login even if gh's active user
  // changes during the push. The token stays in subprocess pipes and env.
  const credential = gh(env, [
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    login,
  ]);
  const token = credential.stdout?.trim();
  if (credential.status !== 0 || !token) {
    throw new SubmitError(
      "github_sign_in_required",
      "Could not use the confirmed GitHub account. Sign in again with gh auth login --hostname github.com.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }
  const authenticated = { ...env, GH_TOKEN: token };
  if (githubLogin(authenticated) !== login) {
    throw new SubmitError(
      "github_account_changed",
      "The GitHub account changed. Review the preview again.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }

  const pulls = "repos/" + repository + "/pulls";
  const lookup =
    pulls +
    "?" +
    new URLSearchParams({
      state: "all",
      head: headRef,
      base: submission.baseBranch,
    });
  const receipt = (pr: z.infer<typeof pullSchema>, reused: boolean) => {
    if (
      pr.user.login !== login ||
      pr.head.label !== headRef ||
      pr.head.sha !== submission.head ||
      pr.base.ref !== submission.baseBranch ||
      pr.html_url !== connectorPrTarget + "/pull/" + pr.number
    ) {
      throw new SubmitError(
        "existing_pull_request_changed",
        "The GitHub PR for this branch differs from the reviewed submission. Check it on GitHub before trying again.",
      );
    }
    return {
      kind: "pull_request" as const,
      repository,
      login,
      number: pr.number,
      url: pr.html_url,
      state: pr.merged_at ? "merged" : pr.state,
      draft: pr.draft,
      reused,
    };
  };
  const findExisting = () => {
    const [pr] = z
      .array(z.object({ number: pullNumber }))
      .parse(api(authenticated, lookup));
    if (!pr) return undefined;
    return receipt(
      pullSchema.parse(api(authenticated, pulls + "/" + pr.number)),
      true,
    );
  };

  // A prior attempt may have created the PR and lost its response. Resolve
  // the stable branch before any push or create so retry can stay read-only.
  const existing = findExisting();
  if (existing) return existing;

  const forkResponse = gh(authenticated, [
    "api",
    "--hostname",
    "github.com",
    "repos/" + login + "/data-connectors",
  ]);
  const forkDetails = z
    .object({
      full_name: z.string(),
      private: z.literal(false),
      parent: z.object({ full_name: z.string() }),
      permissions: z.object({ push: z.literal(true) }),
    })
    .safeParse(
      forkResponse.status === 0 ? JSON.parse(forkResponse.stdout) : null,
    );
  if (
    !forkDetails.success ||
    forkDetails.data.full_name.toLowerCase() !==
      (login + "/data-connectors").toLowerCase() ||
    forkDetails.data.parent.full_name.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new SubmitError(
      "github_fork_required",
      "A writable public fork under your GitHub account is required. Fork PDP-Connect/data-connectors on GitHub, then retry.",
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  }
  const base = z
    .object({ object: z.object({ sha: z.string() }) })
    .parse(
      api(
        authenticated,
        "repos/" + repository + "/git/ref/heads/" + submission.baseBranch,
      ),
    );
  if (base.object.sha !== submission.base) {
    throw new SubmitError(
      "upstream_base_changed",
      "PDP-Connect main changed. Rebase the connector commit, refresh its evidence, and review the new submission.",
    );
  }

  pushCommit(authenticated, submission, fork, branch);
  try {
    const pr = pullSchema.parse(
      api(authenticated, pulls, {
        title: submission.title,
        body: submission.prBody,
        base: submission.baseBranch,
        head: headRef,
        draft: true,
      }),
    );
    return receipt(pr, false);
  } catch {
    // GitHub may have created the PR before the response was lost. The same
    // branch lets a fresh invocation recover too, even if this lookup fails.
    const recovered = findExisting();
    if (recovered) return recovered;
    throw new SubmitError(
      "pull_request_unconfirmed",
      "The branch was pushed. GitHub did not confirm a PR. Retry the same submission to recover it.",
    );
  }
}
