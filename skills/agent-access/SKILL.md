---
name: agent-access
description: >
  Give your own agent (OpenClaw or Hermes Agent today, more to come) its
  own identity, scoped and paid access to your data, and a way to cut it
  off. Use when: (1) the user says "give my agent access", "let OpenClaw
  read my data", "connect Hermes to Vana", "set up an agent in a sandbox
  with Vana", (2) an agent the user runs should see some of their data but
  not act as them. This skill is the owner's side. The agent itself uses the
  builder skill. For collecting data, use connect-data.
---

# Agent Access

Reading your own data is free, because you are the owner. An agent you
run should not act as you. This skill sets it up as **its own app**:

- it sees only the scopes the owner approves
- every read it makes is logged against its grant and paid from its own
  escrow
- the owner can revoke it, and its next read is refused

Two roles, often on two machines:

| Role  | Who                         | Holds                                    |
| ----- | --------------------------- | ---------------------------------------- |
| Owner | the person whose data it is | their Vana login and Personal Server     |
| Agent | the agent the user picks    | its own app key and escrow, nothing else |

Never give the agent the owner's login. Do not copy `~/.vana` from the
owner's machine to the agent's.

## First, ask which agent

Before running anything, ask the user which agent they want to give
access to, and wait for the answer. If they already named OpenClaw or
Hermes Agent, confirm it instead of asking again.

