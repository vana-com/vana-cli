/** Offline instructions compiled into npm and standalone Vana distributions. */
export const CONNECTOR_BUILD_INSTRUCTIONS = `Build a Collection Profile connector with the current agent

1. Select a real Node 24 runtime on macOS or Linux; Node 24.22.1 is recommended for Factory and the public data-connectors checkout (which requires Node >=24.15.0 <25). Ensure node --version reports that runtime and its bin directory is on PATH. Use an existing compatible checkout, or clone the public source and install its locked tools:
  git clone https://github.com/PDP-Connect/data-connectors.git /absolute/path/to/data-connectors
  cd /absolute/path/to/data-connectors
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
Read AUTHORING.md and docs/spec/collection-profile.md in that checkout before writing the connector. Factory needs the packages/polyfill-connectors layout, Git metadata and installed TypeScript, tsx and Biome inside the checkout. Do not link dependencies from another checkout. Factory supports synthetic or explicitly reviewed export evidence and declared API preparation. Browser preparation remains unsupported.
2. Use the configured Factory executable or an existing factory-build on PATH. If neither is available, install the public @vana/factory-core@0.0.5 release artifact for legacy test discovery. This needs no private Factory repository access, internal services or Factory account. Vana never installs or downloads Factory. The external executable supplies its own Node host, including when Vana runs on Node 22 or as a standalone binary.
  export VANA_FACTORY_TOOLS="\${VANA_HOME:-$HOME/.vana}/factory-tools"
  npm install --prefix "$VANA_FACTORY_TOOLS" --ignore-scripts --no-audit --no-fund https://github.com/vana-com/vana-cli/releases/download/v0.47.0/vana-factory-core-0.0.5.tgz
Artifact SHA256: 257a2af2e01471d9e9c5ea40017ad7eb24e3761377ff475d34e52004ba92efec.
  export VANA_FACTORY_BUILD="$VANA_FACTORY_TOOLS/node_modules/.bin/factory-build"
  "\${VANA_FACTORY_BUILD-factory-build}" capabilities --json
Use the installed executable's absolute path for the capability command if it is not on PATH. The PATH must select the real Node 24+ executable used by its shebang. Require protocolVersion 1, contextVersion 2, apiPreparationVersion 1 and supportedRoutes ["export", "api"]. Older context versions are incompatible.

3. Plan the connector's collection fixture before creating the job. Probe the configured Factory executable, or the one on PATH if VANA_FACTORY_BUILD is unset:
  "\${VANA_FACTORY_BUILD-factory-build}" capabilities --include-fixtures --json
If the probe reports fixtureTestsVersion 1, put a top-level "fixtureTests": ["collection.test.ts"] in the initial version 1 request. Use unique .test.ts basenames. Put each test directly in the connector directory. The files can be written after build, but their names are fixed for that job. Factory withholds connect unless every declared fixture runs a passing test and all checks pass.

Use the real connector entry point and synthetic provider responses. Assert the expected records and checkpoint behavior. The examples below declare a fixture and require a Factory that reports fixtureTestsVersion 1 on that probe. Older Factory builds support only discovery of existing tests. Use a compatible Factory when a named fixture must be enforced.

Use absolute checkout and evidence paths. Declare environment variable names only, never credential values or raw export contents.

{
  "version": 1,
  "source": {
    "id": "example-export",
    "displayName": "Example export",
    "access": { "kind": "export", "inputEnv": "EXAMPLE_EXPORT_PATH" }
  },
  "checkout": "/absolute/path/to/data-connectors",
  "connectorDirectory": "example_export",
  "manifestConnectorKey": "example-export",
  "goal": { "streams": [{ "name": "items", "description": "Exported items" }] },
  "fixtureTests": ["collection.test.ts"],
  "evidence": [{ "path": "/absolute/path/to/synthetic-export.json", "audience": "synthetic" }]
}

Directory and manifest keys must be lowercase and match after replacing underscores with hyphens. The source ID is independent. Requested streams remain fixed for the job.

For an API, declare a source-general preparation plan. This example uses entirely synthetic local documentation and responses, so prepare requires no credential values:

{
  "version": 1,
  "source": {
    "id": "example-inventory",
    "displayName": "Example inventory",
    "access": {
      "kind": "api",
      "documentation": ["https://docs.example.test/inventory"],
      "authEnvironmentNames": ["EXAMPLE_API_TOKEN"],
      "preparation": {
        "origin": "https://api.example.test",
        "auth": { "kind": "authorization", "scheme": "Token", "environmentName": "EXAMPLE_API_TOKEN" },
        "research": [{
          "name": "inventory-docs",
          "url": "https://docs.example.test/inventory",
          "input": { "kind": "supplied", "path": "/absolute/path/to/synthetic-api-docs.md", "audience": "synthetic" }
        }],
        "samples": [{
          "name": "inventory",
          "streams": ["items"],
          "input": { "kind": "supplied", "path": "/absolute/path/to/synthetic-inventory.json", "audience": "synthetic" }
        }],
        "disclosure": {
          "fields": ["$.items", "$.items[].id", "$.items[].name", "$.nextCursor"],
          "tokens": []
        }
      }
    }
  },
  "checkout": "/absolute/path/to/data-connectors",
  "connectorDirectory": "example_inventory",
  "manifestConnectorKey": "example-inventory",
  "goal": { "streams": [{ "name": "items", "description": "Inventory items" }] },
  "fixtureTests": ["collection.test.ts"],
  "evidence": []
}

For explicit acquisition, use research input { "kind": "fetch" } and sample input { "kind": "get", "path": "/items" }. Then run the returned prepare action with the declared environment names available. Auth may be none, a named header with environmentName, or authorization with Bearer or Token. Names must agree with authEnvironmentNames. Never put credential values in the request. GET stays within the declared origin. Only explicit loopback HTTP origins are allowed for local development. Redirects, query strings, automatic retries, pagination, request bodies and arbitrary headers are unsupported. Research fetches public documentation without auth. Supplied inputs must be synthetic or explicitly reviewed.

Declare only reviewed structural JSON field paths starting with $, and string or boolean tokens in disclosure. Use [] for each array level. Every other scalar is invented and undeclared keys are masked. Prepared fixtures require review before publication. Caller classification and safe projection do not certify publication or live readiness.

4. Run vana connectors build --request /absolute/path/to/request.json --json. Factory creates one explicit job and a private workFile before API preparation. Build does not acquire API evidence. For an API, read the workFile and run actions.prepare.argv for the same UUID and state directory. A declared fetch or GET input plus explicit prepare authorizes that bounded acquisition. No extra network flag or approval is needed. Missing files or auth references preserve the UUID. Supply them and run prepare again. A successful repeated prepare verifies accepted artifacts without network. Changed accepted inputs or artifacts require a new job.

Read the prepared workFile and its safe api.md, research, profile and fixture pointers. Raw captures remain private and are not linked in the work package. Distinguish documentation claims, observed safe shapes and unresolved auth, pagination, termination, rate-limit and stream questions. Implement the connector in the named checkout. The current agent writes and repairs the code. No model, agent service, collection or registration is started.

Factory validates manifest stream schemas with type, properties, required, items, enum, format: date-time, minLength and boolean additionalProperties. Keep upstream x_pdpp_role display annotations intact. If an installed Factory rejects them, repair it or use a compatible local Factory. Other schema assertions need explicit unsupported handling; do not remove constraints to obtain a pass. A Factory-backed job must retain --factory-job and --factory-state-dir through final collection. A blocked verification is an incomplete job; omitting those flags does not verify it.
5. Run the returned check argv after editing. Repair failures and repeat check for the same UUID and state directory. Use the returned resume argv to refresh instructions. Resume and check never acquire or re-sample API evidence. API check before successful preparation returns agent_work with reason prepare. Use prepare after supplying API prerequisites. Never substitute a latest-job lookup or change the job's immutable request. Create a new request/job when the source, access, goal, fixture tests or evidence declaration changes.
6. A checks_passed result covers static_and_fixture checks only. Live verification is pending and ingestion is not_run. Only a passing result offers an explicit local vana connect command with the exact directory spelling, checkout, streams, --factory-job and --factory-state-dir. That opt-in action requires a compatible Factory before provider launch, verifies the actual Vana run before saving results or checkpoints, and admits only the accepted exact bytes to ingestion. Failed verification keeps previous data. Failed ingestion keeps verified local bytes for vana server sync without recollection or source rechecks. Ingestion and server readback remain separate facts; no body readback is performed. Supply the required environment names from collectionContext.access separately when using it. Export access names its input variable. API access names its auth variables. Continue the original authorized collection request using that command; ask only for missing account, scope, authentication or a blocked decision. It may require account, server and export access. Registration is also separate and trusts unsigned local code.

Commands
  vana connectors build --instructions --json
  vana connectors build --request /absolute/path/to/request.json --json
  vana connectors prepare --job <uuid> --state-dir /absolute/path/to/state --json
  vana connectors check --job <uuid> --state-dir /absolute/path/to/state --json
  vana connectors resume --job <uuid> --state-dir /absolute/path/to/state --json

State defaults to a dedicated factory directory under VANA_HOME (otherwise ~/.vana). Follow-up commands always name the canonical state directory returned by Factory. Global --quiet hides progress only. --detach is unsupported. --yes, --no-input, --ipc and --network do not expand access or modify a job's context.

SIGINT and SIGTERM request graceful cancellation and wait for Factory to stop preparation or reap its checks and release the job lock. The interrupted invocation fails. A later explicit resume can continue agent work. SIGKILL cannot clean up; follow Factory's manual lock-recovery guidance before resuming.
`;
