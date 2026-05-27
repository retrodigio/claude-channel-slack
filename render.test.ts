import { describe, expect, test } from 'bun:test'
import { renderSlackMessage } from './render.ts'

describe('renderSlackMessage — plain text', () => {
  test('returns top-level text unchanged', () => {
    expect(renderSlackMessage({ text: 'hello world' })).toBe('hello world')
  })

  test('keeps Slack mention markup intact (stripping happens downstream)', () => {
    expect(renderSlackMessage({ text: 'hey <@U123> ping' })).toBe('hey <@U123> ping')
  })
})

describe('renderSlackMessage — legacy attachments', () => {
  test('renders a VictorOps-shaped alert (text empty, payload in attachment)', () => {
    const msg = {
      text: '',
      attachments: [
        {
          fallback: 'CRITICAL: example-api 5xx Error',
          color: 'danger',
          pretext: 'Incident #90001',
          title: 'CRITICAL: example-api 5xx Error',
          text: '5xx error rate exceeded threshold',
          fields: [
            { title: 'entity_display_name', value: 'example-api 5xx Error', short: true },
            { title: 'alert_type', value: 'CRITICAL', short: true },
            { title: 'routing_key', value: 'sre', short: true },
            { title: 'state', value: 'firing', short: true },
          ],
          footer: 'Splunk On-Call',
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe(
      [
        'Incident #90001',
        'CRITICAL: example-api 5xx Error',
        '5xx error rate exceeded threshold',
        'entity_display_name: example-api 5xx Error',
        'alert_type: CRITICAL',
        'routing_key: sre',
        'state: firing',
        'Splunk On-Call',
      ].join('\n'),
    )
  })

  test('uses fallback when the attachment has no structured content', () => {
    const msg = { text: '', attachments: [{ fallback: 'Backup alert text' }] }
    expect(renderSlackMessage(msg)).toBe('Backup alert text')
  })

  test('ignores fallback once structured content is present (no duplication)', () => {
    const msg = {
      attachments: [{ title: 'Real title', fallback: 'Real title' }],
    }
    expect(renderSlackMessage(msg)).toBe('Real title')
  })

  test('renders attachment fields as "title: value", value-only, and title-only', () => {
    const msg = {
      attachments: [
        {
          fields: [
            { title: 'state', value: 'firing' },
            { value: 'bare value' },
            { title: 'lonely title' },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('state: firing\nbare value\nlonely title')
  })

  test('renders Block Kit nested inside an attachment (real VictorOps shape)', () => {
    // VictorOps puts incident state in attachments[].blocks[] and sets the
    // attachment fallback to the useless literal "[no preview available]".
    const msg = {
      text: '',
      attachments: [
        {
          color: '#29AF7B',
          fallback: '[no preview available]',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*<https://portal.victorops.com/ui/x/incident/90002|Incident #90002>* was *RESOLVED* for (example-api 5xx Error) by <@U0EXAMPLE01>',
              },
            },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe(
      '*<https://portal.victorops.com/ui/x/incident/90002|Incident #90002>* was *RESOLVED* for (example-api 5xx Error) by <@U0EXAMPLE01>',
    )
  })

  test('does not leak the fallback placeholder when nested blocks render', () => {
    const msg = {
      attachments: [
        {
          fallback: '[no preview available]',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'real content' } }],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('real content')
  })
})

describe('renderSlackMessage — Block Kit', () => {
  test('renders a header block', () => {
    const msg = {
      blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Deploy failed' } }],
    }
    expect(renderSlackMessage(msg)).toBe('Deploy failed')
  })

  test('renders a section with text and fields', () => {
    const msg = {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Service is degraded' },
          fields: [
            { type: 'mrkdwn', text: '*Env:* prod' },
            { type: 'mrkdwn', text: '*Region:* us-central1' },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('Service is degraded\n*Env:* prod\n*Region:* us-central1')
  })

  test('renders a context block, skipping image elements', () => {
    const msg = {
      blocks: [
        {
          type: 'context',
          elements: [
            { type: 'image', image_url: 'https://example/img.png', alt_text: 'logo' },
            { type: 'mrkdwn', text: 'fired at 15:50' },
            { type: 'plain_text', text: 'via VictorOps' },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('fired at 15:50 via VictorOps')
  })

  test('renders rich_text, concatenating leaves and re-encoding mentions', () => {
    const msg = {
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'hi ' },
                { type: 'user', user_id: 'U123' },
                { type: 'text', text: ' world' },
              ],
            },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('hi <@U123> world')
  })

  test('renders link, channel, and emoji leaves in rich_text', () => {
    const msg = {
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'see ' },
                { type: 'link', url: 'https://x.test', text: 'the runbook' },
                { type: 'text', text: ' in ' },
                { type: 'channel', channel_id: 'C42' },
                { type: 'text', text: ' ' },
                { type: 'emoji', name: 'fire' },
              ],
            },
          ],
        },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('see the runbook in <#C42> :fire:')
  })
})

describe('renderSlackMessage — skipping and edge cases', () => {
  test('skips actions, divider, and image blocks', () => {
    const msg = {
      blocks: [
        { type: 'divider' },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Ack' } }] },
        { type: 'image', image_url: 'https://example/graph.png', alt_text: 'graph' },
        { type: 'section', text: { type: 'mrkdwn', text: 'kept' } },
      ],
    }
    expect(renderSlackMessage(msg)).toBe('kept')
  })

  test('combines text, attachments, and blocks in order', () => {
    const msg = {
      text: 'top text',
      attachments: [{ title: 'attachment title' }],
      blocks: [{ type: 'header', text: { type: 'plain_text', text: 'block header' } }],
    }
    expect(renderSlackMessage(msg)).toBe('top text\nattachment title\nblock header')
  })

  test('returns empty when nothing recoverable (caller substitutes fallback)', () => {
    expect(renderSlackMessage({ text: '', attachments: [{}] })).toBe('')
    expect(renderSlackMessage({})).toBe('')
    expect(renderSlackMessage(undefined)).toBe('')
    expect(renderSlackMessage(null)).toBe('')
  })
})
