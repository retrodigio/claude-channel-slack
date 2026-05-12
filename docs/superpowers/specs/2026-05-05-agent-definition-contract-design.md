# Agent Definition Contract — Design Spec

**Date:** 2026-05-05
**Subsystem:** A (of four — see "Decomposition" below)
**Status:** Design approved; ready for implementation planning

---

## Decomposition

This spec is **subsystem A** of a four-part evolution of `claude-channel-slack`. The full picture:

- **A — Agent definition contract** ← this spec
- **B — Self-onboarding skill set** (depends on A)
- **D — Service-account model** (depends on A, B)
- **C — AWS deployment** (depends on A, B, D)

This order was chosen because A is the contract that everything else either produces or consumes. C designed before A would design infra around the current accidental shape of an agent. Each subsystem gets its own spec → plan → implementation cycle.

---

## Context

Today `claude-channel-slack` runs as a single Claude Code orchestrator session on a laptop. The orchestrator owns a Slack workspace connection and dispatches channel threads to per-thread subagents in routed repos. State (routes, threads, access, tokens) lives in `~/.claude/channels/slack/`. The setup is powerful but laptop-bound, and what an "agent" needs to run is currently implicit — whatever the user's laptop happens to have installed and authenticated.

The goal of this work is to make an **agent** an explicit, portable thing: a folder/repo with a declared shape that any host (laptop today, AWS VM tomorrow) can satisfy. This unlocks cloud deployment without forcing a rewrite, isolates agent identities from each other, and lets the orchestrator provision new agents reproducibly.

## Goals

1. **Host-agnostic agent definition.** Laptop and AWS read the same contract files; nothing in the contract is cloud-flavored. Hosts have their own resolvers.
2. **Laptop parity preserved.** Adopting the contract on the existing laptop setup does not require a rewrite, does not break the existing `start.sh` command, and does not move user-visible files.
3. **Orchestrator is uniform with agents.** The orchestrator satisfies the same contract format as the agents it dispatches to, with a typed extension for orchestrator-specific fields.
4. **Reproducible standup.** Given an orchestrator repo and resolved secrets, a fresh host can stand up the full agent fleet by cloning and starting — no per-host configuration drift.
5. **Declarative, not imperative.** The contract describes an agent's *needs* (skills, MCPs, CLIs, secrets, network). Hosts decide how to satisfy them.

## Non-goals

