# Agent Definition Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the agent definition contract for `claude-channel-slack`: a soft additive `.agent/` directory per agent repo with `agent.toml`, parsed/validated/registered by the plugin, consumed by the orchestrator for static cron reconciliation, webhook dispatch, and agent-to-agent calls. Existing state files (`routes.json`, `threads.json`, `access.json`) remain authoritative for MVP; their migration is a follow-up.

**Architecture:** Plugin-side code (`server.ts` + new modules in `contract.ts`, `registry.ts`, `secrets.ts`, `webhook-receiver.ts`) exposes contract primitives via MCP tools and notifications. Orchestrator-side code (template `CLAUDE.md` + new skills) reads the registry, reconciles crons, dispatches webhooks and agent-to-agent messages. Plugin and orchestrator stay loosely coupled — the plugin provides the surface; the orchestrator provides the behavior.

**Tech Stack:** Bun, TypeScript, `@slack/bolt` (existing), `@modelcontextprotocol/sdk` (existing), `smol-toml` (new), `Bun.serve` (native HTTP), `bun:test` (test runner — matches existing `gate.test.ts`).

**Reference spec:** `docs/superpowers/specs/2026-05-05-agent-definition-contract-design.md`

---

## Scope this plan delivers

From the spec's migration plan:
- **Phase 0 — additive code, no behavior change.** Land contract format, host services, and the `prefer_agent_contracts` toggle.
- **Phase 1 — orchestrator becomes an agent.** Add `.agent/agent.toml` to the orchestrator template; orchestrator reads its own contract on startup.

**Explicitly out of scope (follow-up plans):**
- Phase 2: routed projects become agents (migration script — subsystem B).
- Phase 3: legacy cleanup (after subsystem C ships the AWS secret resolver).
- All deferred items from the spec appendix.

---

## File structure

**New files:**

- `contract.ts` — TOML parsing + validation. Exports `parseAgentContract(toml: string): AgentContract`, types `AgentContract`, `SlackTrigger`, `CronTrigger`, `WebhookTrigger`, `SecretDecl`. One responsibility: parsing/typing.
- `contract.test.ts` — unit tests for `parseAgentContract`.
- `registry.ts` — discovers agent contracts on disk. Exports `loadRegistry(roots: string[]): AgentRegistry` and `AgentRegistry` (Map-shaped wrapper). One responsibility: finding and indexing contracts.
- `registry.test.ts` — unit tests using a temp dir fixture.
- `secrets.ts` — secret resolver abstraction. Exports `SecretResolver` interface + `LaptopSecretResolver` class (reads `process.env`).
- `secrets.test.ts` — unit tests for `LaptopSecretResolver`.
- `webhook-receiver.ts` — `Bun.serve` HTTP listener. Exports `startWebhookReceiver({ port, registry, resolver, onDispatch })`. Validates path → contract → HMAC, calls `onDispatch` callback.
- `webhook-receiver.test.ts` — integration tests against a live `Bun.serve` instance.
- `templates/orchestrator/.agent/agent.toml` — the orchestrator's own contract.
- `templates/orchestrator/.agent/.gitignore` — gitignore for `memory/threads/`, `logs/`, `state/`.
- `templates/orchestrator/skills/registry-bootstrap/SKILL.md` — orchestrator skill: read registry at session start.
- `templates/orchestrator/skills/cron-reconciler/SKILL.md` — orchestrator skill: reconcile static crons.
- `templates/orchestrator/skills/dispatch-handler/SKILL.md` — orchestrator skill: handle agents.send and webhook notifications.
- `docs/agent-contract.md` — user-facing reference for creating an `agent.toml`.

**Modified files:**

- `package.json` — add `smol-toml` dep.
- `server.ts` — add new MCP tools (`get_agents`, `get_contract`, `agents_send`); wire up `loadRegistry` at startup; spawn `webhook-receiver` on configurable port; emit notifications for webhook events and `agents_send` calls.
- `templates/orchestrator/CLAUDE.md` — reference the new skills; describe `.agent/` shape.
- `README.md` — short section on the contract format with a link to `docs/agent-contract.md`.

---

## Conventions used in this plan

- **TDD throughout for plugin-side code.** Write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Orchestrator skills (markdown) have no unit tests.** Each skill task ends with a manual verification step against a running orchestrator session.
- **One commit per task** unless the task explicitly bundles dependent changes (rare).
- **No `--no-verify` on commits.** No hooks bypass.
- All file paths in tasks are repo-relative.

---

## Task 1: Add `smol-toml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `smol-toml` to dependencies**

Edit `package.json` to add the dependency. Final shape:

```json
{
  "name": "claude-channel-slack",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@slack/bolt": "^4.0.0",
    "smol-toml": "^1.3.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.10"
  }
}
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: completes; `bun.lock` updates; `node_modules/smol-toml` exists.

- [ ] **Step 3: Smoke-test the import in a throwaway file**

Run: `bun -e 'import { parse } from "smol-toml"; console.log(parse("k = 1"))'`
Expected: prints `{ k: 1 }`.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add smol-toml for agent contract parsing"
```

---

## Task 2: Define `AgentContract` types and minimal parser

**Files:**
- Create: `contract.ts`
- Create: `contract.test.ts`

- [ ] **Step 1: Write the failing test for minimal contract parsing**

Create `contract.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseAgentContract } from './contract.ts'

describe('parseAgentContract — minimal', () => {
  test('parses a minimal agent contract', () => {
    const toml = `
contract_version = 1

[agent]
name         = "projectx"
display_name = "ProjectX"
role         = "agent"
persona_file = "CLAUDE.md"
`
    const c = parseAgentContract(toml)
    expect(c.contract_version).toBe(1)
    expect(c.agent.name).toBe('projectx')
    expect(c.agent.display_name).toBe('ProjectX')
    expect(c.agent.role).toBe('agent')
    expect(c.agent.persona_file).toBe('CLAUDE.md')
  })

  test('throws on missing [agent] section', () => {
    expect(() => parseAgentContract('contract_version = 1\n')).toThrow(/\[agent\]/)
  })

  test('throws on missing agent.name', () => {
    expect(() => parseAgentContract(`
contract_version = 1
[agent]
role         = "agent"
persona_file = "CLAUDE.md"
`)).toThrow(/agent\.name/)
  })

  test('throws on invalid TOML', () => {
    expect(() => parseAgentContract('this is not = = toml')).toThrow()
  })

  test('throws on unsupported contract_version', () => {
    expect(() => parseAgentContract(`
contract_version = 99
[agent]
name = "x"
role = "agent"
persona_file = "CLAUDE.md"
`)).toThrow(/contract_version/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test contract.test.ts`
Expected: FAIL — `Cannot find module './contract.ts'`.

- [ ] **Step 3: Write `contract.ts` with minimal types + parser**

Create `contract.ts`:

```ts
import { parse } from 'smol-toml'

export type AgentRole = 'agent' | 'orchestrator'

export interface AgentContract {
  contract_version: number
  agent: {
    name: string
    display_name?: string
    description?: string
    role: AgentRole
    persona_file: string
  }
}

const SUPPORTED_CONTRACT_VERSIONS = new Set([1])

export function parseAgentContract(toml: string): AgentContract {
  const parsed = parse(toml) as Record<string, unknown>

  const version = parsed.contract_version
  if (typeof version !== 'number' || !SUPPORTED_CONTRACT_VERSIONS.has(version)) {
    throw new Error(`unsupported contract_version: ${String(version)}`)
  }

  const agent = parsed.agent as Record<string, unknown> | undefined
  if (!agent || typeof agent !== 'object') {
    throw new Error('contract missing [agent] section')
  }
  if (typeof agent.name !== 'string' || !agent.name) {
    throw new Error('contract missing agent.name')
  }
  if (agent.role !== 'agent' && agent.role !== 'orchestrator') {
    throw new Error('contract agent.role must be "agent" or "orchestrator"')
  }
  if (typeof agent.persona_file !== 'string' || !agent.persona_file) {
    throw new Error('contract missing agent.persona_file')
  }

  return {
    contract_version: version,
    agent: {
      name: agent.name,
      display_name: typeof agent.display_name === 'string' ? agent.display_name : undefined,
      description: typeof agent.description === 'string' ? agent.description : undefined,
      role: agent.role,
      persona_file: agent.persona_file,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test contract.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add contract.ts contract.test.ts
git commit -m "feat(contract): parse minimal agent.toml + version gate"
```

