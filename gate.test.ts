import { describe, expect, test } from 'bun:test'
import { decideChannelPolicy, DeliveryDeduper, isBotDMBlocked, type ChannelPolicy } from './gate.ts'

const HUMAN = 'U012ABCDE'
const BOT = 'B0123ABCD'
const OTHER_USER = 'U999ZZZZZ'
const OTHER_BOT = 'B999ZZZZZ'

const policy = (over: Partial<ChannelPolicy> = {}): ChannelPolicy => ({
  requireMention: false,
  allowFrom: [],
  ...over,
})

describe('decideChannelPolicy — humans (default-allow)', () => {
  test('drops when channel has no policy at all', () => {
    expect(decideChannelPolicy(undefined, HUMAN, true, false)).toBe('drop')
  })

  test('delivers with empty allowFrom (default-allow humans)', () => {
    expect(decideChannelPolicy(policy(), HUMAN, true, false)).toBe('deliver')
  })

  test('delivers when human is on populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), HUMAN, true, false)).toBe('deliver')
  })

  test('drops human not on a populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [OTHER_USER] }), HUMAN, true, false)).toBe('drop')
  })

  test('drops when requireMention=true and isMention=false (even if listed)', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [HUMAN] }), HUMAN, false, false)).toBe('drop')
  })

  test('delivers when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true }), HUMAN, true, false)).toBe('deliver')
  })
})

describe('decideChannelPolicy — bots (default-deny)', () => {
  test('drops bot when channel has no policy', () => {
    expect(decideChannelPolicy(undefined, BOT, false, true)).toBe('drop')
  })

  test('drops bot with empty allowFrom (this is the headline behavior change)', () => {
    expect(decideChannelPolicy(policy(), BOT, false, true)).toBe('drop')
  })

  test('drops bot whose id is not on a populated allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, OTHER_BOT] }), BOT, false, true)).toBe('drop')
  })

  test('delivers bot when its id is explicitly listed in allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('delivers bot listed alongside humans in allowFrom', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN, BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('drops listed bot when requireMention=true and isMention=false', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, false, true)).toBe('drop')
  })

  test('delivers listed bot when requireMention=true and isMention=true', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowFrom: [BOT] }), BOT, true, true)).toBe('deliver')
  })

  test('a populated allowFrom containing only humans does not implicitly admit any bot', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [HUMAN] }), BOT, false, true)).toBe('drop')
  })

  test('drops humans not on a populated allowFrom even when the list contains only bot ids', () => {
    // A populated allowFrom narrows humans to its listed ids — regardless of
    // whether those ids are users or bots. Consequence: if you opt a bot in
    // via allowFrom, you must also list every human you want to keep able to
    // trigger Claude in that channel. (Same rule as upstream's pre-patch
    // human allowlist; surfaced here because the bot path makes it new.)
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), HUMAN, true, false)).toBe('drop')
  })
})

