import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { renderSlackMessage } from './render.ts'

/**
 * Data-driven render tests over real captured Slack payloads.
 *
 * Each fixture in fixtures/*.json is { name, note?, input, expected }, where
 * `input` is a literal Slack event (as captured by server.ts' inbound log) and
 * `expected` is the exact string renderSlackMessage() must produce. Add new
 * cases with `bun run fixtures/capture.ts` (see that file) — typically by
 * pulling a row out of a production inbound.jsonl.
 *
 * The point: when a real-world payload surprises us, we drop it in here as a
 * permanent regression so the renderer never silently breaks on it again.
 */

type Fixture = { name: string; note?: string; input: unknown; expected: string }

const FIX_DIR = join(import.meta.dir, 'fixtures')

const fixtures: Array<Fixture & { file: string }> = readdirSync(FIX_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(FIX_DIR, file), 'utf8')) as Fixture) }))

describe('render fixtures (real captured Slack payloads)', () => {
  test('fixtures directory is non-empty', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const fx of fixtures) {
    const label = fx.note ? `${fx.name} — ${fx.note}` : fx.name
    test(`${fx.file}: ${label}`, () => {
      expect(renderSlackMessage(fx.input)).toBe(fx.expected)
    })
  }
})
