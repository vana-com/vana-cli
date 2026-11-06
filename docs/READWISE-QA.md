# Readwise stored-data QA runbook

This Dev test checks whether a fresh app can get its first grant and read
Readwise highlights already stored on the Dev QA account. The CLI test
operator owns the setup, browser handoffs, and evidence. Update this runbook
when the launch configuration, browser handoff, or approval flow changes.

## Print the preflight table before every run

Fill in each row from the actual tools and sessions for **this** run. Print
the complete table to Callum before sending the replay prompt, even on a
retry. The operator verifies that the launcher and build are correct.
Callum confirms whether to start the run after reviewing the results.

| Check          | What to print                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude session | Workspace, sandbox and permission mode, and the preflight session that proved them.                                                                                        |
| CLI            | Exact absolute path from `command -v vana` **inside Claude**, target executable or script if it is a wrapper, `vana --version`, and build revision or artifact identifier. |
| CLI login      | Account origin, wallet, environment and network from the selected CLI. Use `vana status --json` to verify the session.                                                     |
| Chrome login   | The Dev Web tab URL and the Dev Account window URL, plus the email and wallet actually shown in regular Chrome. Verify that the account matches the CLI.                   |
| Claude skill   | Name, absolute source path, and evidence of the skill Claude actually loaded. Check the tool trace in a separate preflight chat.                                           |
| Popup          | In the same regular Chrome profile, record a user-gesture popup opening to Dev Account and the account shown inside it. Report what the test exercised.                    |
| Data           | Personal Server URL, inventory source, and the exact stored scope returned by `vana server data --json`.                                                                   |
| Decision       | Ready or blocked, with any failed check. Wait for Callum's explicit go-ahead before starting the replay.                                                                   |

## Prepare the CLI and Claude workspace

- Select a fresh workspace and isolate its `VANA_HOME` from other CLI runs.
  Pin the workspace launcher and its build. Use Dev Account, Dev Web, and
  Moksha (chain 14800). Record the workspace and any preflight evidence
  separately from the Claude acceptance chat.
- Use the enrolled Dev QA account. Verify the CLI's account origin, wallet,
  and Personal Server. If login is needed, follow the existing Dev QA account
  procedure in the adjacent Unity Surfaces checkout at
  `docs/agents/account-qa.md`. Keep device codes and session credentials
  out of the table, chat, and repo.
- Use a separate Claude Code preflight chat in the same workspace and mode
  as the replay. Load the intended builder skill and run `command -v vana`,
  `vana --version`, and `vana server data --json` as separate commands.
  The inventory is metadata only. Verify `source: "remote"` and
  `readwise.kindle_highlights` for the enrolled QA data.
- Compare the actual loaded skill to the intended version. Inspecting the
  CLI bundle alone missed an older personal Claude skill in a previous run.
  For the prepared local candidate, the intended project skill is
  `vana-builder-candidate`. A denied inventory, incorrect scope, stale
  skill, or unexpected CLI path blocks the replay.
- Verify sandboxed Auto and the absence of an app key, request, and viewer
  cache. Start the acceptance prompt in a fresh chat after approval. The
  preflight can verify the configured skill. The replay must independently
  show which skill and CLI it uses.

## Verify regular Chrome