---

## Task 3: Extend `AgentContract` with triggers

**Files:**
- Modify: `contract.ts`
- Modify: `contract.test.ts`

- [ ] **Step 1: Write failing tests for trigger parsing**

Append to `contract.test.ts`:

```ts
describe('parseAgentContract — triggers', () => {
  test('parses Slack channel binding', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[triggers.slack]
channel_id = "C12345"
`)
    expect(c.triggers?.slack?.channel_id).toBe('C12345')
  })

  test('parses orchestrator workspace-mode Slack trigger', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "o"
role         = "orchestrator"
persona_file = "CLAUDE.md"
[triggers.slack]
mode         = "workspace"
workspace_id = "T123"
`)
    expect(c.triggers?.slack?.mode).toBe('workspace')
    expect(c.triggers?.slack?.workspace_id).toBe('T123')
  })

  test('parses an array of cron triggers', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[[triggers.cron]]
name     = "daily"
schedule = "0 9 * * 1-5"
prompt   = "Standup"
[[triggers.cron]]
name     = "weekly"
schedule = "0 9 * * 1"
prompt   = "Retrospective"
`)
    expect(c.triggers?.cron).toHaveLength(2)
    expect(c.triggers?.cron?.[0]?.name).toBe('daily')
    expect(c.triggers?.cron?.[1]?.schedule).toBe('0 9 * * 1')
  })

  test('parses an array of webhook triggers', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[[triggers.webhook]]
event       = "github.pr.opened"
secret_name = "GH_HMAC"
prompt      = "PR opened: {{ payload.html_url }}"
`)
    expect(c.triggers?.webhook).toHaveLength(1)
    expect(c.triggers?.webhook?.[0]?.event).toBe('github.pr.opened')
    expect(c.triggers?.webhook?.[0]?.secret_name).toBe('GH_HMAC')
  })

  test('throws on cron entry missing schedule', () => {
    expect(() => parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[[triggers.cron]]
name = "broken"
`)).toThrow(/cron.*schedule/)
  })
})
```

- [ ] **Step 2: Run tests to confirm failures**

Run: `bun test contract.test.ts`
Expected: 5 new tests fail (existing 5 still pass).

- [ ] **Step 3: Extend types and parser**

Replace the contents of `contract.ts`:

```ts
import { parse } from 'smol-toml'

export type AgentRole = 'agent' | 'orchestrator'

export interface SlackTrigger {
  channel_id?: string
  mode?: 'workspace'
  workspace_id?: string
}

export interface CronTrigger {
  name: string
  schedule: string
  prompt: string
}

export interface WebhookTrigger {
  event: string
  secret_name: string
  prompt: string
}

export interface Triggers {
  slack?: SlackTrigger
  cron?: CronTrigger[]
  webhook?: WebhookTrigger[]
}

export interface AgentContract {
  contract_version: number
  agent: {
    name: string
    display_name?: string
    description?: string
    role: AgentRole
    persona_file: string
  }
  triggers?: Triggers
}

const SUPPORTED_CONTRACT_VERSIONS = new Set([1])

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`contract missing ${field}`)
  return v
}

function parseCronArray(raw: unknown): CronTrigger[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('triggers.cron must be an array')
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>
    return {
      name: asString(e.name, `triggers.cron[${i}].name`),
      schedule: asString(e.schedule, `triggers.cron[${i}].schedule`),
      prompt: asString(e.prompt, `triggers.cron[${i}].prompt`),
    }
  })
}

function parseWebhookArray(raw: unknown): WebhookTrigger[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('triggers.webhook must be an array')
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>
    return {
      event: asString(e.event, `triggers.webhook[${i}].event`),
      secret_name: asString(e.secret_name, `triggers.webhook[${i}].secret_name`),
      prompt: asString(e.prompt, `triggers.webhook[${i}].prompt`),
    }
  })
}

function parseSlackTrigger(raw: unknown): SlackTrigger | undefined {
  if (raw === undefined) return undefined
  const s = raw as Record<string, unknown>
  const out: SlackTrigger = {}
  if (typeof s.channel_id === 'string') out.channel_id = s.channel_id
  if (s.mode === 'workspace') out.mode = 'workspace'
  if (typeof s.workspace_id === 'string') out.workspace_id = s.workspace_id
  return out
}

export function parseAgentContract(toml: string): AgentContract {
  const parsed = parse(toml) as Record<string, unknown>

  const version = parsed.contract_version
  if (typeof version !== 'number' || !SUPPORTED_CONTRACT_VERSIONS.has(version)) {
    throw new Error(`unsupported contract_version: ${String(version)}`)
  }

  const agent = parsed.agent as Record<string, unknown> | undefined
  if (!agent || typeof agent !== 'object') {
    throw new Error('contract missing [agent] section')
  }
  const name = asString(agent.name, 'agent.name')
  if (agent.role !== 'agent' && agent.role !== 'orchestrator') {
    throw new Error('contract agent.role must be "agent" or "orchestrator"')
  }
  const personaFile = asString(agent.persona_file, 'agent.persona_file')

  const triggersRaw = parsed.triggers as Record<string, unknown> | undefined
  const triggers: Triggers | undefined = triggersRaw
    ? {
        slack: parseSlackTrigger(triggersRaw.slack),
        cron: parseCronArray(triggersRaw.cron),
        webhook: parseWebhookArray(triggersRaw.webhook),
      }
    : undefined

  return {
    contract_version: version,
    agent: {
      name,
      display_name: typeof agent.display_name === 'string' ? agent.display_name : undefined,
      description: typeof agent.description === 'string' ? agent.description : undefined,
      role: agent.role,
      persona_file: personaFile,
    },
    triggers,
  }
}
```

- [ ] **Step 4: Run all tests in `contract.test.ts`**

Run: `bun test contract.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add contract.ts contract.test.ts
git commit -m "feat(contract): parse Slack/cron/webhook triggers"
```

---

## Task 4: Extend `AgentContract` with capabilities, secrets, storage, network

**Files:**
- Modify: `contract.ts`
- Modify: `contract.test.ts`

- [ ] **Step 1: Write failing tests for the remaining sections**

Append to `contract.test.ts`:

```ts
describe('parseAgentContract — capabilities/secrets/storage/network', () => {
  test('parses capabilities arrays', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[capabilities]
skills = ["a", "b"]
mcps   = ["m"]
clis   = ["gh", "git"]
`)
    expect(c.capabilities?.skills).toEqual(['a', 'b'])
    expect(c.capabilities?.mcps).toEqual(['m'])
    expect(c.capabilities?.clis).toEqual(['gh', 'git'])
  })

  test('parses an array of secret declarations', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[[secrets]]
name            = "GITHUB_TOKEN"
service_account = true
scopes          = ["repo:read"]
[[secrets]]
name            = "GH_HMAC"
service_account = false
`)
    expect(c.secrets).toHaveLength(2)
    expect(c.secrets?.[0]?.name).toBe('GITHUB_TOKEN')
    expect(c.secrets?.[0]?.service_account).toBe(true)
    expect(c.secrets?.[0]?.scopes).toEqual(['repo:read'])
    expect(c.secrets?.[1]?.service_account).toBe(false)
  })

  test('parses storage retention options', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[storage]
memory_retention   = "forever"
log_retention_days = 30
`)
    expect(c.storage?.memory_retention).toBe('forever')
    expect(c.storage?.log_retention_days).toBe(30)
  })

  test('parses network.allowed_outbound', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[network]
allowed_outbound = ["api.github.com"]
`)
    expect(c.network?.allowed_outbound).toEqual(['api.github.com'])
  })

  test('parses orchestrator-specific state_dir', () => {
    const c = parseAgentContract(`
contract_version = 1
[agent]
name         = "o"
role         = "orchestrator"
persona_file = "CLAUDE.md"
[orchestrator]
state_dir = ".agent/state"
`)
    expect(c.orchestrator?.state_dir).toBe('.agent/state')
  })

  test('throws on secret entry missing name', () => {
    expect(() => parseAgentContract(`
contract_version = 1
[agent]
name         = "x"
role         = "agent"
persona_file = "CLAUDE.md"
[[secrets]]
service_account = true
`)).toThrow(/secrets.*name/)
  })
})
```

- [ ] **Step 2: Run tests to confirm failures**

Run: `bun test contract.test.ts`
Expected: 6 new tests fail (existing 10 still pass).

- [ ] **Step 3: Extend types and parser**

In `contract.ts`, add the following interfaces alongside the existing ones (above `parseAgentContract`):

```ts
export interface Capabilities {
  skills?: string[]
  mcps?: string[]
  clis?: string[]
}

