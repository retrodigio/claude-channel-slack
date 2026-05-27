# Render fixtures

Data-driven regression cases for `renderSlackMessage` (see `../render.ts`).
Each `*.json` here is one captured Slack payload plus the exact string the
renderer must produce:

```json
{
  "name": "victorops-incident-section",
  "note": "what's interesting about this payload",
  "input":  { /* a literal Slack event, as server.ts receives it */ },
  "expected": "the exact renderSlackMessage(input) output"
}
```

`../render.fixtures.test.ts` loads every fixture and asserts
`renderSlackMessage(input) === expected`. Run with `bun test`.

## Why this exists

Real bot payloads (VictorOps, Scalyr, Google Cloud Monitoring, Block Kit) are
varied and surprising — content shows up in `attachments[].text`,
`attachments[].blocks[]`, top-level `blocks[]`, or nowhere useful. When a real
message renders wrong, capture it here as a permanent regression so it can't
silently break again.

## Adding a case from production

When `SLACK_INBOUND_LOG=<path>` is set, `server.ts` appends every inbound event
to that `.jsonl` (off by default — raw events can contain secrets, e.g. a Scalyr
`teamToken` in alert URLs, so treat the file as sensitive and scrub captured
payloads before committing them as fixtures). Pull a row out of it into a
fixture:

```sh
bun run fixtures/capture.ts <inbound.jsonl> <lineNumber> <name> ["note"]
```

This writes `fixtures/<name>.json` with `input` = that row's raw event and
`expected` = the **current** render output. **Review `expected` before
committing** — if it's wrong, fix `render.ts`; don't enshrine a bad render.

## Notable cases captured here

- `victorops-firing-full-detail.json` — the canonical case (the #90001 bug).
  An initial FIRING post carries the entire structured alert
  (`entity_display_name`, `alert_type`, `routing_key`, the full field dump) in
  `attachments[].blocks[]` section blocks. The renderer must surface all of it;
  pre-fix it rendered as the bare `[no preview available]`.
- `victorops-message-changed.json` — VictorOps re-edits its post; the edit
  arrives as a `message_changed` event whose body is nested under `msg.message`.
  The renderer doesn't unwrap that (and the `message` handler drops the
  subtype), so `expected` is `""`. This is correct, not a gap: the edit is a
  redundant re-send of content already delivered by the initial post above, so
  dropping it avoids re-triggering the agent with no loss of information.
- `scalyr-alert.json` — content is duplicated because Scalyr sends the same line
  in both top-level `text` (with the URL) and `blocks[]` (URL flattened). Kept
  as-is: redundant but lossless.
