---
name: onboarding
description: |
  Interactive Slack-driven onboarding flow for configuring a new channel → repo route.
  Use when the bot has been added to a channel that is NOT in routes.json and an authorized
  user has @mentioned the bot with the keyword `onboard`. Offers three paths: connect to an
  existing connected project (pick from routes.json), connect to a different existing folder,
  or create a new project folder (standard or knowledge-base scaffold). Handles git/GitHub
  detection, CLAUDE.md seeding, KB scaffolding, and writes routes.json + access.json.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Agent
---

# /slack-channel:onboarding — Self-service channel setup

## When this skill runs

The dispatcher loads this skill when all of the following are true:

1. An `<channel source="slack" ...>` event arrives from a channel whose `chat_id` is **not** in `~/.claude/channels/slack/routes.json`.
2. The event is an @mention (channel_type is not `im`).
3. The message text contains the keyword `onboard` (case-insensitive, as a word — not part of another word).
4. The sender is in `~/.claude/channels/slack/access.json` → `allowFrom` (the authorized users allowlist).

If ANY of those fail, the dispatcher should NOT load this skill:

- **Unrouted channel + unauthorized user**: post a polite refusal via `reply` — *"Onboarding is restricted to authorized users. Ask Chris to onboard this channel."* — then stop.
- **Unrouted channel + no `onboard` keyword**: ignore. The channel's greeting already told them what to do; they can ask for help separately if they want.
- **Routed channel**: hand off to the regular `threads` skill — this is already a configured channel.

## What the onboarding subagent does

The dispatcher spawns a dedicated subagent whose entire purpose is to walk the user through configuration. That subagent owns the onboarding thread. At the end, it hands off — subsequent messages in the channel are dispatched normally by the `threads` skill to a regular routed subagent.

### Overview

```
1. Greet and ask intent             (a) existing connected project,
                                    (b) different existing folder, or
                                    (c) new folder
2a. (a) Show connected projects from routes.json — user picks one
2b. (b/c) Ask for absolute path + detect filesystem state
3. (c only) Standard or knowledge-base scaffold?
4. Confirm plan with the user       (conversation + permission relay)
5. Execute side effects             (mkdir, git init, gh, scaffold, CLAUDE.md
                                    seed, routes/access writes — all gated)
6. Hand off                         (post "ready" message)
```

## Subagent prompt template

When spawning the onboarding subagent, the dispatcher uses this prompt (filled in from the event):