export interface SecretDecl {
  name: string
  service_account?: boolean
  scopes?: string[]
}

export interface Storage {
  memory_retention?: string
  log_retention_days?: number
}

export interface Network {
  allowed_outbound?: string[]
}

export interface OrchestratorBlock {
  state_dir?: string
}
```

Add the parser helpers (above `parseAgentContract`):

```ts
function asStringArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return raw as string[]
}

function parseCapabilities(raw: unknown): Capabilities | undefined {
  if (raw === undefined) return undefined
  const c = raw as Record<string, unknown>
  return {
    skills: asStringArray(c.skills, 'capabilities.skills'),
    mcps: asStringArray(c.mcps, 'capabilities.mcps'),
    clis: asStringArray(c.clis, 'capabilities.clis'),
  }
}

function parseSecrets(raw: unknown): SecretDecl[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('secrets must be an array')
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>
    return {
      name: asString(e.name, `secrets[${i}].name`),
      service_account: typeof e.service_account === 'boolean' ? e.service_account : undefined,
      scopes: asStringArray(e.scopes, `secrets[${i}].scopes`),
    }
  })
}

function parseStorage(raw: unknown): Storage | undefined {
  if (raw === undefined) return undefined
  const s = raw as Record<string, unknown>
  return {
    memory_retention: typeof s.memory_retention === 'string' ? s.memory_retention : undefined,
    log_retention_days: typeof s.log_retention_days === 'number' ? s.log_retention_days : undefined,
  }
}

function parseNetwork(raw: unknown): Network | undefined {
  if (raw === undefined) return undefined
  const n = raw as Record<string, unknown>
  return { allowed_outbound: asStringArray(n.allowed_outbound, 'network.allowed_outbound') }
}

function parseOrchestratorBlock(raw: unknown): OrchestratorBlock | undefined {
  if (raw === undefined) return undefined
  const o = raw as Record<string, unknown>
  return { state_dir: typeof o.state_dir === 'string' ? o.state_dir : undefined }
}
```

Update the `AgentContract` interface to add optional fields:

```ts
export interface AgentContract {
  contract_version: number
  agent: {
    name: string
    display_name?: string
    description?: string
    role: AgentRole
    persona_file: string
  }
  triggers?: Triggers
  capabilities?: Capabilities
  secrets?: SecretDecl[]
  storage?: Storage
  network?: Network
  orchestrator?: OrchestratorBlock
}
```

Update the return statement in `parseAgentContract` to include the new sections:

```ts
  return {
    contract_version: version,
    agent: {
      name,
      display_name: typeof agent.display_name === 'string' ? agent.display_name : undefined,
      description: typeof agent.description === 'string' ? agent.description : undefined,
      role: agent.role,
      persona_file: personaFile,
    },
    triggers,
    capabilities: parseCapabilities(parsed.capabilities),
    secrets: parseSecrets(parsed.secrets),
    storage: parseStorage(parsed.storage),
    network: parseNetwork(parsed.network),
    orchestrator: parseOrchestratorBlock(parsed.orchestrator),
  }
```

- [ ] **Step 4: Run all tests**

Run: `bun test contract.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add contract.ts contract.test.ts
git commit -m "feat(contract): parse capabilities/secrets/storage/network/orchestrator"
```

---

## Task 5: Registry — discover agents on disk

**Files:**
- Create: `registry.ts`
- Create: `registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `registry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRegistry } from './registry.ts'

let tmpRoot: string
const FIXTURE_A = `
contract_version = 1
[agent]
name         = "alpha"
role         = "agent"
persona_file = "CLAUDE.md"
`
const FIXTURE_B = `
contract_version = 1
[agent]
name         = "beta"
role         = "agent"
persona_file = "CLAUDE.md"
`
const BROKEN = 'contract_version = "not a number"'

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'registry-test-'))
  for (const [dir, content] of [
    ['alpha-repo', FIXTURE_A],
    ['beta-repo', FIXTURE_B],
    ['broken-repo', BROKEN],
  ] as const) {
    mkdirSync(join(tmpRoot, dir, '.agent'), { recursive: true })
    writeFileSync(join(tmpRoot, dir, '.agent', 'agent.toml'), content)
  }
  mkdirSync(join(tmpRoot, 'no-agent-repo'), { recursive: true })
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('loadRegistry', () => {
  test('discovers valid contracts under each root', () => {
    const r = loadRegistry([
      join(tmpRoot, 'alpha-repo'),
      join(tmpRoot, 'beta-repo'),
      join(tmpRoot, 'no-agent-repo'),
    ])
    expect(r.size).toBe(2)
    expect(r.get('alpha')?.repo_path).toBe(join(tmpRoot, 'alpha-repo'))
    expect(r.get('beta')?.contract.agent.name).toBe('beta')
  })

  test('skips invalid contracts and logs (does not throw)', () => {
    const r = loadRegistry([join(tmpRoot, 'broken-repo')])
    expect(r.size).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.path).toContain('broken-repo')
  })

  test('refuses duplicate agent names', () => {
    expect(() =>
      loadRegistry([join(tmpRoot, 'alpha-repo'), join(tmpRoot, 'alpha-repo')]),
    ).toThrow(/duplicate agent name/)
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test registry.test.ts`
Expected: FAIL — `Cannot find module './registry.ts'`.

- [ ] **Step 3: Implement `registry.ts`**

Create `registry.ts`:

