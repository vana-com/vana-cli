# Private connector handoff to Desktop (local implementation)

This same-Mac development path packages a new Collection Profile connector
through the public data-connectors artifact builder. It does not publish, upload,
sign or approve the connector. It requires the matching Desktop implementation;
released Desktop versions without this capability cannot import the handoff.

Author and check the connector with the existing Factory workflow first:

```sh
vana connectors build --instructions
vana connectors check --job <factory-job-id> --state-dir <factory-state-dir> --json
```

Use a current public `PDP-Connect/data-connectors` checkout with its locked tools
installed, a real Node 24 executable, and GNU tar. On macOS the CLI discovers
`gtar` and supplies it to the unchanged upstream builder through a temporary PATH
entry. BSD tar is rejected. The command never installs tools or changes the
upstream checkout.

Sign in to the intended Vana account with `vana login`. Package a new source name
and the intended streams explicitly. The profile's `connector_key` stays in
kebab case, while the final path segment of `source.id` and selected stream names
must form SDK scopes using lowercase letters, digits and underscores (for example
`desktop_synthetic.items`). The CLI refuses incompatible names without rewriting
them.

In this example, the checkout directory is `connectors/my_source/`, the manifest
has `connector_key: "my-source"`, and `source.id` ends in `/my_source`. Pass the
directory name `my_source` to the command: the public upstream builder requires
letters, digits and underscores in directory names.

```sh
VANA_ENV=dev vana connectors desktop my_source \
  --from /absolute/path/to/data-connectors \
  --streams items,profile \
  --node /absolute/path/to/node24 \
  --network moksha --json --no-input
```

The result contains `handoffId`, `artifactDigest`, selected streams, exact
`sourceId` and full `scopes` derived from the frozen profile (for example
`desktop_synthetic.items`), Account context, exact `handoffPath`, `openUrl`, and
context-preserving status/resume argv.
Pending approval returns exit 7. JSON, IPC and `--no-input` never open Desktop or
approve anything. For an interactive review add `--open` without those flags, or
open the returned `vana-dev://development-connector?id=...` link (`vana://` for
production). The person reviews and enables the Development connector in Desktop.
An explicit interactive `desktop-resume <handoff-id> --open` also reopens an
already enabled snapshot for management, including disable/remove. Reopening does
not activate it again.

```sh
VANA_ENV=dev vana connectors desktop-status <handoff-id> --network moksha --json
VANA_ENV=dev vana connectors desktop-resume <handoff-id> --network moksha --open
```

Status and resume verify every saved payload byte and require the same current
owner, Account authority, service environment and network. They do not rebuild,
activate or recollect. Repeat packaging after edits: unchanged bytes and context
reuse the same ID; changed bytes or context create a new ID. Desktop owns approval,
update activation, disable and removal. An `enabled` result proves only that
Desktop reported this digest enabled; collection, Personal Server storage and
consumer delivery require their own checks.

## Use the connector in your app

After the CLI prepares the snapshot, Desktop Sources discovers it for the same Account and network even if no link was opened. The CLI link is a shortcut to the same review:

1. In the matching Desktop build, open **Sources → Ready to review → Review**, or use the CLI link. Review the connector's version and imported data; network, scopes and its code fingerprint are in Technical details. **Later** leaves it available in Sources without enabling it.
2. Choose **Enable and import** and finish the source's normal setup. Import progress appears in Sources; only this Account and network can run the connector. If enable succeeds but import cannot start, **Retry import** retries collection without repeating activation.
3. Start the Vana request from your consuming app for the exact scope, such as `my_source.items`. Keep Desktop and its registered Personal Server running. Approve the request in Vana, confirm the Account owner-read prompt, and return to the same app/browser session.
4. Read and save the response in the app before acknowledging the request. The approval page returns to the app after acknowledgement. An enabled snapshot alone does not prove that data was imported or delivered.
5. After editing the connector, repeat packaging. Sources shows **Review update** on the existing source row with the active and proposed versions. Choose **Update and import**, then refresh the app through its existing still-valid grant. A public connector release is not required between edits.