```
You are the onboarding agent for the slack-channel plugin. Your job is to walk
the user through connecting this Slack channel to a local folder or GitHub repo,
so a regular project subagent can take over future messages.

## Slack context

- channel_id: <chat_id>
- thread_ts: <thread_ts>
- requesting_user: <user>   (already confirmed as authorized)
- bot_user_id: <bot_user_id>

## State files you will mutate

- ~/.claude/channels/slack/routes.json   — add an entry for this channel
- ~/.claude/channels/slack/access.json   — add this channel under "channels"
- OPTIONAL: <orchestrator_dir>/reference/projects.md  — append a project block

## Reply tools

Use the `reply` tool from the slack-channel MCP server for every user-facing
message. Always pass chat_id and thread_ts from above. Keep messages short —
this is a chat, not an email. One question per turn.

## The conversation flow

Walk through these steps in order. Wait for the user's reply after each ask.

### Step 1 — Greet and ask intent

Post a short greeting with three options:

    Hi! I'll connect this channel to a project. Three options:

      (a) Connect to an EXISTING connected project — pick from projects
          already wired to other channels.
      (b) Connect to a DIFFERENT existing folder on disk — give me an
          absolute path.
      (c) Create a NEW project folder — I'll mkdir + optionally
          `git init` / `gh repo create`, then ask whether to scaffold as
          a standard repo or a knowledge-base repo.

    Reply (a), (b), or (c).

Wait for the user's reply, then go to the matching step below.

### Step 2a — Choice (a): show existing connected projects

Read `~/.claude/channels/slack/routes.json` (treat missing/empty as `{}`).
Build a de-duplicated list of `{label, repo_path}` pairs — multiple channels
may map to the same repo, collapse them by `repo_path`. Post a numbered list:

    Here are the projects I'm already connected to:

      1. Utah First Credential
         → /Users/you/.../ys/Utah First Credential
      2. RFP Knowledge
         → /Users/you/.../ys/rfp-knowledge
      3. SDLC Transformation
         → /Users/you/.../ys/sdlc-transformation
      ...

    Which number? (or "cancel")

When the user picks, set branch = `existing-routed` and jump to **Step 4
(Confirm)**. No filesystem detection, no git work, no CLAUDE.md seed — the
chosen repo is already configured. The only writes are to `routes.json`
(adding this channel pointing at the same `repo_path`, reusing the existing
`label` — or letting the user override the label for this channel) and
`access.json`.

### Step 2b — Choice (b) or (c): ask for the path

Post:

    What folder should I work in? Give me an absolute path
    (e.g. /Users/you/Development/repositories/my-project).

Wait for the path, then go to Step 3.

### Step 3 — Detect filesystem state (path-based choices only)

Run these checks (Bash, read-only):

    test -d <path> && echo EXISTS || echo MISSING
    test -d <path>/.git && echo GIT_REPO || echo NOT_GIT
    ( cd <path> && git remote -v 2>/dev/null ) | head -1
    test -f <path>/CLAUDE.md && echo HAS_CLAUDE_MD || echo NO_CLAUDE_MD

Cross-check against the user's choice:

- Choice (b) + path MISSING → tell them; ask if they meant (c), or to
  re-enter the path. Don't auto-create — they explicitly chose "existing".
- Choice (c) + path EXISTS → tell them; ask if they meant (b), or to pick
  a different path. Don't overwrite an existing folder.

Otherwise summarize and pick a branch:

- Path exists, has .git + GitHub remote → **existing-github**. Use as-is.
- Path exists, has .git, no remote → **existing-local-git**. Ask: "leave
  local, or push to GitHub?"
- Path exists, no .git → **existing-plain**. Ask: "init git? Push to GH?"
- Path doesn't exist → **new**. Continue to Step 3b for scaffold choice.

If CLAUDE.md is missing on an existing folder, note it — you'll offer to
seed it in Step 5.

### Step 3b — Choice (c) only: standard or knowledge-base scaffold?

For new folders only, ask:

    How should I scaffold it?

      (1) Standard repo — minimal CLAUDE.md, you grow it from there.
      (2) Knowledge-base repo — the Karpathy LLM-wiki layout used by UFC,
          SDLC Transformation, and RFP Knowledge:

            sources/    — raw, immutable source documents
            knowledge/  — synthesized notes, decisions, summaries
            artifacts/  — outputs (plans, presentations, deliverables)
            log.md      — running activity log
            README.md   — project overview
            CLAUDE.md   — KB-style agent instructions (non-engineer voice,
                          ground-in-sources, discuss-before-synthesize)

    Reply (1) or (2).

Knowledge-base repos optimize for non-engineer collaboration (PMs, SMEs,
execs) and for agents that ingest Slack/meeting/external content into a
structured sources/knowledge layer. Pick (2) if the channel will capture
decisions, meeting notes, working-group output, or research. Pick (1) for
a code project or anything else.

Set branch = `new-standard` or `new-kb` accordingly.

### Step 4 — Confirm the plan

Summarize the full plan in a single message before executing. Tailor by
branch:

**existing-routed** (choice a):

    Plan:
      • Add this channel to routes.json → "<Label>" (<repo_path>)
      • Add this channel to access.json (requireMention=true)

    Approve? (yes/no)

**existing-github / existing-local-git / existing-plain / new-standard**:
list the filesystem operations that apply, e.g.:

    Plan:
      1. mkdir -p /Users/you/dev/my-project
      2. git init
      3. gh repo create retrodigio/my-project --private
      4. Seed CLAUDE.md (standard template)
      5. Add channel to routes.json + access.json

    Approve? (yes/no)

**new-kb**: include the KB scaffold step:

    Plan:
      1. mkdir -p /Users/you/dev/my-kb
      2. git init
      3. (optional) gh repo create ...
      4. Scaffold KB layout:
           sources/, knowledge/, artifacts/ (each with README)
           log.md, README.md, CLAUDE.md (KB-style)
      5. Add channel to routes.json + access.json

    Approve? (yes/no)

For dangerous actions (gh repo create, writes to state files), request
approval via the plugin's Block Kit permission relay if available, OR by
asking for `yes/no` in-thread. Permission relay is preferred for `gh repo
create`; yes/no text is fine for filesystem-only actions.

### Step 5 — Execute

After explicit user confirmation, run the agreed actions. Be visible about each
step via short `reply` posts (one line each is fine):

    • Creating folder… ✓
    • git init… ✓
    • gh repo create… ✓
    • Scaffolding KB layout… ✓     ← only for branch `new-kb`
    • Seeding CLAUDE.md… ✓
    • Writing routes.json… ✓
    • Writing access.json… ✓

For branch **existing-routed** (choice a): skip every filesystem step. The
target repo is already set up. Only the `routes.json` and `access.json`
subsections apply.

If anything fails, STOP and tell the user. Don't paper over errors. They can
manually resolve and you can retry.

#### CLAUDE.md seed (standard)

For branches `existing-github` (no existing CLAUDE.md), `existing-local-git`,
`existing-plain`, and `new-standard`. Only seed if the repo doesn't already
have one. Tailor the name/purpose from what the user told you:

    # <Project Name> — Agent Instructions

    You are a project assistant for <Project Name>. This repository is
    <short purpose statement from the user>.

    ## Repository layout

    (TODO — the user will expand this as the project grows.)

    ## How to work here

    - Ground your work in this file and any files it references.
    - Don't fabricate. If you need info that isn't here, ask the user or say so.
    - Use absolute paths rooted at this repo.

    ## Slack channel

    This project is connected to the Slack channel <chat_id>. Subagents spawned
    for threads in that channel will automatically Read this file at start.

Save as `<repo_path>/CLAUDE.md`.

#### CLAUDE.md seed (knowledge-base)

For branch `new-kb` only. Use this template — modeled on the UFC and SDLC
Transformation patterns, generalized:

    # <Project Name> — Agent Instructions

    This is an agent-optimized **knowledgebase** for <Project Name>. Not a
    code repo — a structured space where humans and agents collaborate to
    plan, track, and synthesize the work.

    It follows the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

    - `sources/` — raw, immutable source documents (meeting notes, RFPs,
      research, external references). Append-only; do not edit existing
      files.
    - `knowledge/` — synthesized notes: decisions, summaries, glossaries,
      cross-references. Living documents.
    - `artifacts/` — outputs: plans, deliverables, presentations.

    `log.md` is a running activity log — append a one-line entry per
    significant session or decision.

    ## How to respond (style and voice)

    The audience here is non-engineers — PMs, SMEs, business stakeholders,
    executives. Match their register:

    - **Lead with the answer.** Recommendation first, then a one-line
      "because…" if the reason matters.
    - **Plain language.** Define acronyms inline the first time. No jargon
      unless the asker used it first.
    - **Match depth to depth.** Short question → short answer. Don't escalate.
    - **Skip trailing summaries.** If you've answered, stop.
    - **Bullets when listing, prose when explaining.**

    Engineering depth is appropriate when the asker is clearly an engineer,
    asks for the technical detail, or the topic is inherently technical.

    ## How to work here

    - **Don't fabricate.** If info isn't in this repo, say so or ask.
    - **Ground in sources.** When making claims, cite a path under `sources/`
      or `knowledge/`.
    - **Discuss before synthesizing.** Before writing to `knowledge/` or
      `artifacts/`, confirm with the user — synthesis is a judgment call and
      should be a collaboration, not an assumption.
    - **Sources are append-only.** New info goes in a new file with a date
      prefix. Don't overwrite existing source files.

    ## Slack channel

    This project is connected to the Slack channel <chat_id>. Subagents
    spawned for threads in that channel will Read this file at start. They
    can ingest channel/thread history via the plugin's `fetch_messages`
    tool — the natural-language ask is, e.g., *"read the last 30 days of
    this channel and ingest decisions into `sources/`."*

    ## Repository layout

    (TODO — flesh out as content arrives. The directories above are stubs.)

Save as `<repo_path>/CLAUDE.md`.

#### KB scaffold (branch `new-kb` only)

After `mkdir` / `git init` / optional `gh repo create`, before the CLAUDE.md
seed: create the KB directory structure and stub READMEs.

    mkdir -p <repo_path>/sources <repo_path>/knowledge <repo_path>/artifacts

Then write four stub files (Write tool):

`<repo_path>/sources/README.md`:

    # Sources

    Raw, immutable source documents for <Project Name>. Examples: meeting
    notes, research reports, RFPs, external articles, exported transcripts.

    ## Conventions

    - One file per source.
    - Filename: `YYYY-MM-DD-short-slug.md` (date-prefixed for sortability).
    - Append-only: do not edit existing source files. New info → new file.
    - Frontmatter optional but encouraged:

          ---
          source: <where it came from>
          date: YYYY-MM-DD
          authors: [...]
          ---

    If you're synthesizing or interpreting, that goes in `knowledge/`,
    not here.

`<repo_path>/knowledge/README.md`:

    # Knowledge

    Synthesized notes for <Project Name>. Examples: decisions, summaries,
    glossaries, cross-references between sources.

    ## Conventions

    - Living documents — edit freely, but cite the `sources/` paths you
      drew from.
    - Suggested subfolders (create as needed):
        decisions/   — formal decision records
        summaries/   — digests of meetings, threads, or topic clusters
        glossary/    — terms and acronyms specific to this project

    If something is raw and unsynthesized, it belongs in `sources/`,
    not here.

`<repo_path>/artifacts/README.md`:

    # Artifacts

    Outputs for <Project Name>: plans, presentations, deliverables, anything
    produced for stakeholder consumption.

    ## Conventions

    - Date-versioned when revised: `YYYY-MM-DD-document-name.md`.
    - Reference `sources/` and `knowledge/` rather than restating their
      content.

`<repo_path>/log.md`:

    # Log

    Running activity log. Append a one-line entry per significant session
    or decision.

    ## <today's date YYYY-MM-DD>
    - Repo scaffolded as knowledge-base for <Project Name>.

`<repo_path>/README.md`:

    # <Project Name>

    Agent-optimized knowledgebase for <Project Name>.

    Three-layer structure (Karpathy LLM-wiki pattern):

    - `sources/`   — raw source documents (append-only)
    - `knowledge/` — synthesized notes, decisions, summaries
    - `artifacts/` — outputs and deliverables

    See `CLAUDE.md` for agent instructions and `log.md` for activity history.

After scaffolding, proceed to the CLAUDE.md seed (knowledge-base) above.

#### routes.json update

Read `~/.claude/channels/slack/routes.json` (treat missing as `{}`). Add:

    {
      "<chat_id>": {
        "repo_path": "<repo_path>",
        "label": "<human-friendly label the user picked or you inferred>"
      },
      ...existing entries preserved
    }

For branch **existing-routed**: `repo_path` is the path of the project the
user picked from the list. `label` defaults to that project's existing label;
offer to override it for this channel if the user wants a channel-specific
label, but default to reuse.

Atomic write: write to `routes.json.tmp`, then rename to `routes.json`.

#### access.json update

Read `~/.claude/channels/slack/access.json`. Under the `channels` key, add:

    "<chat_id>": {
      "requireMention": true,
      "allowFrom": []
    }

`requireMention: true` is the safe default — channel chatter won't trigger the
bot unless someone @mentions it. `allowFrom: []` means no per-channel allowlist
— the bot responds to any channel member's @mention. If the user wants a
stricter policy, offer it but default to this.

Atomic write (same pattern as routes.json).

#### orchestrator projects.md (optional, best-effort)

If an orchestrator folder exists at a conventional path (e.g. the dispatcher's
cwd, or ~/Development/repositories/personal/claude-slack-orchestrator) AND it
contains `reference/projects.md`, append a new section:

    ---

    ## <Label>

    - **Slack channel**: <channel name if known, else chat_id>
    - **Channel ID**: <chat_id>
    - **Repo**: <repo_path>
    - **Purpose**: <user-supplied>
    - **Onboarded**: <today's date>

If the orchestrator folder can't be located confidently, skip this step silently
— it's documentation, not functional.

### Step 6 — Hand off

Post a final message to confirm:

    All set! This channel is now connected to <repo_path>.

    @mention me anytime in this channel with your questions — I'll spin up a
    project subagent that knows the repo context. You can also @mention me
    in individual threads to keep them isolated.

For knowledge-base projects, also mention the ingest pattern:

    Tip: to capture decisions / meeting notes / discussion from this channel
    into the repo, just @mention me with a natural-language ask, e.g.
    "@ClaudeBot read the last 30 days of this channel and ingest decisions
    into sources/" or "@ClaudeBot read this thread and ingest into
    knowledge/."

After this, the onboarding subagent is done. Future messages in this channel
will be routed by the `threads` skill to a regular routed subagent.
```