```ts
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { parseAgentContract, type AgentContract } from './contract.ts'

export interface RegistryEntry {
  repo_path: string
  contract: AgentContract
}

export interface RegistryError {
  path: string
  message: string
}

export class AgentRegistry extends Map<string, RegistryEntry> {
  readonly errors: RegistryError[] = []
}

export function loadRegistry(roots: string[]): AgentRegistry {
  const registry = new AgentRegistry()
  for (const root of roots) {
    const tomlPath = join(root, '.agent', 'agent.toml')
    let stats
    try {
      stats = statSync(tomlPath)
    } catch {
      continue
    }
    if (!stats.isFile()) continue

    try {
      const contract = parseAgentContract(readFileSync(tomlPath, 'utf8'))
      if (registry.has(contract.agent.name)) {
        throw new Error(`duplicate agent name "${contract.agent.name}" at ${root}`)
      }
      registry.set(contract.agent.name, { repo_path: root, contract })
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('duplicate agent name')) throw e
      const message = e instanceof Error ? e.message : String(e)
      registry.errors.push({ path: tomlPath, message })
      process.stderr.write(`registry: ${tomlPath}: ${message}\n`)
    }
  }
  return registry
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `bun test registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add registry.ts registry.test.ts
git commit -m "feat(registry): discover and load agent contracts from repo roots"
```

---

## Task 6: Secret resolver — interface + Laptop implementation

**Files:**
- Create: `secrets.ts`
- Create: `secrets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `secrets.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { LaptopSecretResolver } from './secrets.ts'

describe('LaptopSecretResolver', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved.TEST_SECRET = process.env.TEST_SECRET
    saved.TEST_UNSET = process.env.TEST_UNSET
    delete process.env.TEST_UNSET
    process.env.TEST_SECRET = 'value-1'
  })
  afterEach(() => {
    if (saved.TEST_SECRET === undefined) delete process.env.TEST_SECRET
    else process.env.TEST_SECRET = saved.TEST_SECRET
    if (saved.TEST_UNSET !== undefined) process.env.TEST_UNSET = saved.TEST_UNSET
  })

  test('resolves a present env var', async () => {
    const r = new LaptopSecretResolver()
    expect(await r.resolve('TEST_SECRET')).toBe('value-1')
  })

  test('returns undefined for missing env var', async () => {
    const r = new LaptopSecretResolver()
    expect(await r.resolve('TEST_UNSET')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test secrets.test.ts`
Expected: FAIL — `Cannot find module './secrets.ts'`.

- [ ] **Step 3: Implement `secrets.ts`**

Create `secrets.ts`:

