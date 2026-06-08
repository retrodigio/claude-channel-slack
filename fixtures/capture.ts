#!/usr/bin/env bun
/**
 * Generate a render fixture from a captured inbound Slack event.
 *
 *   bun run fixtures/capture.ts <source.jsonl> <lineNumber> <name> [note]
 *
 * <source.jsonl> is usually a production inbound.jsonl (written by server.ts'
 * logInbound). Each row is { logged_at, handler, rendered, raw } — we take its
 * `raw`. A bare Slack payload (no `raw` wrapper) is also accepted.
 *
 * Writes fixtures/<name>.json = { name, note, input, expected }, where
 * `expected` is the CURRENT renderSlackMessage(input). REVIEW it before
 * committing: if it's wrong, that's a bug to fix in render.ts — don't enshrine
 * a bad render as the expectation.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { renderSlackMessage } from '../render.ts'

const [sourcePath, lineArg, name, note] = process.argv.slice(2)
if (!sourcePath || !lineArg || !name) {
  console.error('usage: bun run fixtures/capture.ts <source.jsonl> <lineNumber> <name> [note]')
  process.exit(1)
}

const lines = readFileSync(sourcePath, 'utf8').split('\n').filter((l) => l.trim())
const idx = Number(lineArg) - 1
if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) {
  console.error(`line ${lineArg} out of range (file has ${lines.length} lines)`)
  process.exit(1)
}

const row = JSON.parse(lines[idx]!)
const input = row && typeof row === 'object' && 'raw' in row ? row.raw : row
const expected = renderSlackMessage(input)

const outPath = join(import.meta.dir, `${name}.json`)
writeFileSync(outPath, JSON.stringify({ name, note: note ?? '', input, expected }, null, 2) + '\n')
console.error(`wrote ${outPath}`)
console.error('--- expected render (review before committing) ---')
console.error(JSON.stringify(expected))