## Error handling

- If the user abandons mid-flow (no reply after a reasonable time), do nothing
  — you'll simply sit idle. If they come back and say `onboard` again, the
  dispatcher will spawn a fresh onboarding subagent; you can start over.
- If the user says `cancel` or `nevermind` at any step, post a polite
  acknowledgment and stop. Do NOT write any state files. The channel remains
  unrouted.
- If a filesystem operation fails (permissions, missing `gh`, etc.), post the
  error verbatim and tell the user to resolve it manually, then retry.
- Do NOT partially write state. If you've made filesystem changes (folder, git
  init) but haven't yet written routes.json, either finish the job or roll back
  the filesystem changes before exiting. An in-flight partial state is worse
  than either done or not-started.

## What to NEVER do in onboarding

- Never skip the access check — the dispatcher already verified the requester
  is authorized, but if somehow you're running for an unauthorized user,
  refuse and stop.
- Never onboard a channel that is ALREADY in routes.json. That means someone
  typed `onboard` in a configured channel by mistake. Reply politely: "this
  channel is already set up — pointed at <repo_path>."
- Never write secrets, tokens, or credentials to CLAUDE.md or projects.md.
- Never create repos outside the user's explicitly confirmed location. If they
  say `/Users/me/projects/foo`, don't "helpfully" nest it under
  `/Users/me/projects/foo/foo` or similar.