```ts
export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>
}

export class LaptopSecretResolver implements SecretResolver {
  async resolve(name: string): Promise<string | undefined> {
    return process.env[name]
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `bun test secrets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add secrets.ts secrets.test.ts
git commit -m "feat(secrets): SecretResolver interface + LaptopSecretResolver"
```

---

## Task 7: Webhook receiver — HTTP listener + routing + HMAC

**Files:**
- Create: `webhook-receiver.ts`
- Create: `webhook-receiver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `webhook-receiver.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { AgentRegistry } from './registry.ts'
import { LaptopSecretResolver } from './secrets.ts'
import { startWebhookReceiver, type WebhookDispatch } from './webhook-receiver.ts'

function buildRegistry(): AgentRegistry {
  const r = new AgentRegistry()
  r.set('projectx', {
    repo_path: '/tmp/projectx',
    contract: {
      contract_version: 1,
      agent: { name: 'projectx', role: 'agent', persona_file: 'CLAUDE.md' },
      triggers: {
        webhook: [
          { event: 'github.pr.opened', secret_name: 'TEST_HMAC', prompt: 'PR opened' },
        ],
      },
    },
  })
  return r
}

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('webhook-receiver', () => {
  const dispatches: WebhookDispatch[] = []
  let stop: () => Promise<void>
  let port: number

  beforeEach(async () => {
    dispatches.length = 0
    process.env.TEST_HMAC = 'shh'
    const handle = await startWebhookReceiver({
      port: 0,
      registry: buildRegistry(),
      resolver: new LaptopSecretResolver(),
      onDispatch: (d) => { dispatches.push(d) },
    })
    stop = handle.stop
    port = handle.port
  })
  afterEach(async () => {
    await stop()
    delete process.env.TEST_HMAC
  })

  test('delivers a valid webhook to onDispatch', async () => {
    const body = JSON.stringify({ pull_request: { html_url: 'http://x' } })
    const res = await fetch(`http://localhost:${port}/webhook/projectx/github.pr.opened`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'shh') },
    })
    expect(res.status).toBe(202)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.agent_name).toBe('projectx')
    expect(dispatches[0]?.event).toBe('github.pr.opened')
    expect(dispatches[0]?.delivery_id).toMatch(/^[a-z0-9-]+$/)
  })

  test('returns 404 for unknown agent', async () => {
    const res = await fetch(`http://localhost:${port}/webhook/unknown/x`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(dispatches).toHaveLength(0)
  })

  test('returns 404 for unknown event on a known agent', async () => {
    const res = await fetch(`http://localhost:${port}/webhook/projectx/never.declared`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  test('returns 401 on HMAC mismatch', async () => {
    const body = '{}'
    const res = await fetch(`http://localhost:${port}/webhook/projectx/github.pr.opened`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'WRONG') },
    })
    expect(res.status).toBe(401)
    expect(dispatches).toHaveLength(0)
  })

  test('rejects non-POST', async () => {
    const res = await fetch(`http://localhost:${port}/webhook/projectx/github.pr.opened`)
    expect(res.status).toBe(405)
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test webhook-receiver.test.ts`
Expected: FAIL — `Cannot find module './webhook-receiver.ts'`.

- [ ] **Step 3: Implement `webhook-receiver.ts`**

Create `webhook-receiver.ts`:

```ts
import { createHmac, timingSafeEqual } from 'crypto'
import type { Server } from 'bun'
import type { AgentRegistry } from './registry.ts'
import type { SecretResolver } from './secrets.ts'

export interface WebhookDispatch {
  agent_name: string
  event: string
  delivery_id: string
  payload: unknown
  headers: Record<string, string>
  prompt: string
}

export interface StartOptions {
  port: number
  registry: AgentRegistry
  resolver: SecretResolver
  onDispatch: (d: WebhookDispatch) => void
}

export interface RunningReceiver {
  port: number
  stop: () => Promise<void>
}

function verifyHmac(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function startWebhookReceiver(opts: StartOptions): Promise<RunningReceiver> {
  const server: Server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const url = new URL(req.url)
      const m = /^\/webhook\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      if (!m) return new Response('not found', { status: 404 })
      const [, agentName, event] = m
      if (!agentName || !event) return new Response('not found', { status: 404 })

      const entry = opts.registry.get(agentName)
      if (!entry) return new Response('agent not found', { status: 404 })
      const declared = entry.contract.triggers?.webhook?.find((w) => w.event === event)
      if (!declared) return new Response('event not declared', { status: 404 })

      const secret = await opts.resolver.resolve(declared.secret_name)
      if (!secret) return new Response('secret not resolvable', { status: 500 })

      const body = await req.text()
      const sig = req.headers.get('x-hub-signature-256')
      if (!verifyHmac(body, sig, secret)) {
        return new Response('signature mismatch', { status: 401 })
      }

      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k] = v })
      const delivery_id = headers['x-github-delivery'] ?? crypto.randomUUID()

      let payload: unknown = body
      try { payload = JSON.parse(body) } catch { /* leave as text */ }

      opts.onDispatch({
        agent_name: agentName,
        event,
        delivery_id,
        payload,
        headers,
        prompt: declared.prompt,
      })

      return new Response('accepted', { status: 202 })
    },
  })

  return {
    port: server.port,
    async stop() { await server.stop(true) },
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `bun test webhook-receiver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add webhook-receiver.ts webhook-receiver.test.ts
git commit -m "feat(webhook): HTTP receiver with path routing + HMAC verification"
```

---

## Task 8: Plugin integration — registry + webhook receiver at startup

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Read the spec section "Webhooks → host backend differences"**

Open `docs/superpowers/specs/2026-05-05-agent-definition-contract-design.md`, find the "Webhooks" section. Confirm: the receiver runs inline in `server.ts` on a local port; the orchestrator gets a notification per delivery.

- [ ] **Step 2: Add imports + env-driven config near the top of `server.ts`**

Below the existing imports in `server.ts` (after the `decideChannelPolicy` import — around line 25), add:

```ts
import { loadRegistry, type AgentRegistry } from './registry.ts'
import { LaptopSecretResolver } from './secrets.ts'
import { startWebhookReceiver, type RunningReceiver } from './webhook-receiver.ts'
```

After the existing `STATE_DIR` / `ACCESS_FILE` constants, add:

```ts
const AGENT_ROOTS_ENV = process.env.AGENT_ROOTS ?? ''
const AGENT_ROOTS = AGENT_ROOTS_ENV.split(':').filter(Boolean)
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 0)
const ENABLE_WEBHOOKS = process.env.ENABLE_WEBHOOKS === '1'
```

- [ ] **Step 3: Build the registry at startup**

Find the location where `slackApp` is initialized (search `let slackApp: ... | null = null`). Above that line, add module-level state:

```ts
const secretResolver = new LaptopSecretResolver()
const registry: AgentRegistry = loadRegistry(AGENT_ROOTS)
let webhookReceiver: RunningReceiver | null = null
```

`loadRegistry([])` returns a properly-shaped empty `AgentRegistry` (zero entries, `errors = []`), so no special case is needed when `AGENT_ROOTS` is unset.

- [ ] **Step 4: Start the webhook receiver after MCP connect**

Find the line `await mcp.connect(new StdioServerTransport())`. Immediately AFTER it, add:

```ts
if (ENABLE_WEBHOOKS && registry.size > 0) {
  webhookReceiver = await startWebhookReceiver({
    port: WEBHOOK_PORT,
    registry,
    resolver: secretResolver,
    onDispatch: (d) => {
      void mcp.notification({
        method: 'notifications/claude/channel/webhook',
        params: {
          agent_name: d.agent_name,
          event: d.event,
          delivery_id: d.delivery_id,
          payload: d.payload,
          prompt: d.prompt,
        },
      })
    },
  })
  process.stderr.write(`webhook receiver listening on port ${webhookReceiver.port}\n`)
}
```

- [ ] **Step 5: Sanity build**

Run: `bun build server.ts --target=bun --outdir=/tmp/build-check`
Expected: bundled successfully, no errors.

- [ ] **Step 6: Smoke-test the dispatch path manually**

In a separate terminal, set up a fake agent root and start the plugin:

```bash
mkdir -p /tmp/fake-agent/.agent
cat > /tmp/fake-agent/.agent/agent.toml <<'EOF'
contract_version = 1
[agent]
name         = "fake"
role         = "agent"
persona_file = "CLAUDE.md"
[[triggers.webhook]]
event       = "test.ping"
secret_name = "TEST_HMAC"
prompt      = "ping"
EOF

AGENT_ROOTS=/tmp/fake-agent \
  WEBHOOK_PORT=8765 \
  ENABLE_WEBHOOKS=1 \
  TEST_HMAC=secret \
  bun server.ts &
```

Wait ~1 second, then in another terminal:

```bash
BODY='{"ok":true}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac secret | awk '{print "sha256="$2}')
curl -sS -X POST -H "x-hub-signature-256: $SIG" -d "$BODY" http://localhost:8765/webhook/fake/test.ping -i | head -3
```

Expected: `HTTP/1.1 202 Accepted`. Kill the bun process when done.

- [ ] **Step 7: Commit**

```bash
git add server.ts
git commit -m "feat(server): integrate registry + webhook receiver at startup"
```

---

## Task 9: MCP tool — `get_agents` (read registry from orchestrator)

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Locate the existing `ListToolsRequestSchema` handler**

Search `server.ts` for `setRequestHandler(ListToolsRequestSchema`. The existing tools array (`reply`, `react`, `edit`, `download`, `fetch_messages`) is what we extend.

- [ ] **Step 2: Add the `get_agents` tool definition**

In the `tools` array returned by `ListToolsRequestSchema`, append a new entry:

```ts
{
  name: 'get_agents',
  description:
    'Return the registry of agents loaded from .agent/agent.toml under AGENT_ROOTS. ' +
    'Use this at session start (and on demand) to learn which agents exist, their contracts, ' +
    'and their repo paths. Empty registry is valid.',
  inputSchema: { type: 'object', properties: {} },
},
```

- [ ] **Step 3: Add the handler**

In the `CallToolRequestSchema` handler (find `setRequestHandler(CallToolRequestSchema`), inside its `switch` or chained `if`/`else if` (match existing style), handle the new tool:

```ts
if (req.params.name === 'get_agents') {
  const agents = Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    repo_path: entry.repo_path,
    contract: entry.contract,
  }))
  const errors = registry.errors
  return {
    content: [{ type: 'text', text: JSON.stringify({ agents, errors }, null, 2) }],
  }
}
```

- [ ] **Step 4: Write a server smoke test**

Create `server.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

describe('server.ts surface', () => {
  test('exports parseable typescript (smoke)', async () => {
    const result = await Bun.build({ entrypoints: ['./server.ts'], target: 'bun' })
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 5: Run smoke test**

Run: `bun test server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat(server): expose get_agents MCP tool for orchestrator registry access"
```

---

## Task 10: MCP tools — `agents_send`, `get_a2a_reply`, `post_a2a_reply`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add the `agents_send` tool definition**

In the `tools` array, append:

```ts
{
  name: 'agents_send',
  description:
    'Send a message from this agent to another agent (orchestrator-mediated). ' +
    'Pass target_name (the contract `name` of the target agent) and message. ' +
    'mode is "sync" (default, returns reply) or "fire-and-forget". ' +
    'correlation_id chains nested calls; if omitted one is generated. ' +
    'Max depth = 5; deeper calls error out.',
  inputSchema: {
    type: 'object',
    properties: {
      target_name: { type: 'string' },
      message: { type: 'string' },
      mode: { type: 'string', enum: ['sync', 'fire-and-forget'], default: 'sync' },
      correlation_id: { type: 'string' },
    },
    required: ['target_name', 'message'],
  },
},
```

- [ ] **Step 2: Add the `agents_send` handler**

In the `CallToolRequestSchema` handler, alongside the `get_agents` branch:

```ts
if (req.params.name === 'agents_send') {
  const args = req.params.arguments as {
    target_name: string
    message: string
    mode?: 'sync' | 'fire-and-forget'
    correlation_id?: string
  }
  const target = registry.get(args.target_name)
  if (!target) {
    throw new Error(`unknown agent "${args.target_name}"`)
  }
  const correlation_id = args.correlation_id ?? crypto.randomUUID()
  const mode = args.mode ?? 'sync'

  void mcp.notification({
    method: 'notifications/claude/channel/agents_send',
    params: {
      target_name: args.target_name,
      target_repo: target.repo_path,
      message: args.message,
      mode,
      correlation_id,
    },
  })

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        accepted: true,
        correlation_id,
        thread_id: `a2a-${correlation_id}`,
        note:
          mode === 'sync'
            ? 'Reply will arrive via orchestrator dispatch; poll get_a2a_reply or wait for completion.'
            : 'Fire-and-forget — no reply expected.',
      }),
    }],
  }
}
```

- [ ] **Step 3: Add the reply-store state**

Below `let webhookReceiver: ...`, add:

```ts
const a2aReplies = new Map<string, string>()
```

- [ ] **Step 4: Add `get_a2a_reply` tool definition and handler**

Add to the `tools` array:

```ts
{
  name: 'get_a2a_reply',
  description:
    'Retrieve the reply for a pending agents_send sync call by correlation_id. ' +
    'Returns { ready: false } if not yet completed, { ready: true, reply: "..." } when delivered. ' +
    'Replies are written by the orchestrator after the target agent responds.',
  inputSchema: {
    type: 'object',
    properties: { correlation_id: { type: 'string' } },
    required: ['correlation_id'],
  },
},
```

Add handler:

```ts
if (req.params.name === 'get_a2a_reply') {
  const args = req.params.arguments as { correlation_id: string }
  const reply = a2aReplies.get(args.correlation_id)
  if (reply === undefined) {
    return { content: [{ type: 'text', text: JSON.stringify({ ready: false }) }] }
  }
  a2aReplies.delete(args.correlation_id)
  return { content: [{ type: 'text', text: JSON.stringify({ ready: true, reply }) }] }
}
```

- [ ] **Step 5: Add `post_a2a_reply` tool definition and handler**

Add to the `tools` array:

```ts
{
  name: 'post_a2a_reply',
  description:
    'INTERNAL — orchestrator use only. Post a reply for a pending agents_send by correlation_id. ' +
    'The originating agent retrieves it via get_a2a_reply.',
  inputSchema: {
    type: 'object',
    properties: {
      correlation_id: { type: 'string' },
      reply: { type: 'string' },
    },
    required: ['correlation_id', 'reply'],
  },
},
```

Add handler:

```ts
if (req.params.name === 'post_a2a_reply') {
  const args = req.params.arguments as { correlation_id: string; reply: string }
  a2aReplies.set(args.correlation_id, args.reply)
  return { content: [{ type: 'text', text: JSON.stringify({ stored: true }) }] }
}
```

- [ ] **Step 6: Sanity build + smoke test**

Run: `bun build server.ts --target=bun --outdir=/tmp/build-check && bun test server.test.ts`
Expected: bundled successfully, smoke test passes.

- [ ] **Step 7: Commit**

```bash
git add server.ts
git commit -m "feat(server): agents_send + get/post_a2a_reply MCP tools"
```

---

## Task 11: Orchestrator template — its own `.agent/agent.toml`

**Files:**
- Create: `templates/orchestrator/.agent/agent.toml`
- Create: `templates/orchestrator/.agent/.gitignore`

- [ ] **Step 1: Create the orchestrator's contract**

Create `templates/orchestrator/.agent/agent.toml`:

```toml
# The orchestrator agent's own contract. Replace <TEAM_ID> during setup.
contract_version = 1

