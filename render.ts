/**
 * Pure Slack message renderer for the Slack channel plugin.
 *
 * Inbound Slack messages frequently carry their human-readable content in
 * `attachments[]` (legacy bot integrations — VictorOps, Google Cloud
 * Monitoring) or `blocks[]` (Block Kit), leaving the top-level `text` field
 * empty. server.ts historically read only `text`, so those messages reached
 * Claude as the bare placeholder "(attachment)" with no recoverable payload.
 *
 * This renderer walks all three sources and flattens them to plain text.
 * Extracted from server.ts (mirrors the gate.ts split) so it can be
 * unit-tested without spinning up the Slack/MCP runtime.
 *
 * It is deliberately defensive: Slack payloads are loosely typed and vary by
 * app age, so every field is optional and anything unrecognised is ignored.
 */

// A Slack "text object": { type: 'mrkdwn' | 'plain_text', text: '…' }.
type TextObject = { type?: string; text?: string }

type AttachmentField = { title?: string; value?: string }

type Attachment = {
  pretext?: string
  title?: string
  text?: string
  fields?: AttachmentField[]
  footer?: string
  fallback?: string
  blocks?: Block[]
}

type Block = {
  type?: string
  text?: TextObject
  fields?: TextObject[]
  elements?: any[]
}

export type SlackMessage = {
  text?: string
  attachments?: Attachment[]
  blocks?: Block[]
}

/**
 * Render one legacy attachment. Walks pretext → title → text → fields →
 * nested blocks → footer.
 *
 * The nested-blocks walk matters: VictorOps/Splunk On-Call puts the incident
 * state (FIRING/RESOLVED, entity name, incident link) in a Block Kit `section`
 * nested inside `attachments[].blocks[]`, and sets the attachment `fallback`
 * to the literal placeholder "[no preview available]". Without walking nested
 * blocks the renderer would surface only that useless fallback.
 *
 * `fallback` is therefore used only when nothing structured was recoverable —
 * otherwise it would either duplicate the body or leak the placeholder.
 */
function renderAttachment(att: Attachment): string {
  const parts: string[] = []
  if (att.pretext) parts.push(att.pretext)
  if (att.title) parts.push(att.title)
  if (att.text) parts.push(att.text)
  for (const f of att.fields ?? []) {
    const title = f?.title?.trim()
    const value = f?.value?.trim()
    if (title && value) parts.push(`${title}: ${value}`)
    else if (value) parts.push(value)
    else if (title) parts.push(title)
  }
  for (const block of att.blocks ?? []) {
    const rendered = renderBlock(block)
    if (rendered) parts.push(rendered)
  }
  if (att.footer) parts.push(att.footer)
  if (parts.length === 0 && att.fallback) parts.push(att.fallback)
  return parts.join('\n')
}

/**
 * Render one leaf element inside a rich_text section. Mentions, channels and
 * emoji are re-encoded into Slack's `<…>`/`:…:` source forms so downstream
 * handling (e.g. the `<@USER>` strip in the mention handler) stays uniform.
 */
function renderRichLeaf(leaf: any): string {
  switch (leaf?.type) {
    case 'text':
      return leaf.text ?? ''
    case 'link':
      return leaf.text ?? leaf.url ?? ''
    case 'user':
      return leaf.user_id ? `<@${leaf.user_id}>` : ''
    case 'usergroup':
      return leaf.usergroup_id ? `<!subteam^${leaf.usergroup_id}>` : ''
    case 'channel':
      return leaf.channel_id ? `<#${leaf.channel_id}>` : ''
    case 'emoji':
      return leaf.name ? `:${leaf.name}:` : ''
    case 'broadcast':
      return leaf.range ? `<!${leaf.range}>` : ''
    default:
      return ''
  }
}

/**
 * Render a rich_text block's contents. The block holds section-level
 * containers (rich_text_section, rich_text_list, rich_text_quote,
 * rich_text_preformatted); leaves within a container concatenate directly,
 * containers are separated by newlines.
 */
function renderRichText(elements: any[]): string {
  const sections: string[] = []
  for (const container of elements) {
    let s = ''
    for (const leaf of container?.elements ?? []) {
      s += renderRichLeaf(leaf)
    }
    if (s) sections.push(s)
  }
  return sections.join('\n')
}

/**
 * Render one Block Kit block. Sections and headers contribute their text and
 * fields; context contributes its text elements (images skipped). Actions,
 * dividers, images and anything else carry no recoverable text.
 */
function renderBlock(block: Block): string {
  switch (block?.type) {
    case 'header':
    case 'section': {
      const parts: string[] = []
      if (block.text?.text) parts.push(block.text.text)
      for (const f of block.fields ?? []) {
        if (f?.text) parts.push(f.text)
      }
      return parts.join('\n')
    }
    case 'context': {
      const parts: string[] = []
      for (const el of block.elements ?? []) {
        if (el?.type === 'image') continue
        if (el?.text) parts.push(el.text)
      }
      return parts.join(' ')
    }
    case 'rich_text':
      return renderRichText(block.elements ?? [])
    default:
      return ''
  }
}

/**
 * Flatten a Slack message to plain text by walking `text`, then each
 * attachment, then each block, joining whatever rendered with newlines.
 * Returns '' when nothing was recoverable; the caller substitutes its own
 * last-resort placeholder.
 */
export function renderSlackMessage(msg: SlackMessage | undefined | null): string {
  if (!msg) return ''
  const parts: string[] = []
  if (msg.text) parts.push(msg.text)
  for (const att of msg.attachments ?? []) {
    const rendered = renderAttachment(att)
    if (rendered) parts.push(rendered)
  }
  for (const block of msg.blocks ?? []) {
    const rendered = renderBlock(block)
    if (rendered) parts.push(rendered)
  }
  return parts.join('\n')
}