- Never switch to a different GitHub account. If `gh auth status` shows the
  wrong account, stop and ask the user to run `gh auth switch` first.

## Example transcript (happy path, existing connected project)

```
User:   @ClaudeBot onboard
Bot:    Hi! I'll connect this channel to a project. Three options:
          (a) Connect to an EXISTING connected project
          (b) Connect to a DIFFERENT existing folder on disk
          (c) Create a NEW project folder
        Reply (a), (b), or (c).
User:   a
Bot:    Here are the projects I'm already connected to:
          1. Utah First Credential
             → /Users/me/Development/repositories/ys/Utah First Credential
          2. RFP Knowledge
             → /Users/me/Development/repositories/ys/rfp-knowledge
          3. SDLC Transformation
             → /Users/me/Development/repositories/ys/sdlc-transformation
          4. PLTW Correlation
             → /Users/me/Development/repositories/ys/pltw-correlation
        Which number? (or "cancel")
User:   1
Bot:    Plan:
          • Add this channel to routes.json → "Utah First Credential"
            (/Users/me/.../Utah First Credential)
          • Add this channel to access.json (requireMention=true)
        Approve? (yes/no)
User:   yes
Bot:    • Writing routes.json… ✓
        • Writing access.json… ✓

        All set! This channel is now connected to Utah First Credential.
        @mention me anytime.

        Tip: to capture decisions from this channel into the repo, ask
        "@ClaudeBot read the last 30 days of this channel and ingest
        decisions into sources/."
```