[agent]
name         = "orchestrator"
display_name = "Orchestrator"
description  = "Dispatches Slack events, crons, webhooks, and agent-to-agent calls."
role         = "orchestrator"
persona_file = "CLAUDE.md"

[triggers.slack]
mode         = "workspace"
workspace_id = "<TEAM_ID e.g. T0123ABC>"

[capabilities]
mcps = ["slack-channel"]
clis = ["claude", "gh", "git", "bun"]

[[secrets]]
name            = "SLACK_BOT_TOKEN"
service_account = true

[[secrets]]
name            = "SLACK_APP_TOKEN"
service_account = true

[orchestrator]
state_dir = ".agent/state"

[storage]
memory_retention   = "forever"
log_retention_days = 90
```

- [ ] **Step 2: Create the `.agent/.gitignore`**

Create `templates/orchestrator/.agent/.gitignore`:

```
memory/threads/
logs/
state/
```

- [ ] **Step 3: Confirm root `.gitignore` does not exclude `.agent/`**

Run: `cat templates/orchestrator/.gitignore 2>/dev/null || echo "(no .gitignore in orchestrator template)"`
Expected: either the existing file has no `.agent/` entry, or the file doesn't exist. If it excludes `.agent/`, remove that line.

- [ ] **Step 4: Commit**

```bash
git add templates/orchestrator/.agent/
git commit -m "feat(orchestrator): adopt agent contract with .agent/agent.toml"
```

---

## Task 12: Orchestrator skill — registry bootstrap on session start

**Files:**
- Create: `templates/orchestrator/skills/registry-bootstrap/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `templates/orchestrator/skills/registry-bootstrap/SKILL.md`:

```markdown
---
name: registry-bootstrap
description: Use at the start of every orchestrator session to load the agent registry. Calls the slack-channel `get_agents` MCP tool, caches the result in working memory, and surfaces any contract errors to the operator.
---

# Registry Bootstrap

The orchestrator manages a fleet of agents declared via `.agent/agent.toml` in each agent's repo. At the start of every session, you MUST load this registry so subsequent dispatch (Slack, cron, webhook, agent-to-agent) can resolve target agents by name.

## When to run

- Once at the start of every orchestrator session, BEFORE handling any inbound event.
- On demand if you detect a `routes.json` mismatch (an agent appears there but not in the registry, or vice versa).

## What to do

1. Call the `get_agents` MCP tool from the `slack-channel` plugin (no arguments).
2. Parse the JSON response — `{ agents: [...], errors: [...] }`.
3. Store the agents list in your working memory as `registry` (keyed by `name`). Note each agent's `repo_path` and trigger declarations.
4. If `errors` is non-empty, log a one-time DM warning to the orchestrator's allowlist: "registry: N contracts failed to load (see paths in details)." Include the paths and parser messages in the DM.
5. Cross-check against `~/.claude/channels/slack/routes.json` (or `.agent/state/routes.json` once Phase 1 lands). For each entry:
   - If the routed repo's agent is missing from the registry, DM the allowlist: "channel C… routes to <repo>, but <repo>/.agent/agent.toml is missing or invalid."
   - If the registry has an agent with no corresponding `routes.json` entry and its contract declares a `triggers.slack.channel_id`, DM the allowlist: "agent <name> declares Slack channel C…, but routes.json doesn't include it — consider adding."

## Output

After bootstrap, the orchestrator's working memory holds a list of agents keyed by name, each with `repo_path`, declared triggers, capabilities, and secret names. Subsequent dispatch consults this map.

## Failure mode

If `get_agents` itself errors (plugin not connected, AGENT_ROOTS unset), proceed with an empty registry. Log to the allowlist via DM that contract-based dispatch is disabled this session.
```

- [ ] **Step 2: Manual verification**

Restart the orchestrator session. Confirm in the logs/early DM that the registry-bootstrap skill ran and reported either a populated registry or "empty (AGENT_ROOTS unset)."

- [ ] **Step 3: Commit**

```bash
git add templates/orchestrator/skills/registry-bootstrap/
git commit -m "feat(orchestrator): registry-bootstrap skill"
```

---

## Task 13: Orchestrator skill — cron reconciliation

**Files:**
- Create: `templates/orchestrator/skills/cron-reconciler/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `templates/orchestrator/skills/cron-reconciler/SKILL.md`:

```markdown
---
name: cron-reconciler
description: Reconcile static crons declared in agents' `[[triggers.cron]]` blocks against Claude Code's CronCreate registry. Run at session start (after registry-bootstrap) and any time a contract file changes.
---

# Cron Reconciler

Each agent's `agent.toml` may declare `[[triggers.cron]]` entries: static, durable jobs that should always exist. This skill keeps Claude Code's cron registry in sync with those declarations.

## Namespace rules

- **Static crons** (declared in contracts) live at `<agent_name>.<job_name>`. The reconciler owns them.
- **Dynamic crons** (created at runtime by an agent calling `CronCreate` itself) live at `<agent_name>.dyn.<id>`. The reconciler NEVER touches `dyn.*` entries.