1. **OpenClaw** ([openclaw.ai](https://openclaw.ai))
2. **Hermes Agent** by Nous Research
   ([hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com))

Tell them that more agents will be supported. Vana is not tied to one
agent: every agent runs the same `vana` commands and follows the same
builder skill, and only installing the agent and loading the skill differ.

If they name another agent that can run shell commands, the Vana steps
below still apply. Say that this agent is not a documented path yet, then
in step 2 install the Vana CLI and the builder skill as usual and make
the skill visible to the agent: point its skills directory at
`~/.agents/skills`, or copy `~/.agents/skills/vana-builder` into the
directory its docs name. If it can't load `SKILL.md` skills at all, give
it the contents of `vana-builder/SKILL.md` as instructions.

In the same message, ask:

- which data the agent should see (for example GitHub or Spotify)
- whether it runs on this machine or in a sandbox (step 3)
- straight to mainnet (the default, real money) or testnet first (`--network moksha`)

## Stop for the human

These steps need the person. Say what they need to do, then wait:

1. logging in (`vana login` opens a browser)
2. connecting a source (`vana connect` can open a browser to sign in to
   it)
3. the first `vana server start`, which can ask them to confirm the
   install and to register the server in a browser
4. setting up the agent with a model provider key
5. funding the agent's escrow (real money on mainnet)
6. approving the agent's request (an approval URL)

## 1. Owner: data and a server the agent can reach

On the owner's machine:

```bash
npm install -g vana-cli             # or: npx vana-cli <command>
vana login
vana connect github                 # or any source from `vana sources`
vana server start --detach
vana server status --json
```

`server start` registers a public URL and keeps the Personal Server
running in the background. The agent reads through that URL, so it
answers only while the owner's machine is on. If the output says **local
only**, the tunnel or the registration failed and the agent cannot reach
the server; fix that before going on.

If `server start` or `server status` says the running server was started
by an earlier `vana` and must be restarted, do it:

```bash
vana server stop
vana server start --detach
```

## 2. Install the agent and load the builder skill

Follow the section for the agent the user picked.

### OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon     # asks for a model provider key
npm install -g vana-cli
vana skills install builder
```

OpenClaw loads skills from `~/.agents/skills`, where `vana skills install`
puts them, unless `OPENCLAW_STATE_DIR` moves its state elsewhere.

### Hermes Agent

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup                          # asks for a model provider
npm install -g vana-cli
vana skills install builder
```

Hermes Agent loads skills from `~/.hermes/skills`, not
`~/.agents/skills`. Add the shared directory to `~/.hermes/config.yaml`,
merging with any `skills:` section already there:

```yaml
skills:
  external_dirs:
    - ~/.agents/skills
```

Start a new Hermes session, then check that `builder` appears in
`hermes skills list`.

## 3. Choose where the agent runs

- **Same machine**: quickest to try. The agent runs as the owner's user, so
  it could still reach the owner's login and run owner commands such as
  `vana data show`. The grant limits what it asks for, not what it can
  reach.
- **Sandbox**: the grant becomes the boundary, because the agent holds
  only its app key. Use this for anything real. If the sandbox can be
  recreated, it loses the key `register` made in the last one, and the
  escrow funded to it. Give the agent a fixed key instead: generate it
  with `echo "0x$(openssl rand -hex 32)"`, keep it outside the sandbox,
  and pass it in as `VANA_APP_KEY`. Never mount the owner's `~/.vana`
  into the sandbox.
  - OpenClaw: repeat step 2 inside a container or cloud VM
    ([docs.openclaw.ai/install](https://docs.openclaw.ai/install)).
  - Hermes Agent: keep it on the owner's machine and set
    `terminal.backend` in `~/.hermes/config.yaml` to `docker`, `modal`,
    `daytona` or another sandbox backend, so its shell commands run
    there. The `vana` commands then run in the sandbox, so install the
    CLI inside it (the standalone installer needs no Node:
    `curl -fsSL https://raw.githubusercontent.com/vana-com/vana-cli/main/install/install.sh | sh`),
    and again whenever the sandbox is recreated. Save the fixed key as
    `VANA_APP_KEY` in `~/.hermes/.env` and forward it:

    ```yaml
    terminal:
      backend: docker
      env_passthrough:
        - VANA_APP_KEY
      docker_forward_env: # Docker backend only
        - VANA_APP_KEY
    ```

Step 4 runs wherever the agent's shell commands run.

## 4. Agent: identity

```bash
vana app register --app-url <url that identifies the agent>
vana app whoami --json
```

Use the agent's homepage as the URL, such as
`https://github.com/openclaw/openclaw` or
`https://github.com/NousResearch/hermes-agent`.

`register` uses `VANA_APP_KEY` when it is set; otherwise it creates an
app key separate from the owner's account, in the OS keychain where there
is one, or in `~/.vana/app-key.json`. It is safe to run again. To run
two agents on one machine, give each its own key through `VANA_APP_KEY`.
`whoami` prints the **app address**; the owner needs it to fund escrow.

## 5. Fund the agent's escrow (human step)

The simplest path for the person: open
[account.vana.org/developers](https://account.vana.org/developers),
choose **Fund escrow**, and enter the agent's app address. On mainnet
they deposit USDC.e and Vana sponsors the gas; on moksha they deposit
faucet VANA.

From the agent's own terminal instead, the agent's key pays the gas, so
its wallet needs VANA as well as the fee asset:

```bash
vana app escrow fund --amount 1 --json          # moksha: native VANA
vana app escrow fund --amount 5 --asset <USDC.e token address> --network mainnet --yes --json
```

The asset to fund is the one reads are priced in; a read without `--pay`
names it as `asset` in its exit-4 payload.

Then check:

```bash
vana app escrow balance --json
```

Fund small amounts. The agent can spend nothing beyond what escrow holds,
and `--max-fee` caps each read.

## 6. Grant: the agent asks, the owner approves

Ask for the data the user chose. `request` does not check scope names: a
wrong one still returns an approval URL, and fails only when the owner
opens it. Get the exact names on the owner's machine, after `vana
connect` has collected the source:

```bash
vana data show github --json    # data.requestedScopes lists the scopes
```

Then the agent runs:

```bash
vana app request --scopes github.repositories --no-input --json
```

That exits **7** with `approvalUrl`. Hand the URL to the owner. They sign
in, review the scopes and approve only what the task needs. The agent then
picks up the grant:

```bash
vana app requests show <request-id> --json
```

`<request-id>` is `data.requestId` from the request. `requests show`
exits 0 either way: until the owner approves, `data.status` is `pending`
and `data.grantId` is null. Once approved, `data.grantId` is the grant to
read with.

Keep requests to sources the Vana web app lists. A request that includes
a source it doesn't list cannot be approved on the web, and data from
local-only sources (such as Claude Code history) can't be granted this way.

## 7. The agent reads and pays

```bash
vana app read github.repositories --grant <grant-id> --pay --max-fee 0.05 --json
```

Without `--pay` it stops at exit **4** with the price. Every read is
charged, including a re-read of data that hasn't changed, so an agent that
reads on a schedule spends on every run. The owner's own reads stay free.

## 8. Review and revoke

In the Vana app, **Settings → Access history** lists each read the agent
made under its grant. **Revoke** ends its access: the Personal Server
refuses the next read and nothing is charged. To give access again, the
agent asks again.

## Networks

Everything defaults to **mainnet**, where fees are real USDC.e.
Grants, balances and server registrations do not carry across networks.
To try the whole flow on the testnet first, pass `--network moksha` on every
command (every `vana` command accepts it), `vana server start` included: an
agent reading on moksha cannot find a server registered only on mainnet.

## Failure notes

- Exit 5 on a read: the owner's Personal Server did not answer. Check
  `vana server status` on the owner's machine. A read refused after a
  revoke can also report exit 5 today; if the owner just revoked, treat it
  as final and ask again rather than retrying.
- Exit 4 with `--pay` set: `--max-fee` is below the price, or escrow is
  empty. The limit is in the fee's own asset (USDC.e on mainnet).
- Exit 7 from `request`: nobody has approved yet. Do not re-request in a
  loop; poll `requests show` at a human pace.
- The agent never runs `vana` commands: it did not load the builder
  skill. Recheck step 2 for the agent the user picked.
- `delivery: "enclave"` with `paid: false`: the owner serves this data
  from a TEE sandbox, which the gateway currently admits at zero price.