Use the actual external Chrome profile that will handle both browser steps.
The embedded Claude browser cannot handle the required popup in this test.
Check the account on both [Dev Web Account settings](https://app-dev.vana.org/settings/account)
and [Dev Account](https://account-dev.vana.org/). Opening a Dev URL does
not switch the account. The QA browser wallet and CLI wallet must match.

Test a real popup in that Chrome profile before asking for the go-ahead.
A safe preflight uses a local page with a visible button that calls
`window.open` to Dev Account from a click. Verify a separate popup window
opens and displays the same signed-in QA account. A normal link opening a
new tab checks navigation. A popup smoke test checks browser behavior, and
the actual claim and consent are checked during the replay.

Recheck the identity in the actual Chrome tab immediately before the claim
and again before Web consent. Check the app and the exact requested scope
against the CLI output. Stop on a mismatch, sign-in prompt, or manual
funding screen. Keep claim URLs and request identifiers in private evidence.

## Run after Callum approves

Paste only this as the first message in the fresh Claude Code chat:

> Use Vana to build a small app where I can browse and search the Readwise highlights I’ve already collected.
>
> Use regular Google Chrome for all browser steps, including sign-in, app claim, and Vana approval, so popups work. Leave Claude’s built-in browser closed. In Chrome, use the same Vana account that the CLI is signed into. Let me approve access in Chrome, then show me the app working and check that my highlights are still there after I reload.

When Callum needs to sign in, claim the app, or approve access, Claude
should lead its next message with the clickable URL for that step. Use the
complete URL the CLI returned. In one sentence, name the action, the verified
Dev QA account to use in regular Chrome, and when to tell Claude it is done.
Give the link immediately, even if Claude can also open the page. A Chrome
extension timeout does not block Callum from opening the link himself.
After he acts, verify the result in the CLI before continuing. Record whether
Claude offered the link before Callum had to ask. Keep signed links out of
shared logs and docs.

Observe the app registration, **App added** in Dev Account, automatic Moksha
test credit, and the separate consent screen in Dev Web. **App added** records
ownership. **Grant access** is the data authorization. Follow the grant with a
fresh payment-free app read, browse and search checks, and a reload that
still shows the data. Record each result separately.

Check the original Dev Web consent tab as well. After the app saves and shows
the highlights, it must acknowledge delivery for the same request with the
original app key. Verify that consent finishes and returns to the shelf.
`Waiting for app` after the shelf shows data is a delivery confirmation
failure even if the grant and read passed. Retry confirmation against the
saved result without reading again.

Stop at the first failed handoff or after 15 minutes. Record the exact
boundary, error, environment, build, and request ID in the run evidence.
A read asking for payment is a failed replay. This test reuses stored data.
A fresh provider collection or production first run needs its own evidence.

## Focused consent retest

To check only the consent handoff, reuse the Claude conversation and app
identity. Use a separate empty viewer store and create a fresh Dev/Moksha
request for the same stored scope. Run the same preflight and wait for
Callum's go-ahead. If the patch is on localhost, record that the preview
uses Dev services and verify its own Chrome session before giving Callum
the preview's consent link.

Keep the original consent tab open after approval. It should show
**Approved** with a green check in the source row and offer a primary return
button while the app reads. Leave the
return link alone for this check. After the app saves and displays the
payment-free result and acknowledges that request, verify the same tab
navigates to the shelf with `status=completed`. Browse, search and reload
the shelf that was populated during the retest. A focused retest proves
the handoff. The verbatim prompt in a fresh session is the full replay.

## Readwise Dev consent handoff

- 6 November: Web consent fix [#2176](https://github.com/vana-com/unity-surfaces/pull/2176) merged into `dev` at `969d0e2`. Vercel verified that commit is ready and serves `app-dev.vana.org`. Callum asked for the full verbatim prompt in a fresh Claude chat after preflight and will handle Chrome actions. The run is waiting for Dev QA Personal Server owner confirmation and the fresh CLI sign-in. The CLI repository's Readwise QA runbook owns preflight and pass criteria. Keep the hosted request and existing shelf as before-state evidence.
- 6 November: Callum handed the Chrome preflight clicks to the operator. The restored Dev QA server on port 8084, the isolated CLI, Dev Account, Dev Web, and the real Chrome popup all matched the Maloney QA wallet. Claude's separate sandboxed Auto preflight `f6a41dd5-4280-4bfe-91b4-c37a444fda1d` loaded the project Builder skill, resolved the pinned CLI 0.48.4, and found `readwise.kindle_highlights` in the remote inventory. The fresh replay composer is blank pending the preflight readout and go-ahead.
- 6 November: After Callum's go-ahead, sent the exact runbook prompt in fresh Claude session `6566594f-dd4a-43a6-9be5-36f7573405ed`. Claude found the right scope and built a fresh shelf on 4377. Operator clicked claim, resumed the same setup through automatic Moksha test credit, and opened the original approval tab. Dev blocked approval with `server_selection_required`: the owner has multiple verified servers and the CLI's returned link lacked `server_address`. A separate read-only tab with the healthy QA server selected showed an enabled Grant access button. Original tab preserved; no grant, data read, payment, consent return, or browser feature proof. The next fix is to have the CLI-generated own-app link carry the selected verified server when it knows it, with a choice in consent when it does not.
- 6 November: Callum authorized both fixes, Dev delivery, a fresh verbatim Claude replay, and operator Chrome clicks. CLI [#127](https://github.com/vana-com/vana-cli/pull/127) merged into its `dev` branch at `374136d` with all CI green. The isolated 0.48.4 replay candidate is built at `/private/tmp/vana-readwise-selected-candidate` because CLI `dev` does not publish a binary and predates the replay's delivery command. Unity [#2182](https://github.com/vana-com/unity-surfaces/pull/2182) adds the consent picker, retry selection, and fixes a signed poll/ack 404 for the same wallet stored with different casing. Both address tests failed with the old comparison and pass with the fix. Claude's separate Auto preflight `468e4619-3a0b-438a-847f-ca94cf76e149` passed in `/private/tmp/readwise-dev-selected-replay`. Chrome account and popup matched the existing QA server and only QA authentication was carried to the new workspace. The replay prompt is unsent pending the live Web deployment.
- 6 November: [#2182](https://github.com/vana-com/unity-surfaces/pull/2182) is live on `app-dev.vana.org` at `c5cc913`. The earlier unpinned link showed both verified servers and selecting the QA server enabled Grant access without approving it. In fresh Claude session `2bf922e5-b5a2-446f-ba36-8586fb7ce162`, the verbatim prompt built the shelf on 4519 and the CLI-generated link pinned the verified QA server. The operator claimed and approved in regular Chrome. Dev returned completed and redirected the original consent tab to the shelf after the app acknowledged delivery. The app requires paid:false before saving, and saved eight distinct highlights. Chrome selected the only available book, narrowed eight records to one, and restored the same search and exact records after reload. A separate shell re-read returned server_unavailable, including with the selected server pinned, although its tunnel reported healthy. Keep this distinction separate from the successful original app read and cached reload.