describe('decideChannelPolicy — bots opted in via allowBots (no human side effect)', () => {
  const BOT_USER = 'U0B3RAP5A57' // the operator-visible "Bot User ID"

  test('delivers bot matched by bot id in allowBots', () => {
    expect(decideChannelPolicy(policy({ allowBots: [BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('delivers bot matched by its user id in allowBots (the id operators can actually see)', () => {
    expect(decideChannelPolicy(policy({ allowBots: [BOT_USER] }), BOT, false, true, BOT_USER)).toBe('deliver')
  })

  test('drops bot when neither its bot id nor user id is in allowBots', () => {
    expect(decideChannelPolicy(policy({ allowBots: [OTHER_BOT] }), BOT, false, true, BOT_USER)).toBe('drop')
  })

  test('allowBots does NOT narrow the human allowlist — humans still default-allow', () => {
    // The whole point of a separate field: opting a bot in must not flip the
    // channel into human-allowlist mode the way a populated allowFrom does.
    expect(decideChannelPolicy(policy({ allowBots: [BOT_USER] }), HUMAN, true, false)).toBe('deliver')
    expect(decideChannelPolicy(policy({ allowBots: [BOT_USER] }), OTHER_USER, true, false)).toBe('deliver')
  })

  test('opted-in bot still respects requireMention', () => {
    expect(decideChannelPolicy(policy({ requireMention: true, allowBots: [BOT_USER] }), BOT, false, true, BOT_USER)).toBe('drop')
    expect(decideChannelPolicy(policy({ requireMention: true, allowBots: [BOT_USER] }), BOT, true, true, BOT_USER)).toBe('deliver')
  })

  test('legacy: bot id in allowFrom still admits the bot (backward compatible)', () => {
    expect(decideChannelPolicy(policy({ allowFrom: [BOT] }), BOT, false, true)).toBe('deliver')
  })

  test('botUserId is ignored for humans (a human whose id happens to be passed is unaffected)', () => {
    expect(decideChannelPolicy(policy({ allowBots: [BOT_USER] }), HUMAN, true, false, BOT_USER)).toBe('deliver')
  })
})

describe('isBotDMBlocked', () => {
  test('blocks bot DMs', () => {
    expect(isBotDMBlocked('im', true)).toBe(true)
  })

  test('does not block bot channel posts', () => {
    expect(isBotDMBlocked('channel', true)).toBe(false)
  })

  test('does not block human DMs', () => {
    expect(isBotDMBlocked('im', false)).toBe(false)
  })

  test('does not block human channel posts', () => {
    expect(isBotDMBlocked('channel', false)).toBe(false)
  })
})

describe('DeliveryDeduper', () => {
  // Slack fires both app_mention and message for a mentioning channel message,
  // and the two server handlers are independent — this is what stops the session
  // seeing one message twice.
  test('the paired events for one message deliver exactly once', () => {
    const d = new DeliveryDeduper()
    expect(d.seenBefore('C123', '1785258082.837079')).toBe(false) // app_mention arrives
    expect(d.seenBefore('C123', '1785258082.837079')).toBe(true)  // message arrives 0.2s later
  })

  test('distinct messages are unaffected, including same ts in different channels', () => {
    const d = new DeliveryDeduper()
    expect(d.seenBefore('C123', '111.1')).toBe(false)
    expect(d.seenBefore('C123', '222.2')).toBe(false)
    expect(d.seenBefore('C999', '111.1')).toBe(false) // keyed on channel + ts, not ts alone
  })

  test('an unkeyable event is never suppressed — a duplicate turn beats a dropped one', () => {
    const d = new DeliveryDeduper()
    expect(d.seenBefore(undefined, '111.1')).toBe(false)
    expect(d.seenBefore(undefined, '111.1')).toBe(false)
    expect(d.seenBefore('C123', undefined)).toBe(false)
    expect(d.seenBefore('C123', undefined)).toBe(false)
    expect(d.size).toBe(0) // and nothing unkeyable is retained
  })

  test('bounded: oldest keys are evicted first and the cap holds', () => {
    const d = new DeliveryDeduper(3)
    for (const ts of ['1.0', '2.0', '3.0']) d.seenBefore('C1', ts)
    expect(d.size).toBe(3)
    d.seenBefore('C1', '4.0')          // evicts 1.0, the oldest
    expect(d.size).toBe(3)
    expect(d.seenBefore('C1', '4.0')).toBe(true)  // still remembered
    expect(d.seenBefore('C1', '3.0')).toBe(true)  // still remembered
    expect(d.seenBefore('C1', '1.0')).toBe(false) // evicted — fails open, as designed
  })

  test('eviction cannot be triggered by re-seeing an existing key', () => {
    const d = new DeliveryDeduper(2)
    d.seenBefore('C1', '1.0')
    d.seenBefore('C1', '2.0')
    for (let i = 0; i < 5; i++) d.seenBefore('C1', '2.0') // repeats must not churn the window
    expect(d.size).toBe(2)
    expect(d.seenBefore('C1', '1.0')).toBe(true)
  })
})
