# Vana CLI statecharts

[Source inventory and verifier entry points](STATE-MACHINE-INVENTORY.md)

Each TLC report records the state count and omitted steps that stay in the same label. Use the model owner’s README for exact bounds and excluded behavior.

To redraw a model, copy its model directory to scratch. Set the Pstack Statechart executable and select the TLA+ module, config, and view named in the proof owner.

```sh
$STATECHART "$scratch/$module.tla" --config "$scratch/$config.cfg" --view "$scratch/$view.mjs" --out "$(mktemp -d)/chart"
```

## Prepare to collect a source

Confirm an eligible Personal Server before collection. A late approval cannot authorize an obsolete owner.

```mermaid
---
title: "Prepare to collect into a Personal Server"
---
stateDiagram-v2
  s0: Checking the Vana account
  s1: Finding a Personal Server
  s2: Collection blocked
  s3: Sign in to Vana
  s4: Server belongs to another account
  s5: Preparing a Personal Server
  s6: Checking server access
  s7: Approve this CLI
  s8: Server access confirmed
  s9: Account changed during the access check
  s10: Ready to collect
  [*] --> s0
  s0 --> s1: Account identified
  s0 --> s2: No usable account
  s0 --> s3: Sign-in required
  s1 --> s4: Found another owner's server
  s1 --> s2: No usable server
  s1 --> s6: Found your server
  s1 --> s5: No server found
  s3 --> s1: Sign-in succeeds
  s3 --> s2: Sign-in fails
  s4 --> s2: Permission missing
  s4 --> s6: Person allows this server
  s5 --> s1: Try to find the prepared server
  s6 --> s2: Access unavailable
  s6 --> s8: Server accepts the CLI
  s6 --> s9: Account changes or Send access check
  s6 --> s7: Approval required
  s7 --> s2: Approval fails
  s7 --> s6: Person approves
  s8 --> s10: Admit collection
  s9 --> s2: Access unavailable or Retry with intended account
  s9 --> s7: Approval required
```

## Save collected data and retry upload

A late upload can settle only the generation it started with.

```mermaid
---
title: "Collect data and preserve the latest accepted export"
---
stateDiagram-v2
  s0: Collectors running without an accepted export
  s1: Accepted export recorded locally
  s2: Accepted export local. Upload pending
  s3: Accepted export remains local after an upload failure
  s4: Accepted export stored
  s5: Older response discarded. Newer export retained
  [*] --> s0
  s0 --> s1: Record the local export
  s1 --> s2: Upload to Personal Server
  s2 --> s1: Personal Server responds or Accept the newer export
  s1 --> s3: Record the upload result
  s1 --> s4: Record the upload result
  s3 --> s1: Accept the newer export
  s1 --> s5: Discard settlement for the older export
  s4 --> s1: Accept the newer export
  s2 --> s5: Discard settlement for the older export
  s3 --> s5: Discard settlement for the older export
  s4 --> s5: Discard settlement for the older export
```

## Switch accounts with an upload still pending

A foreign collection must leave the pending bytes and receipt with their owner.

```mermaid
---
title: "Collect data and preserve the latest accepted export"
---
stateDiagram-v2
  s0: Collectors running without an accepted export
  s1: Accepted export recorded locally
  s2: Accepted export local. Upload pending
  s3: Other account's export stays local
  s4: Accepted export remains local after an upload failure
  s5: Accepted export stored
  [*] --> s0
  s0 --> s1: Record the local export
  s1 --> s2: Upload to Personal Server
  s1 --> s3: Refuse to replace another account's export
  s2 --> s1: Personal Server responds
  s1 --> s4: Record the upload result
  s1 --> s5: Record the upload result
  s2 --> s3: Refuse to replace another account's export
  s4 --> s3: Refuse to replace another account's export
  s5 --> s1: Accept the newer export
```

## Set up a builder request and resume

Persist recovery identity, wait for usable credit, then create consent. The chart uses the small overview configuration.

```mermaid
---
title: "Setup resumes with the saved funding and consent identities"
---
stateDiagram-v2
  s0: New setup
  s1: Saving setup identity
  s2: Requesting funding with saved key
  s3: Funding pending
  s4: Saving funding result
  s5: Setup saved for resume
  s6: Checking resume context
  s7: Funding failed
  s8: Usable credit confirmed
  s9: Inspecting saved funding
  s10: Creating consent with saved key
  s11: Consent accepted remotely
  s12: Saving consent identity
  s13: Checking approval
  s14: Waiting for approval
  s15: Approval received
  s16: Denied or expired
  [*] --> s0
  s0 --> s1: start setup
  s1 --> s2: release journal writer lock
  s2 --> s3: send the saved funding key
  s3 --> s4: accept funding response
  s3 --> s5: lose the response after remote acceptance
  s5 --> s6: run saved resume command
  s6 --> s2: validate saved identity and options
  s2 --> s7: send the saved funding key
  s2 --> s8: send the saved funding key
  s4 --> s5: release journal writer lock
  s7 --> s4: accept funding response
  s7 --> s5: lose the response after remote acceptance
  s8 --> s4: accept funding response
  s8 --> s5: lose the response after remote acceptance
  s6 --> s9: validate saved identity and options
  s9 --> s3: GET the saved operation
  s9 --> s7: GET the saved operation
  s9 --> s8: GET the saved operation
  s4 --> s10: release journal writer lock
  s10 --> s11: send the saved consent payload
  s11 --> s5: lose the response after remote acceptance
  s11 --> s12: take journal writer lock
  s12 --> s13: release journal writer lock
  s13 --> s14: read approval result
  s13 --> s15: read approval result
  s13 --> s16: read approval result
```

## Recover an interrupted paid read

Reuse the saved payment identity and keep overlapping readers from paying again. The chart shows the single-reader profile.

