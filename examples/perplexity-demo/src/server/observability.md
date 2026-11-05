# Local Research Shelf observations

Owner: the Research Shelf example. Update this contract when event fields, probes
or consumer delivery boundaries change.

The sink is opt-in. Set all four server-only variables:

- `VANA_SHELF_OBSERVABILITY_FILE` selects an absolute local JSONL path.
- `VANA_SHELF_OBSERVABILITY_RUN` is a UUID identifying this verification run.
- `VANA_SHELF_OBSERVABILITY_MODE` is `controlled` or `live`.
- `VANA_SHELF_OBSERVABILITY_SALT` is 64 hexadecimal characters shared only by
  this run's participating observers.

Missing or invalid settings disable the sink. There is no network exporter in the
app. The verifier owns local Motel export/query and collector lifecycle. Local
observation failures never change saving, payment authorization or acknowledgement.
Missing observations therefore remain unknown, not evidence that an action did
not occur.

Each JSONL row carries schema version 1, timestamp, event/run/attempt UUIDs,
observer, boundary, stage and outcome. Only declared reasons, HTTP statuses,
counts and durations are accepted. Raw request, grant and revision identifiers
become 20-character keyed aliases. Input payloads, titles, account identity,
URLs, credentials, cookies, payment headers and error text are not copied.
The TypeScript module owns the exact field and enum contract.

Read and payload-save observations share one operation attempt. Acknowledgement
is a separate attempt linked through request, grant and revision aliases. Initial
connection-metadata saving has no revision alias and is not delivered data.
Browser-render evidence is supplied by the verifier's actual DOM observation.

`observer: research-shelf` at the `personal-server` or `approval` boundary means
this app observed its client call. It does not claim instrumentation inside the
remote service. A payment HTTP success is an observed transmission outcome, not
chain settlement. Controlled service responses and live service events retain
different evidence modes.