## Reconciliation algorithm

1. List existing crons via `CronList`. Filter to entries whose name matches `^<agent_name>\.[^.]+$` (i.e. agent-static; excludes `dyn.*`).
2. For each agent in the registry (from registry-bootstrap):
   - For each `[[triggers.cron]]` entry, ensure a cron named `<agent_name>.<job_name>` exists with the declared `schedule` and `prompt`.
   - If missing → `CronCreate` with that name, schedule, and prompt (templated: support `{{ now }}`, `{{ job_name }}`, `{{ agent_name }}`).
   - If present but schedule or prompt differs → `CronDelete` then `CronCreate` with the new values (no in-place update; safer to recreate).
3. For each cron currently in the `<agent_name>.<…>` namespace that no longer appears in the registry, `CronDelete` it.
4. Summarize: log "cron reconciliation: created N, updated M, deleted K" via DM to the orchestrator's allowlist.

## When to run

- After `registry-bootstrap` at session start.
- On demand if an agent's contract file changes (operator says "I edited X's agent.toml; reconcile crons").
- Never automatically on every contract read — reconciliation is a deliberate operation with side effects.

## Failure mode

If a `CronCreate` fails for any single entry, log the error and continue with the remaining agents. Do not abort the whole reconciliation. Report all errors in the summary DM.
```

- [ ] **Step 2: Manual verification**

After implementing, in the orchestrator session: "Run cron reconciliation." Confirm DM summary lists created/updated/deleted counts that match expectations against your registry contents.

- [ ] **Step 3: Commit**

```bash
git add templates/orchestrator/skills/cron-reconciler/
git commit -m "feat(orchestrator): cron-reconciler skill"
```

---

## Task 14: Orchestrator skill — dispatch handler (webhook + agents_send)

**Files:**
- Create: `templates/orchestrator/skills/dispatch-handler/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `templates/orchestrator/skills/dispatch-handler/SKILL.md`:

```markdown
---
name: dispatch-handler
description: Handle inbound notifications from the slack-channel plugin for webhook deliveries and agent-to-agent messages. Looks up the target in the registry, spawns or wakes the target's subagent, and routes the message. Returns sync replies via `post_a2a_reply`.
---

# Dispatch Handler

The slack-channel plugin emits two non-Slack notification types that need orchestrator dispatch:

- `notifications/claude/channel/webhook` — a verified webhook arrived. Params: `agent_name`, `event`, `delivery_id`, `payload`, `prompt`.
- `notifications/claude/channel/agents_send` — an agent invoked `agents_send`. Params: `target_name`, `target_repo`, `message`, `mode`, `correlation_id`.

This skill is the orchestrator's recipe for handling each.

## Webhook handling

When you receive a `webhook` notification:

1. Compute `thread_id = "webhook-<event>-<delivery_id>"`.
2. Look up `agent_name` in the registry. If not found, log error to allowlist DM and stop (this shouldn't happen — the plugin already validated; defend in depth).
3. Render the agent's webhook `prompt` template against `payload` (substitute `{{ payload.* }}` references) and the standard variables.
4. Spawn (or resume) a subagent in `agents[agent_name].repo_path` with the rendered prompt, using the threads-skill pattern. Set the subagent's metadata so its logs land in `<repo>/.agent/logs/<date>/<thread_id>.jsonl`.
5. Capture the subagent's reply; this is informational only — webhooks have no reply path back to the sender.

## Agents-send handling

When you receive an `agents_send` notification:

1. Compute `thread_id = "a2a-<correlation_id>"`.
2. **Depth check.** If `correlation_id` is part of a chain you've already routed 5 times deep, refuse: call `post_a2a_reply` with `reply = "ERROR: max a2a depth (5) reached"` and stop.
3. Look up `target_name` in the registry. If missing, call `post_a2a_reply` with `reply = "ERROR: unknown agent"`.
4. Spawn or resume a subagent in `target_repo` with the message text. Maintain a correlation-id → subagent map so subsequent calls with the same `correlation_id` reach the same subagent.
5. When the subagent replies:
   - `mode = "sync"` → call `post_a2a_reply` with `correlation_id` and the reply text. The originating agent retrieves it via `get_a2a_reply`.
   - `mode = "fire-and-forget"` → log the reply (it still arrived; just not forwarded) and stop.

## TTL

Maintain a per-correlation-id `started_at` timestamp. If a sync call has been open longer than 5 minutes without a reply, time out: call `post_a2a_reply` with `reply = "ERROR: timeout"` and remove the entry.

## Failure mode

Any dispatch error (target spawn failed, plugin tool failed) is logged to the allowlist DM with the `correlation_id` (for `agents_send`) or `delivery_id` (for `webhook`) so the operator can correlate.
```

- [ ] **Step 2: Manual verification — webhook**

Use the smoke test from Task 8 (the `curl` against `http://localhost:8765/webhook/fake/test.ping`). With the orchestrator running and the dispatch-handler skill loaded, confirm a subagent gets spawned in `/tmp/fake-agent` and the orchestrator DMs the allowlist with a "webhook dispatched" log line.

- [ ] **Step 3: Manual verification — agents_send**

In the orchestrator session, ask a subagent to call `agents_send` with `target_name="fake"`, `message="hello"`. Confirm:
- The orchestrator spawns a subagent in `/tmp/fake-agent`.
- The fake agent's reply lands in `post_a2a_reply`.
- The originator retrieves it via `get_a2a_reply`.

- [ ] **Step 4: Commit**

```bash
git add templates/orchestrator/skills/dispatch-handler/
git commit -m "feat(orchestrator): dispatch-handler skill for webhook + agents_send"
```

---

## Task 15: Orchestrator `CLAUDE.md` — wire the new skills + describe `.agent/`

**Files:**
- Modify: `templates/orchestrator/CLAUDE.md`

- [ ] **Step 1: Read the existing CLAUDE.md**

Open `templates/orchestrator/CLAUDE.md`. Identify where to insert two additions:
- A new section describing the `.agent/` directory (placed after the existing "Architecture (context)" block).
- A "Startup checklist" section that names the three new skills (placed before the "On channel events" rule).

- [ ] **Step 2: Insert `.agent/` description**

After the existing `Architecture (context)` code block, add:

```markdown
## The `.agent/` directory

Your repo (and every agent's repo) contains an `.agent/` directory holding:

- `agent.toml` — the agent's contract: name, role, triggers, capabilities, declared secrets.
- `memory/MEMORY.md` + topical `.md` files — accumulated knowledge (tracked in git).
- `memory/threads/<thread_id>/` — per-invocation working memory (gitignored).
- `logs/<YYYY-MM-DD>/<thread_id>.jsonl` — append-only event log (gitignored).
- `state/` — orchestrator only: `routes.json`, `threads.json`, `access.json`.

Routine references:
- The contract is the source of truth for "what does this agent do." Read it via the slack-channel `get_agents` MCP tool, not by parsing files yourself.
- Memory promotion (thread → shared) is explicit: you move a file from `memory/threads/<id>/` to `memory/`, then update `MEMORY.md`.
```

- [ ] **Step 3: Insert "Startup checklist"**

Above the existing "Behavior rules" / "On channel events" section, add:

```markdown
## Startup checklist

Every orchestrator session begins with these three skills, in order:

1. **`registry-bootstrap`** — load the agent registry via the plugin's `get_agents` tool. Without this, none of the other skills can resolve agents by name.
2. **`cron-reconciler`** — ensure Claude Code's cron registry matches the static crons declared in agent contracts. Skip on operator request if the day's reconciliation already happened.
3. **`dispatch-handler`** — register your handlers for the webhook and `agents_send` notification types emitted by the plugin.

If any of the three fail to run cleanly, DM the orchestrator's allowlist with a status line so the operator can intervene.
```

