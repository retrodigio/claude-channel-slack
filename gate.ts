/**
 * Pure access-policy helpers for the Slack channel plugin.
 *
 * Extracted from server.ts so the policy decisions can be unit-tested
 * without spinning up the Slack/MCP runtime. server.ts imports these.
 */

export type ChannelPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /**
   * Bots opted into this channel. Entries may be either a Slack bot id
   * ("B…", as seen on a message event's `bot_id`) OR the bot's Slack user
   * id ("U…", the "Bot User ID" shown in app config — the only one an
   * operator can readily copy). A bot is admitted if EITHER of its ids
   * appears here. Kept separate from `allowFrom` on purpose: populating
   * `allowFrom` narrows the *human* allowlist (empty=all → listed-only), so
   * opting a bot in via `allowFrom` would silently lock out every human not
   * also listed. `allowBots` carries no such side effect on humans.
   */
  allowBots?: string[]
}

/**
 * Decide whether a channel message passes the channel-level access policy.
 *
 * Two senders are distinguished:
 *
 *   - Humans (Slack user ids, "U…") are default-allow. An empty `allowFrom`
 *     permits any sender; a populated `allowFrom` restricts to listed ids.
 *
 *   - Bots are default-deny. A bot is admitted only if one of its ids is
 *     opted in. `allowBots` is the dedicated channel of opt-in (matched
 *     against the bot id "B…" passed as `senderId` OR the bot's user id
 *     "U…" passed as `botUserId`). For backward compatibility a bot id
 *     listed directly in `allowFrom` is still honored. Empty `allowBots`
 *     (and no legacy `allowFrom` entry) blocks all bots.
 *
 * Both senders still respect `requireMention`.
 */
export function decideChannelPolicy(
  policy: ChannelPolicy | undefined,
  senderId: string,
  isMention: boolean,
  isBot: boolean,
  botUserId?: string,
): 'deliver' | 'drop' {
  if (!policy) return 'drop'
  const allowFrom = policy.allowFrom ?? []
  if (isBot) {
    // Opt-in via the dedicated allowBots field, OR (legacy) a bot id placed
    // directly in allowFrom. Match either the bot id or the bot's user id —
    // operators can only readily see the user id ("Bot User ID" in config).
    const optedIn = [...(policy.allowBots ?? []), ...allowFrom]
    const admitted = optedIn.includes(senderId) || (botUserId != null && optedIn.includes(botUserId))
    if (!admitted) return 'drop'
  } else if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
    return 'drop'
  }
  if (policy.requireMention && !isMention) return 'drop'
  return 'deliver'
}

/**
 * Bots may only reach the bot through opted-in channels. Bot DMs are
 * unconditionally dropped; the access skill cannot opt a bot into DMs.
 */
export function isBotDMBlocked(channelType: 'im' | 'channel', isBot: boolean): boolean {
  return isBot && channelType === 'im'
}