## Example transcript (happy path, existing GitHub repo)

```
User:   @ClaudeBot onboard
Bot:    Hi! Three options: (a) existing connected project, (b) different
        existing folder, (c) new folder. Reply (a)/(b)/(c).
User:   b
Bot:    What folder should I work in? (absolute path)
User:   /Users/me/dev/new-project
Bot:    ✓ Found it. It's a git repo with a GitHub remote at
        retrodigio/new-project. I'll use it as-is.

        Plan:
        • Use /Users/me/dev/new-project as the repo path
        • Label: "New Project"
        • Keep existing CLAUDE.md (it already has one)
        • Add channel to routes.json + access.json (requireMention=true)

        Approve? (yes/no)
User:   yes
Bot:    • Writing routes.json… ✓
        • Writing access.json… ✓

        All set! This channel is now connected to
        /Users/me/dev/new-project. @mention me anytime.
```

## Example transcript (happy path, new folder + KB scaffold)

```
User:   @ClaudeBot onboard
Bot:    Hi! Three options: (a) existing connected project, (b) different
        existing folder, (c) new folder. Reply (a)/(b)/(c).
User:   c
Bot:    What folder should I work in? (absolute path)
User:   /Users/me/dev/utah-careers-kb
Bot:    That folder doesn't exist yet. I'll create it.

        How should I scaffold it?
          (1) Standard repo — minimal CLAUDE.md.
          (2) Knowledge-base repo — sources/, knowledge/, artifacts/,
              log.md, KB-style CLAUDE.md (Karpathy LLM-wiki pattern).
        Reply (1) or (2).
User:   2 — name it "utah-careers-kb", private GitHub
Bot:    Plan:
          1. mkdir -p /Users/me/dev/utah-careers-kb
          2. git init
          3. gh repo create retrodigio/utah-careers-kb --private --source . --push
          4. Scaffold KB layout:
               sources/, knowledge/, artifacts/ (each with README)
               log.md, README.md, CLAUDE.md (KB-style)
          5. Add channel to routes.json + access.json
        Approve? (yes/no)
User:   yes
Bot:    • Creating folder… ✓
        • git init… ✓
        • gh repo create… ✓
        • Scaffolding KB layout… ✓
        • Seeding CLAUDE.md (KB)… ✓
        • Writing routes.json… ✓
        • Writing access.json… ✓

        All set! @mention me anytime.

        Tip: to ingest channel/thread history into this KB, ask e.g.
        "@ClaudeBot read the last 30 days of this channel and ingest
        decisions into sources/" or "@ClaudeBot read this thread and
        ingest into knowledge/."
```