- [ ] **Step 4: Manual verification**

Restart the orchestrator. Confirm the three skills load and run in order at session start, and the DM summary surfaces.

- [ ] **Step 5: Commit**

```bash
git add templates/orchestrator/CLAUDE.md
git commit -m "feat(orchestrator): wire new skills + describe .agent/ in CLAUDE.md"
```

---

## Task 16: User-facing documentation

**Files:**
- Create: `docs/agent-contract.md`
- Modify: `README.md`

- [ ] **Step 1: Write `docs/agent-contract.md`**

Create `docs/agent-contract.md`:

```markdown
# Agent Contract — Quick Reference

Each agent's repo declares itself via `.agent/agent.toml`. The orchestrator reads these contracts at startup, registers them, and dispatches Slack, cron, webhook, and agent-to-agent events accordingly.

## Minimal contract

```toml
contract_version = 1

[agent]
name         = "myproject"
role         = "agent"
persona_file = "CLAUDE.md"
```

The repo's `CLAUDE.md` (the agent's persona) stays where Claude Code already looks for it. The `.agent/` directory is additive.

## Full example

See the orchestrator template at `templates/orchestrator/.agent/agent.toml` for an orchestrator-role example, and the design spec at `docs/superpowers/specs/2026-05-05-agent-definition-contract-design.md` for the full schema reference.

## Required and optional fields

| Field | Required | Notes |
|---|---|---|
| `contract_version` | yes | Currently `1`. |
| `[agent]` | yes | At least `name`, `role`, `persona_file`. |
| `[triggers.slack]` | optional | `channel_id` for an agent; `mode = "workspace"` + `workspace_id` for the orchestrator. |
| `[[triggers.cron]]` | optional | `name` + `schedule` + `prompt`. |
| `[[triggers.webhook]]` | optional | `event` + `secret_name` + `prompt`. |
| `[capabilities]` | optional | `skills`/`mcps`/`clis` arrays. |
| `[[secrets]]` | optional | `name` only is required; `service_account` and `scopes` are hints. |
| `[storage]` | optional | `memory_retention`, `log_retention_days`. |
| `[network]` | optional | `allowed_outbound` — informational in MVP. |
| `[orchestrator]` | only when `role = "orchestrator"` | `state_dir` points at `.agent/state/`. |

## How the host resolves secrets

The contract names secrets — the host resolves them. On laptop:
- The `LaptopSecretResolver` reads `process.env`, populated from `~/.claude/channels/slack/.env` at plugin startup.

On AWS (subsystem C — future):
- An `AwsSecretsManagerResolver` will resolve names against AWS Secrets Manager or SSM Parameter Store. The contract doesn't change.

## Adding a new agent today

1. Create `.agent/agent.toml` in the repo with the minimal fields above.
2. Add the repo path to the `AGENT_ROOTS` env var (colon-separated) when you launch the orchestrator.
3. Restart the orchestrator. The `registry-bootstrap` skill will pick up the new contract.

For self-service onboarding (no manual editing), wait for subsystem B (`/slack-channel:migrate-to-agent-contracts` and friends).
```

- [ ] **Step 2: Add a short README pointer**

In `README.md`, find a good section (probably near "Project structure" or end). Add this short section:

```markdown
## Agent contract

Each agent declares its needs (skills, triggers, secrets) via `.agent/agent.toml` at the agent's repo root. The orchestrator reads these contracts at startup. See [`docs/agent-contract.md`](docs/agent-contract.md) for the schema; the design rationale lives in [`docs/superpowers/specs/2026-05-05-agent-definition-contract-design.md`](docs/superpowers/specs/2026-05-05-agent-definition-contract-design.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/agent-contract.md README.md
git commit -m "docs: agent contract quick reference + README pointer"
```

---

## Task 17: End-to-end smoke test

**Files:**
- Create: `e2e.test.ts`

- [ ] **Step 1: Write the e2e smoke test**

Create `e2e.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRegistry } from './registry.ts'
import { LaptopSecretResolver } from './secrets.ts'
import { startWebhookReceiver, type WebhookDispatch } from './webhook-receiver.ts'

let tmpRoot: string
const dispatches: WebhookDispatch[] = []
let port: number
let stop: () => Promise<void>

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-e2e-'))
  mkdirSync(join(tmpRoot, '.agent'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.agent', 'agent.toml'),
    `
contract_version = 1
[agent]
name         = "e2eproj"
role         = "agent"
persona_file = "CLAUDE.md"
[[triggers.webhook]]
event       = "test.ping"
secret_name = "E2E_HMAC"
prompt      = "ping: {{ payload.ok }}"
`,
  )
  process.env.E2E_HMAC = 'shh'

  const registry = loadRegistry([tmpRoot])
  expect(registry.size).toBe(1)

  const handle = await startWebhookReceiver({
    port: 0,
    registry,
    resolver: new LaptopSecretResolver(),
    onDispatch: (d) => { dispatches.push(d) },
  })
  port = handle.port
  stop = handle.stop
})

afterAll(async () => {
  await stop()
  delete process.env.E2E_HMAC
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('e2e: contract → registry → webhook → dispatch', () => {
  test('an HTTP POST is routed to the correct agent', async () => {
    const body = JSON.stringify({ ok: true })
    const sig =
      'sha256=' + createHmac('sha256', 'shh').update(body).digest('hex')
    const res = await fetch(`http://localhost:${port}/webhook/e2eproj/test.ping`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    })
    expect(res.status).toBe(202)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.agent_name).toBe('e2eproj')
    expect(dispatches[0]?.event).toBe('test.ping')
    expect(dispatches[0]?.payload).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: PASS — all suites (contract, registry, secrets, webhook-receiver, server smoke, e2e), plus the pre-existing gate suite.

- [ ] **Step 3: Commit**

```bash
git add e2e.test.ts
git commit -m "test: e2e contract → registry → webhook dispatch"
```

---

## Verification (whole-plan)

Run from the repo root after the final task:

```bash
bun test
```

Expected: all suites pass.

Manual end-to-end with a live orchestrator session:

1. Add `templates/orchestrator/.agent/agent.toml` (replace `<TEAM_ID>` with your workspace ID).
2. Set `AGENT_ROOTS=$ORCHESTRATOR_REPO_PATH:$PROJECTX_REPO_PATH` (colon-separated).
3. Set `WEBHOOK_PORT=8765` and `ENABLE_WEBHOOKS=1`.
4. Start: `./start.sh` (your existing wrapper).
5. Confirm:
   - Orchestrator's `registry-bootstrap` skill runs and DMs the allowlist with the loaded agents.
   - `cron-reconciler` reports created/updated/deleted counts.
   - A webhook `curl` (as in Task 8 step 6) shows up as a dispatched event in the target agent's logs.
   - An `agents_send` call from one routed agent to another succeeds via `get_a2a_reply`.

If any of the above fail, the failure surfaces in:
- The orchestrator's DMs to the allowlist (high-level errors).
- `bun:test` output (unit-level regressions).
- Plugin stderr (low-level plumbing).

---

## Out of scope (not in this plan — future)

- **Phase 2 — routed projects become agents (migration command).** Belongs in subsystem B.
- **Phase 3 — legacy cleanup, `prefer_agent_contracts` flag removal, AWS secret resolver.** After subsystems B and C ship.
- All deferred items from the spec's appendix (multi-medium reachability, generic API surface, N-to-M Slack binding, per-agent ACLs, network egress enforcement, append-only history, agent bundle format).