```mermaid
---
title: "Paid-read recovery: one reader and overlapping readers"
---
stateDiagram-v2
  s0: Start or restart
  s1: Read lock held#59; loading saved receipt
  s2: Checking whether payment is needed
  s3: Preparing payment
  s4: Stopped for repair
  s5: Saving recovery receipt
  s6: Ready to send
  s7: Payment sent
  s8: Retrying saved payment
  s9: Charged#59; waiting for data
  s10: Data received
  [*] --> s0
  s0 --> s1: you reserve this read intent
  s1 --> s0: the CLI closes and you restart
  s1 --> s2: you open the saved payment state
  s2 --> s0: the CLI closes and you restart
  s2 --> s3: the server requests payment
  s3 --> s0: the CLI closes and you restart
  s3 --> s4: saving payment state fails
  s4 --> s0: the CLI closes and you restart
  s3 --> s5: you finish preparing the payment
  s5 --> s0: the CLI closes and you restart
  s5 --> s4: saving payment state fails
  s5 --> s6: the recovery receipt is saved
  s6 --> s0: the CLI closes and you restart
  s6 --> s7: you send the signed payment
  s1 --> s8: you open the saved payment state
  s7 --> s0: the CLI closes and you restart
  s7 --> s9: the fixture settles a distinct payment
  s8 --> s4: the server rejects the saved receipt
  s8 --> s6: you reuse the same saved header
  s9 --> s10: the data arrives
  s9 --> s0: the CLI closes and you restart
  s6 --> s9: you send the signed payment
```

## Register an app on mainnet

A matching confirmed Gateway read must precede Account association. Ownership confirmation clears the saved recovery context.

```mermaid
---
title: "Promote an existing app from Moksha to mainnet"
---
stateDiagram-v2
  s0: Ready to promote an owned app
  s1: App and Account verified
  s2: Recovery context ready
  s3: Mainnet record absent
  s4: Registration submitted
  s5: Waiting for mainnet confirmation
  s6: Stopped with recovery context
  s7: Account association ready
  s8: Waiting for Account association
  s9: Verifying Account ownership
  s10: App ready on mainnet
  [*] --> s0
  s0 --> s1: choose app and production URL
  s1 --> s2: save recovery context
  s2 --> s3: no registration found
  s3 --> s4: submit to the gateway
  s4 --> s5: registration reply arrives
  s4 --> s6: registration reply is lost
  s5 --> s6: confirmation times out or proof fails or names another app
  s6 --> s1: resume the original app
  s5 --> s7: matching confirmed proof arrives
  s7 --> s8: ask Account to associate the app
  s2 --> s5: use the visible registration
  s8 --> s6: Account association or ownership is unconfirmed
  s8 --> s9: Account accepts the association
  s9 --> s6: Account association or ownership is unconfirmed
  s9 --> s10: Account confirms ownership
```

## Stop a local server while it restarts

Current behavior. Stop during a pending restart port check can still start the replacement.

```mermaid
---
title: "Stop a local Personal Server during automatic restart"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: Breaks NoLaunchAfterStop
    lg1: Path to the NoLaunchAfterStop bug
  }
  class lg0 breaks
  class lg1 bugPath
  s0: Personal Server running
  s1: Waiting before retry
  s2: Stop requested during restart wait
  s3: Checking a port for restart
  s4: Personal Server stopped
  s5: Starting a replacement
  s6: Stop requested while restart checks a port
  s7: Personal Server restarted
  s8: Replacement starts after Stop
  s9: Restart reported after Stop
  s10: Replacement stopped again
  [*] --> s0
  s0 --> s1: Server exits unexpectedly
  s1 --> s2: You stop the server
  s1 --> s3: Restart wait settles
  s0 --> s4: Supervisor stops the server
  s2 --> s4: Restart wait settles
  s3 --> s5: Port check returns
  s3 --> s6: You stop the server
  s5 --> s7: Replacement answers
  s6 --> s8: Port check returns
  s8 --> s9: Replacement answers
  s7 --> s4: Supervisor stops the server
  s9 --> s10: Supervisor stops the server
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s1 bugPath
  class s3 bugPath
  class s6 bugPath
  class s8 breaks
  class s8 bugPath
  class s9 breaks
  class s10 breaks
```

## Delete a hosted server during provisioning

Current behavior. A delete that arrives before the provider returns removes the untracked row, and the create then removes what it made and answers 409. A delete that read the row before the handles were saved finds them on a second read and deprovisions them. A create killed at its time limit is not modelled.

```mermaid
---
title: "Delete a hosted server while provisioning is pending"
---
stateDiagram-v2
  s0: No hosted server
  s1: Server provisioning
  s2: Owner can see the provisioning record
  s3: Deletion sees no provider handles
  s4: Provisioned server is tracked
  s5: Record removed before provider finished
  s6: Server running
  s7: Cleaning up provider resources
  s8: Provider returned after deletion
  s9: Provider resources removed
  s10: Creation removed its resources after deletion
  s11: Server removed
  [*] --> s0
  s0 --> s1: start server creation
  s1 --> s2: owner lists servers
  s2 --> s3: owner deletes before handles exist
  s1 --> s4: try to store provider handles
  s3 --> s5: delete the server record
  s2 --> s4: try to store provider handles
  s4 --> s6: provider reports running
  s4 --> s7: owner requests deletion
  s3 --> s8: delete the server record
  s5 --> s8: provider creates the server
  s6 --> s7: owner requests deletion
  s7 --> s9: provider finishes cleanup
  s3 --> s7: delete finds handles saved after its read
  s8 --> s10: creation finds no record and removes its resources
  s9 --> s5: delete the server record
  s9 --> s11: delete the server record
  s5 --> s11: create returns success
```