For this release candidate the verified service path is Account dev and Moksha on the same Mac. Use `VANA_ENV=dev` consistently for login, handoff and resume, and select Moksha in Desktop. The CLI release must include `vana connectors desktop --help`; released 0.48.2 alone does not contain this new command. The first public CLI/Desktop version pair must be recorded in the release notes when those artifacts are published. Mainnet release acceptance remains gated on the production Account schema rollout and the fee-eligible server runtime.

## Recover without replacing your identity

- Pending approval (exit 7): open the returned link, review and enable the snapshot. `desktop-status` reports Desktop's current receipt.
- Wrong Account or network: select the intended context and repeat status/resume. Do not generate another app key or change Accounts to work around a refusal.
- Changed code: package it again. A changed digest requires explicit approval; the old enabled version remains until the new snapshot is enabled.
- Data unavailable: keep the registered Personal Server running and use the approval page's Try again action. A stale test-app/browser connection is app-owned state; preserve or explicitly clear it there, rather than changing the grant or collecting unrelated sources.
- App return: use the same browser session so the app can recover its saved request. If the app already saved data, retry acknowledgement without repeating collection or the read.

## Frozen transport

The shared fixed inbox is `~/.vana/desktop-handoffs/<32-lowercase-hex-id>/`, under
the normal macOS home. `VANA_HOME` still selects CLI authentication state; it does
not relocate this inbox because Desktop must find it independently. Handoffs stay
there for inspection and resume. Do not remove an in-flight handoff.

`handoff.json` is a strict schema version 1 descriptor with `handoffId`,
`ownerAddress`, canonical `accountUrl`, `environment` (`dev`/`prod`), `network`,
`connectorId`, `version`, selected `streams`, `artifactDigest` and `files`.
Each file record contains a POSIX relative `path`, `sha256` prefixed digest and
byte `size`. Records are sorted by path. The artifact digest is SHA256 of their
UTF-8 concatenation:

```text
<path>\0<sha256:hex>\0<size>\n
```

`payload/` contains exactly `collection-profile.json`, `code.tar.gz`,
`licenses.tar.gz`, `source-declaration.json`, `provenance.json`, `config.json`,
`layers.json`, and optional `assets.tar.gz`. The upstream tool bundles the shared
runtime; copying the connector source directory would omit required code.
Symlinks, extra payload files, missing layers and changed bytes are refused.
Payload files are limited to 128 MiB each and 256 MiB combined.
The digest establishes integrity, not public review or a new process sandbox.

Only PATH, normal HOME and temporary-directory location reach the packaging
child. Provider environment values, app keys, browser endpoints, raw captures and
`.env` files are not copied from the checkout. Declare credential environment
**names** in the profile; supply their values through Desktop's existing setup.
The compiled connector and manifest must themselves be safe to distribute: this
command cannot recognize a secret deliberately embedded in source code.

Desktop derives runtime, setup, source and stream contracts from the verified
payload. It refuses protected-source collisions and unsupported capabilities;
this slice does not replace public connector methods. Standard dev/production
Account authorities are supported; custom Account services are refused.

The verified Account user, owner address, Account authority and service
environment reserve each private connector and source name on this Mac.
The same Account can repeat packaging with `--network mainnet` after Moksha,
keeping its connector ID and scope. Open the matching network in Desktop and
explicitly approve that network’s snapshot. Each network keeps its own enabled
version, declaration, import progress and setup. Removing an admission retains
its name reservation. Another Account or a second method cannot claim the source.

`status.json`, written by Desktop beside the descriptor, contains only
`schemaVersion`, `handoffId`, `state` (`pending`, `enabled`, `disabled`, `removed`,
`failed`), `connectorId`, `artifactDigest`, `code` and optional `remedy`.
Missing status means approval is pending. Identity/digest mismatches fail closed.

No personal provider data, credentials, payment, consent, remote registry,
Mobile distribution or service configuration is part of packaging.
