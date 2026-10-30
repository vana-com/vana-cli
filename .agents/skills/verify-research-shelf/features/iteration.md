# Iterate through the same grant

## Sub-features

- Keep app, owner, network, scope, server and valid grant fixed.
- Fetch changed content through Read latest after initial completion.
- Preserve record identity and prove a changed saved revision and DOM value.
- Acknowledge after render and retain changes after reload and restart.

## How to get to it (user POV)

Start from a saved, displayed and acknowledged connection. After changed data is
available to the server, choose **Read latest**.

## Driving it with the verifier

The ordinary controlled command changes the fixture server's record and drives
**Read latest** in the real app. Require the same grant, no second consent
creation, changed durable content, matching DOM content and acknowledgement.

Live acceptance changes actual code in an isolated copy of the existing
Perplexity connector, reruns collection, and proves ingestion before app refresh.
Follow [the live procedure](../references/live-acceptance.md) and record each
stage's duration separately.

## Gotchas

Changed fixtures prove consumer refresh, not connector execution or ingestion.
Editing exported JSON or the app's saved store is not live iteration. The current
trigger requires rerun and **Read latest**. No automatic update or latency target
is inferred. Revoked access must preserve the saved list and require review.