- Cloud deployment mechanics (subsystem C).
- Service-account provisioning and credential rotation (subsystem D).
- Self-onboarding flows for new agents (subsystem B).
- A marketplace/distribution format for agents.
- Multi-tenancy of a single host across organizations.
- Enforcement of `network.allowed_outbound` (declared only; enforcement is C's job).

## Constraints chosen during brainstorm

- **Triggers in scope:** Slack channel events, Slack DMs (to orchestrator), cron (static + dynamic), webhooks, agent-to-agent calls.
- **Triggers deferred:** generic API surface (collapses CLI + web + other chats); file/repo watchers; N-to-M Slack bindings.
- **Disk layout:** soft additive `.agent/` directory; CLAUDE.md stays at repo root.
- **Memory model:** shared knowledge base in `.agent/memory/` + per-invocation working memory in `.agent/memory/threads/<id>/`.
- **Orchestrator is an agent.** Same contract, special role.
- **Cron uses Claude Code's built-in `CronCreate`.** No parallel scheduler.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│ Host (laptop OR AWS VM — same shape)                              │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Orchestrator agent                                          │  │
│  │ <orchestrator-repo>/                                        │  │
│  │   CLAUDE.md            ← role, dispatcher rules             │  │
│  │   .agent/                                                   │  │
│  │     agent.toml         ← role="orchestrator", triggers,     │  │
│  │                          declared MCPs, declared secrets    │  │
│  │     state/             ← routes.json, threads.json,         │  │
│  │                          access.json                        │  │
│  │     memory/shared/     ← orchestrator's accumulated         │  │
│  │                          knowledge                          │  │
│  │     memory/threads/    ← per-DM/per-thread scratch          │  │
│  │     logs/              ← invocation logs                    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│   dispatches to ↓ (via SendMessage to spawned subagents)          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ ProjectX agent              ProjectY agent       …          │  │
│  │ <projectx-repo>/            <projecty-repo>/                │  │
│  │   CLAUDE.md                   CLAUDE.md                     │  │
│  │   .agent/                     .agent/                       │  │
│  │     agent.toml                  agent.toml                  │  │
│  │     memory/shared/              memory/shared/              │  │
│  │     memory/threads/             memory/threads/             │  │
│  │     logs/                       logs/                       │  │
│  │   <project source>            <project source>              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Host services (same on laptop and AWS, different backends):      │
│  - Secret resolver (laptop: ~/.claude/channels/slack/.env;        │
│                     AWS: SSM/Secrets Manager — subsystem C)       │
│  - Webhook receiver (single HTTP endpoint, path-based routing)    │
│  - Cron runner (Claude Code's built-in CronCreate)                │
└───────────────────────────────────────────────────────────────────┘
```

### Key invariants

- Every agent (orchestrator included) has the same `.agent/` shape.
- Nothing in an agent's repo is host-specific.
- Orchestrator state files move out of `~/.claude/channels/slack/` and into `<orchestrator-repo>/.agent/state/`. The Slack `.env` becomes a declared secret resolved by the host.
- Restart semantics: the orchestrator's repo is the source of truth. Stand up the host, clone the orchestrator repo, resolve declared secrets, run `start.sh` — everything resumes.

### Folded-in decisions

- **Agent-to-agent calls** are orchestrator-mediated via an MCP tool (`agents.send`). Agents never SendMessage each other directly. The orchestrator's switchboard role is preserved.
- **Webhooks** terminate at one host endpoint (`POST /webhook/<agent>/<event>`). The host receiver verifies HMAC against a per-webhook secret and forwards to the orchestrator.

---

## Disk layout

```
<agent-repo>/
  CLAUDE.md                          # persona, instructions; loaded by Claude Code at session start
  .agent/
    agent.toml                       # the contract (see schema below)
    memory/
      MEMORY.md                      # SHARED — index of accumulated knowledge (always loaded)
      <topic>.md                     # SHARED — topical memory files (referenced from MEMORY.md)
      threads/
        <thread_id>/                 # PER-INVOCATION scratch
          MEMORY.md                  # local index for this thread/cron firing/webhook
          <topic>.md                 # local notes that haven't been promoted to shared
          context.json               # runtime metadata (trigger source, started_at, last_activity)
    logs/
      <YYYY-MM-DD>/
        <thread_id>.jsonl            # one line per event in that invocation
    state/                           # ORCHESTRATOR ONLY (state_dir from agent.toml)
      routes.json
      threads.json
      access.json
```

### `.gitignore` additions (applied during onboarding)

```
.agent/memory/threads/
.agent/logs/
.agent/state/
# .agent/memory/{MEMORY.md, *.md} stay tracked — that's the knowledge base
```

### Key behaviors

1. **`.agent/memory/MEMORY.md` and topical files are tracked in git.** They form the agent's accumulated knowledge — survives wipes, gets backed up, version-controls the agent's "learning."
2. **`.agent/memory/threads/<id>/` is gitignored and ephemeral.** Each invocation gets a fresh dir. Subagents read shared, write here. Promotion from thread → shared is explicit: the agent moves a file up and re-indexes `MEMORY.md`.
3. **`thread_id` is stable per logical conversation** and encodes the trigger source:
   - Slack thread → `slack-<chat_id>-<thread_ts>`
   - Cron firing → `cron-<job_name>-<YYYYMMDDHHMM>`
   - Webhook → `webhook-<event>-<delivery_id>`
   - Agent-to-agent call → `a2a-<source_agent>-<correlation_id>`
4. **Logs are append-only JSONL, partitioned by date.** Cheap to tail, ship, and sweep by retention.
5. **Concurrent invocations don't race on shared memory.** Reads are free. Writes to shared go through the orchestrator's "promote-to-shared" path (sequenced).
6. **`.agent/state/` exists only for `role = "orchestrator"` agents.**

---

## `agent.toml` schema

Format: **TOML**. Human-readable, typed, comment-friendly, low ceremony.

### Regular agent example

```toml
# .agent/agent.toml — ProjectX agent contract
contract_version = 1

[agent]
name          = "projectx"           # unique within host; used by registry & agent-to-agent calls
display_name  = "ProjectX"           # human-friendly (Slack, logs, dashboards)
description   = "Reviews PRs and triages bugs for ProjectX."
role          = "agent"              # "agent" or "orchestrator"
persona_file  = "CLAUDE.md"          # path relative to repo root

# === Triggers ===
[triggers.slack]
channel_id = "C12345ABC"             # 1 agent ↔ 1 channel in MVP

[[triggers.cron]]
name     = "daily-standup"
schedule = "0 9 * * 1-5"
prompt   = "Generate today's standup based on yesterday's commits."

[[triggers.webhook]]
event       = "github.pr.opened"     # → routed at /webhook/projectx/github.pr.opened
secret_name = "GITHUB_WEBHOOK_HMAC"  # HMAC verification key (declared by name)
prompt      = "A new PR was opened: {{ payload.pull_request.html_url }}"

# === Capabilities ===
[capabilities]
skills = ["github-pr-review", "elements-of-style:writing-clearly-and-concisely"]
mcps   = ["github", "linear"]        # by name; actual config lives in repo's .mcp.json
clis   = ["gh", "git", "node@20"]    # host installs these to satisfy

# === Secrets (declared by name only — host resolves) ===
[[secrets]]
name            = "GITHUB_TOKEN"
service_account = true               # hint for subsystem D
scopes          = ["repo:read", "pr:write"]   # informational

[[secrets]]
name            = "LINEAR_API_KEY"
service_account = true

[[secrets]]
name            = "GITHUB_WEBHOOK_HMAC"
service_account = false

# === Storage ===
[storage]
memory_retention   = "forever"
log_retention_days = 30

# === Network (informational in MVP; enforcement is subsystem C) ===
[network]
allowed_outbound = ["api.github.com", "api.linear.app"]
```

### Orchestrator example

```toml
contract_version = 1

[agent]
name         = "orchestrator"
display_name = "Orchestrator"
role         = "orchestrator"
persona_file = "CLAUDE.md"

[triggers.slack]
mode         = "workspace"           # special: receives all events, dispatches them
workspace_id = "T12345ABC"

[capabilities]
mcps = ["slack-channel"]
clis = ["claude", "gh", "git"]

[[secrets]]
name            = "SLACK_BOT_TOKEN"
service_account = true

[[secrets]]
name            = "SLACK_APP_TOKEN"
service_account = true

[orchestrator]
state_dir = ".agent/state"           # routes.json, threads.json, access.json live here

[storage]
memory_retention   = "forever"
log_retention_days = 90
```

### Notable schema decisions

1. **`contract_version = 1`** at top. Cheap insurance for future migrations.
2. **MCP config stays in repo's existing `.mcp.json`.** Contract lists MCPs *by name*; doesn't duplicate args. Single source of truth for MCP config.
3. **Secrets are name-only.** Host resolves. `service_account: true` is a hint for subsystem D — the contract does not decide *how* a secret is provisioned, just that it should be a service account when possible.
4. **1 agent ↔ 1 Slack channel in MVP.** Loosening deferred (see Appendix).
5. **`[orchestrator]` block** is a typed extension only the orchestrator role uses. Regular agents ignore it. Avoids two file formats.
6. **`network.allowed_outbound` is informational.** Written but not enforced in MVP.
7. **No per-trigger access policy.** Today's central `access.json` keeps that job. Per-agent ACLs deferred.
8. **No `owner` / `tags` / per-skill config / display avatar.** YAGNI.

---

## Triggers in detail

### Slack

```toml
[triggers.slack]
channel_id = "C12345ABC"
```

- The orchestrator owns the workspace connection. It receives every event and dispatches by `channel_id`.
- DMs to the orchestrator are conversations *with the orchestrator*. If the orchestrator decides "this DM is really for ProjectX," it forwards via the agent-to-agent path — uniform mechanism, no special DM-to-agent route.
- `routes.json` becomes a *derived view*: at startup, the orchestrator scans all known agent repos, reads each `agent.toml`, and rebuilds `routes.json` in `.agent/state/`. The file still exists as a hot-path lookup index but the source of truth is decentralized.

### Cron (static + dynamic)

```toml
[[triggers.cron]]
name     = "daily-standup"
schedule = "0 9 * * 1-5"
prompt   = "Generate today's standup based on yesterday's commits."
```

- Backed by **Claude Code's built-in `CronCreate`**. We do not reinvent scheduling, persistence, or replay semantics.
- **Reconciliation at orchestrator startup:** read every agent's `[[triggers.cron]]` entries → ensure each one exists in Claude Code's cron registry, keyed by `<agent_name>.<job_name>` → remove any entries matching the `<agent_name>.*` namespace that aren't in the contract anymore.
- **Dynamic crons** (an agent calls `CronCreate` at runtime) live in `<agent_name>.dyn.*`. Reconciliation leaves them alone. Static crons survive across `agent.toml` edits without disturbing dynamic ones.
- Cron firings spawn a subagent in the agent's repo with a templated `prompt` (`{{ now }}`, `{{ job_name }}`, etc.). Each firing gets `thread_id = "cron-<job_name>-<timestamp>"`.

### Webhooks

```toml
[[triggers.webhook]]
event       = "github.pr.opened"
secret_name = "GITHUB_WEBHOOK_HMAC"
prompt      = "A new PR was opened: {{ payload.pull_request.html_url }}"
```

- Single host endpoint: `POST /webhook/<agent_name>/<event>`. One port, one auth surface. Multiple webhook entries per agent supported.
- **Routing logic** (host receiver):
  1. Parse `<agent_name>` and `<event>` from path.
  2. Look up agent in registry → 404 if unknown.
  3. Look up matching `[[triggers.webhook]]` entry by `event` → 404 if not declared (no implicit pass-through).
  4. Verify HMAC of request body against the secret resolved from `secret_name` → 401 on mismatch.
  5. Forward `{ event, payload, headers, delivery_id }` to the orchestrator.
  6. Orchestrator dispatches to the agent with `thread_id = "webhook-<event>-<delivery_id>"`.
- **Per-webhook HMAC secrets** (vs one shared) reflects how real webhook senders work — different senders have different HMAC schemes and rotation cadences.
- Host backend differences: laptop runs the receiver inline in `server.ts` on a local port; AWS terminates at API Gateway → Lambda → orchestrator. Same logical contract.

### Agent-to-agent calls

MCP tool exposed by the orchestrator, available in every agent's session:

```
agents.send(
  target_name: string,           # the target agent's contract `name`
  message: string,
  mode: "sync" | "fire-and-forget" = "sync",
  correlation_id?: string         # auto-generated if absent
) → { reply: string | null, thread_id: string }
```

- **Orchestrator-mediated.** Agents never SendMessage each other directly.
- **Resolution path:**
  1. Orchestrator looks up `target_name` in the agent registry (built from all `.agent/agent.toml` files at startup).
  2. If a subagent for that target is already running for this correlation, route to it.
  3. Otherwise, spawn a fresh subagent in the target's repo with `thread_id = "a2a-<source>-<correlation_id>"`.
  4. Forward `message` via SendMessage. Capture reply.
  5. Sync mode: block, return reply. Fire-and-forget: return immediately; reply is still logged.
- **Access control.** MVP trusts all agents the orchestrator manages (closed set). Per-pair allow/deny lists deferred.
- **Concurrency / loops.** Correlation chain has a max depth (default 5) and a TTL. Past that, calls error out.

### Errors & observability

- Every trigger writes a `<trigger>.received` log line before dispatch.
- Tool errors and subagent crashes are caught, logged, and surfaced as a DM to the orchestrator's allowlist (existing pattern).
- Default timeouts (overridable later in `agent.toml`): cron 10min; webhook 60s host-side then async; a2a sync 5min.

---

## Migration plan

The contract is additive; adopting it for the existing laptop setup is real work. This plan keeps the laptop running through every step.

### Starting state (today)

```
~/.claude/channels/slack/
  .env                     # SLACK_BOT_TOKEN, SLACK_APP_TOKEN
  routes.json              # channel → repo path
  threads.json             # live subagent registry
  access.json              # allowFrom, dmPolicy, channels[]

~/Development/.../claude-channel-slack/        ← the plugin (server.ts, MCP)
~/your/path/claude-slack-orchestrator/         ← orchestrator session (CLAUDE.md only)
~/your/path/projectx-repo/                     ← routed project (CLAUDE.md only)
```

### Phases

**Phase 0 — additive code, no behavior change.**
- Land the contract format and host services (secret resolver abstraction, webhook receiver, agent-to-agent MCP tool).
- Orchestrator gains `prefer_agent_contracts = true|false`. Default `false` for one release.
- Laptop continues working untouched.

**Phase 1 — orchestrator becomes an agent.**
- Add `.agent/agent.toml` (role=orchestrator), `.agent/state/` to the orchestrator repo.
- Migration script copies `~/.claude/channels/slack/{routes,threads,access}.json` into `<orchestrator-repo>/.agent/state/`. Old location becomes a read-only fallback.
- Slack `.env` stays at `~/.claude/channels/slack/.env`. Contract declares `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` by name; the laptop secret resolver reads the same file. *Same physical file, new abstraction.*
- Restart orchestrator with `prefer_agent_contracts = true`. It reads its own `.agent/` first; falls back to old paths only if absent.

**Phase 2 — routed projects become agents.**
- One-shot migration command (a skill that belongs in subsystem B): `/slack-channel:migrate-to-agent-contracts`.
- Reads existing `routes.json`. For each `channel_id → repo_path`:
  1. If `<repo>/.agent/agent.toml` exists → skip.
  2. Else generate a starter `agent.toml` with the channel binding and empty capabilities.
- Orchestrator's startup scans known agent repos, builds the registry from `agent.toml`, derives `routes.json` from contracts.
- `routes.json` becomes derived; manual edits stop working. Orchestrator DMs a one-time warning if stale manual edits are detected.

**Phase 3 — clean up legacy.**
- Drop `prefer_agent_contracts` flag.
- Remove fallback to `~/.claude/channels/slack/{routes,threads,access}.json`.
- Plugin's secret resolver becomes pluggable: `LaptopSecretResolver` (default) and `AwsSecretsManagerResolver` (delivered by subsystem C).

### Operational change for laptop users

| Today                                                              | After full migration                              |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Edit `~/.claude/channels/slack/routes.json` to route               | Edit `<repo>/.agent/agent.toml`                   |
| Edit `routes.json` to reroute                                      | Move/edit `triggers.slack.channel_id`             |
| Lose laptop → reconfigure tokens, redo routing                     | Lose laptop → clone repos, re-resolve secrets     |
| `claude --dangerously-load-development-channels server:slack-channel ...` | **Same command, unchanged.**                |

The startup command does not change. Token file location does not change for laptop. Existing per-project CLAUDE.md does not move.

### Rollback path

Phases 1 and 2 leave the old `~/.claude/channels/slack/` files read-only. If something goes wrong:
1. Set `prefer_agent_contracts = false`.
2. Restart orchestrator → falls back to today's behavior.

The safety net exists through Phase 2. Phase 3 removes it.

### How this sets up subsystem C

After Phase 3, "deploy to AWS" is:
1. Provision a VM.
2. Install `claude`, `bun`, `gh`, `git`, the orchestrator's declared CLIs.
3. Install an AWS-flavored secret resolver (Secrets Manager backend).
4. Clone the orchestrator repo to the VM.
5. Resolve declared secrets via the AWS resolver.
6. Run the same `start.sh` from the orchestrator repo.

No code differences between laptop and AWS — only the secret-resolver implementation and the host process supervision (systemd / ECS / etc.) differ.

---

## Risks & open questions

1. **MCP config in `.mcp.json` vs contract.** Decided: `.mcp.json` stays authoritative; contract references MCPs by name. Risk: drift between the two. Mitigation: orchestrator validates at startup that every `capabilities.mcps` name resolves to a `.mcp.json` entry; warns on mismatch.
2. **Promotion from thread → shared memory is explicit.** Risk: agents will forget to promote and shared memory will starve. Mitigation: the auto-memory system can hint when a thread-memory item references a topic that exists in shared memory (suggest promotion). Out of scope for this spec; flag for B.
3. **`routes.json` becoming derived breaks any external tooling that wrote to it.** None exists in this project today (verified). External integrations would need to read derived state instead.
4. **HMAC verification per webhook secret** requires the host to resolve N secrets at startup. Acceptable for MVP (handful of webhooks). Bulk webhook scenarios are out of scope.
5. **Agent-to-agent loop guards.** Default depth=5 and TTL is a guess. Tune based on real usage; revisit in B or C if guards trip in normal workflows.
6. **No schema validation tooling shipped.** TOML parses but a JSON-Schema (or similar) for `agent.toml` would catch typos. Belongs in B alongside onboarding.

---

## Appendix — Deferred / future-facing

Items consciously cut from this MVP. Each is re-opened when a concrete need surfaces.

1. **Multi-medium orchestrator reachability** — MVP is Slack-only. Future: API endpoint, web app, other chat platforms (Teams, Discord, Telegram). Design `agent.toml` triggers so `[triggers.api]` or per-medium blocks slot in cleanly.

2. **Generic API surface** — collapses several future items: manual CLI invocation (`agent send projectx "..."`), web app, and "contact the orchestrator through other systems." One HTTP endpoint with auth; thin clients on top.

3. **File/repo watchers as a trigger type** — dropped. (a) "GitHub PR opened" flavor is covered by webhooks. (b) Local `fswatch`/inotify on the agent's repo folder is out of scope. (c) Claude Code's PreToolUse/PostToolUse/Stop hooks fire on the agent's own actions and are not triggers.

4. **N-to-M Slack binding** — MVP enforces 1 agent ↔ 1 Slack channel. Loosening (one agent owns multiple channels, or a channel routes to multiple agents) deferred.

5. **Per-trigger / per-agent access policy** — central `access.json` keeps doing the job. Per-agent ACLs deferred.

6. **`network.allowed_outbound` enforcement** — declared in `agent.toml` but informational only in MVP. Host-level egress enforcement (iptables, security groups, container egress policies) lives in subsystem C.

7. **Per-skill config / display avatar / owner / tags** — YAGNI'd. Add only when a concrete consumer needs them.

8. **Append-only history / event-sourced memory** — option 3 of the memory-shape question. Stronger audit story; chosen path (option 2: shared + per-thread) is simpler. Revisit if compliance or replay becomes a requirement.

9. **Strict schema validation / agent bundle format** — option 3 of the disk-layout question (`.tar.gz` agent packages, fixed layout, schema validation). Chosen path is the soft additive `.agent/` directory. Revisit if a marketplace or distribution story emerges.

---

## References

- Current orchestrator template: `templates/orchestrator/CLAUDE.md`
- Current state files: `~/.claude/channels/slack/{routes,threads,access}.json` + `.env`
- Plugin entrypoint: `server.ts`
- Claude Code built-ins relied on: `CronCreate`, auto-memory, subagent dispatch
- Next spec: subsystem B (self-onboarding skill set)
