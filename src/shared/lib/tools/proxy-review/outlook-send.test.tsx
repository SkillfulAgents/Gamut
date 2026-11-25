// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { customPreviewFor } from './custom-previews'
import { outlookDraftCreateCustomPreview, outlookDraftUpdateCustomPreview, outlookSendCustomPreview } from './outlook-send'

/** The request body as the card gets it: pretty-printed JSON when it parses, cut at 64,000 characters. */
const asCard = (body: unknown) => requestBodyPreview(new TextEncoder().encode(JSON.stringify(body)).buffer) ?? ''

const recipient = (address: string, name?: string) => ({ emailAddress: { address, ...(name === undefined ? {} : { name }) } })

const MESSAGE = { subject: 'Board deck v3', body: { contentType: 'Text', content: 'Deck v3 is attached.' }, toRecipients: [recipient('board@acme.test')] }

const send = (message: unknown, extra: Record<string, unknown> = {}) => asCard({ message, ...extra })

async function keepsTodaysCard(requestBody: string, preview = outlookSendCustomPreview) {
  expect(await preview.read(requestBody)).toBeUndefined()
}

describe('an Outlook send on the card', () => {
  it('shows every recipient, the HTML body with its inline image, that it has attachments, and every other part of the message in the details box', async () => {
    expect(customPreviewFor('outlook', 'POST', 'v1.0/me/sendMail')).toBe(outlookSendCustomPreview)
    expect(outlookSendCustomPreview.title).toBe('Allow sending this email from Outlook?')
    render(<>{await outlookSendCustomPreview.read(send({
      subject: 'Board deck v3',
      body: { contentType: 'HTML', content: '<p>Slide 9 has the new forecast.</p><img src="cid:chart"><a href="https://acme.test/deck">deck</a>' },
      from: recipient('ceo@acme.test', 'Acme CEO'),
      sender: recipient('assistant@acme.test'),
      toRecipients: [recipient('board@acme.test', 'Board'), recipient('wire@exfil.test', 'cfo@acme.test')],
      ccRecipients: [recipient('cfo@acme.test')],
      bccRecipients: [recipient('records@example.net')],
      replyTo: [recipient('intros@example.net')],
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'board-deck-v3.pdf', contentType: 'application/pdf', contentBytes: 'JVBERi0xLjQK' },
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'chart.png', contentType: 'IMAGE/PNG', contentBytes: 'iVBORw==', contentId: 'chart', isInline: true },
      ],
      internetMessageHeaders: [{ name: 'x-forward-to', value: 'collector@exfil.test' }, { name: 'x-trace.id', value: 'abc' }],
      importance: 'high',
      isReadReceiptRequested: false,
    }, { saveToSentItems: 'false' }))}</>)
    expect(screen.getByTestId('gmail-send').textContent).toContain('Acme CEO <ceo@acme.test>')
    expect(screen.getByTestId('gmail-send-summary').textContent).toBe('to Board, wire@exfil.test, cfo@acme.test, bcc: records@example.net')
    const envelope = screen.getByTestId('gmail-send-envelope').textContent
    for (const row of [
      'reply-to:intros@example.net',
      'sender:assistant@acme.test',
      'x-forward-to:collector@exfil.test',
      'x-trace.id:abc',
      'importance:high',
      'isReadReceiptRequested:false',
      'saveToSentItems:false',
    ]) expect(envelope).toContain(row)
    const frame = screen.getByTestId('email-html').getAttribute('srcdoc')
    expect(frame).toContain('Slide 9 has the new forecast.')
    expect(frame).toContain('src="data:IMAGE/PNG;base64,iVBORw=="')
    expect(screen.getByTestId('email-web-addresses').textContent).toContain('https://acme.test/deck')
    expect(screen.getByTestId('gmail-send-attachments').textContent).toBe('Has attachments, not shown.')
  })

  it('keeps today\'s card for a body the card cut short, so no recipient can hide past the cut', async () => {
    const requestBody = asCard({ ...MESSAGE, toRecipients: Array.from({ length: 1200 }, (_, index) => recipient(`r${index}@acme.test`)), bccRecipients: [recipient('leak@exfil.test')] })
    expect(requestBody.endsWith('…')).toBe(true)
    await keepsTodaysCard(requestBody, outlookDraftCreateCustomPreview)
  })

  it('keeps today\'s card for direction controls that could reorder what the card shows', async () => {
    await keepsTodaysCard(send({ ...MESSAGE, subject: 'Payroll \u202exslx.exe' }))
  })

  it('keeps today\'s card for a message that is not an object', async () => {
    await keepsTodaysCard(send([]))
  })

  it.each([
    ['another top-level key', send(MESSAGE, { Message: MESSAGE })],
    ['saveToSentItems as text other than true or false', send(MESSAGE, { saveToSentItems: 'no' })],
  ])('keeps today\'s card for a send with %s', async (_case, requestBody) => {
    await keepsTodaysCard(requestBody)
  })

  it('shows a text body with a contentId on a part that is not an image, since a text body places no image', async () => {
    render(<>{await outlookSendCustomPreview.read(send({ ...MESSAGE, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentType: 'application/pdf', contentId: 'a', contentBytes: 'AAAA' }] }))}</>)
    expect(screen.getByTestId('gmail-send-attachments').textContent).toBe('Has attachments, not shown.')
  })

  it('keeps today\'s card for a message with a key in another case', async () => {
    await keepsTodaysCard(send({ ...MESSAGE, BccRecipients: [recipient('leak@exfil.test')] }))
  })

  it.each([
    ['a list that is not an array', { bccRecipients: recipient('leak@exfil.test') }],
    ['an extra key beside emailAddress', { bccRecipients: [{ ...recipient('leak@exfil.test'), type: 'bcc' }] }],
    ['an extra key in emailAddress', { toRecipients: [{ emailAddress: { address: 'a@acme.test', Address: 'leak@exfil.test' } }] }],
    ['a blank address', { toRecipients: [recipient(' ')] }],
    ['a blank name', { toRecipients: [recipient('a@acme.test', ' ')] }],
    ['a name that is not text', { toRecipients: [{ emailAddress: { address: 'a@acme.test', name: 3 } }] }],
    ['angle brackets in a name', { toRecipients: [recipient('wire@exfil.test', 'CFO <cfo@acme.test>')] }],
  ])('keeps today\'s card for a recipient with %s', async (_case, recipients) => {
    await keepsTodaysCard(send({ ...MESSAGE, ...recipients }))
  })

  it.each([
    ['a from that is a list', { from: [recipient('ceo@acme.test')] }],
    ['a sender with no from', { sender: recipient('ceo@acme.test') }],
  ])('keeps today\'s card for %s', async (_case, sender) => {
    await keepsTodaysCard(send({ ...MESSAGE, ...sender }))
  })

  it.each([
    ['an extra key', { contentType: 'Text', content: 'hi', Content: 'other' }],
    ['another content type', { contentType: 'markdown', content: 'hi' }],
    ['content that is not text', { contentType: 'Text', content: ['hi'] }],
  ])('keeps today\'s card for a body with %s', async (_case, body) => {
    await keepsTodaysCard(send({ ...MESSAGE, body }))
  })

  it('keeps today\'s card for an attachment that is an attached item', async () => {
    await keepsTodaysCard(send({ ...MESSAGE, attachments: [{ '@odata.type': '#microsoft.graph.itemAttachment', name: 'Invoice', contentBytes: 'AAAA' }] }))
  })

  it.each([
    ['an extra key', { sourceUrl: 'https://exfil.test/a.pdf' }],
    ['a name that is not text', { name: ['a.pdf'] }],
    ['bytes that are not padded base64', { contentBytes: 'AAA' }],
  ])('keeps today\'s card for a file attachment with %s', async (_case, change) => {
    await keepsTodaysCard(send({ ...MESSAGE, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: 'AAAA', ...change }] }))
  })

  it.each([
    ['a value that is not text', [{ name: 'x-a', value: 1 }]],
    ['a name that does not start x-', [{ name: 'bcc', value: 'leak@exfil.test' }]],
    ['a name that reads as another row', [{ name: 'x-a: 1  bcc', value: 'leak@exfil.test' }]],
    ['a value with a line break', [{ name: 'x-a', value: 'b\nbcc: leak@exfil.test' }]],
  ])('keeps today\'s card for headers with %s', async (_case, internetMessageHeaders) => {
    await keepsTodaysCard(send({ ...MESSAGE, internetMessageHeaders }))
  })

  it.each([
    ['the body places with no attachment', [{ name: 'chart.png', contentType: 'image/png', contentId: 'other' }]],
    ['beside a part with a contentId that is not an image', [{ name: 'chart.png', contentType: 'image/png', contentId: 'chart' }, { name: 'logo.exe', contentType: 'application/x-msdownload', contentId: 'logo' }]],
    ['two parts share', [{ name: 'chart.png', contentType: 'image/png', contentId: 'chart' }, { name: 'other.png', contentType: 'image/png', contentId: 'chart' }]],
  ])('keeps today\'s card for an inline image %s', async (_case, attachments) => {
    await keepsTodaysCard(send({
      ...MESSAGE,
      body: { contentType: 'HTML', content: '<img src="cid:chart">' },
      attachments: attachments.map((attachment) => ({ '@odata.type': '#microsoft.graph.fileAttachment', contentBytes: 'iVBORw==', ...attachment })),
    }))
  })

  it('shows an HTML body whose text says cid:, since only attributes and style sheets place an attachment', async () => {
    render(<>{await outlookSendCustomPreview.read(send({ ...MESSAGE, body: { contentType: 'HTML', content: '<p>Reply with cid: and the case number.</p>' } }))}</>)
    expect(screen.getByTestId('email-html').getAttribute('srcdoc')).toContain('Reply with cid: and the case number.')
  })

  it('keeps today\'s card for an attachment the body places outside an image source', async () => {
    await keepsTodaysCard(send({
      ...MESSAGE,
      body: { contentType: 'HTML', content: '<img src="cid:chart"><p style="background:url(cid:chart)">Slide 9</p>' },
      attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'chart.png', contentType: 'image/png', contentId: 'chart', contentBytes: 'iVBORw==' }],
    }))
  })

  it('keeps today\'s card for an HTML body with an Outlook conditional comment, which classic Outlook draws and the card drops', async () => {
    await keepsTodaysCard(send({ ...MESSAGE, body: { contentType: 'HTML', content: '<p>Invoice attached.</p><!--[IF mso]><p>Changed payment instructions</p><![endif]-->' } }))
  })

  it('keeps today\'s card for every other Outlook path', () => {
    for (const path of ['v1.0/me/messages/AAMk=/reply', 'v1.0/me/messages/AAMk=/forward', 'v1.0/me/messages/AAMk=/createReply', 'v1.0/me/messages/AAMk=/send', 'v1.0/me/mailFolders/drafts/messages', 'v1.0/me/SendMail', 'v1.0/me/sendMail/']) {
      expect(customPreviewFor('outlook', 'POST', path)).toBeUndefined()
    }
  })
})

describe('an Outlook draft on the card', () => {
  it('shows the message at the body\'s root as the email it saves', async () => {
    expect(customPreviewFor('outlook', 'POST', 'v1.0/me/messages')).toBe(outlookDraftCreateCustomPreview)
    expect(outlookDraftCreateCustomPreview.title).toBe('Allow saving this draft in Outlook?')
    render(<>{await outlookDraftCreateCustomPreview.read(asCard({ ...MESSAGE, toRecipients: [recipient('priya@example.com', 'Priya Nair')] }))}</>)
    expect(screen.getByTestId('gmail-send').textContent).toContain('The connected account')
    expect(screen.getByTestId('gmail-send-summary').textContent).toBe('to Priya Nair')
    expect(screen.getByTestId('gmail-send-envelope').textContent).toContain('to:Priya Nair <priya@example.com>')
    expect(screen.getByTestId('gmail-send-body').textContent).toBe('Deck v3 is attached.')
    expect(screen.queryByTestId('gmail-send-attachments')).toBeNull()
    await keepsTodaysCard(asCard({ message: MESSAGE }), outlookDraftCreateCustomPreview)
  })
})

describe('an Outlook draft change on the card', () => {
  /** Each row as label and the value it sets. */
  async function changeRows(change: unknown) {
    render(<>{await outlookDraftUpdateCustomPreview.read(asCard(change))}</>)
    const card = screen.getByTestId('outlook-change')
    expect(card.querySelector('p')?.textContent).toBe('Draft · Changes')
    return [...card.querySelectorAll('dt')].map((label) => [label.textContent, label.nextElementSibling?.textContent])
  }

  it('shows only a body it sets', async () => {
    expect(customPreviewFor('outlook', 'PATCH', 'v1.0/me/messages/AAMk=')).toBe(outlookDraftUpdateCustomPreview)
    expect(outlookDraftUpdateCustomPreview.title).toBe('Allow changing this draft in Outlook?')
    expect(await changeRows({ body: { contentType: 'Text', content: 'Hi Priya,\n\nSetup moves to Friday.' } })).toEqual([['Body →', 'Hi Priya,\n\nSetup moves to Friday.']])
  })

  it('shows an HTML body it sets in the frame, lined up with its label', async () => {
    expect(await changeRows({ body: { contentType: 'HTML', content: '<p>Setup moves to Friday.</p>' } })).toEqual([['Body →', '']])
    const frame = screen.getByTestId('email-html').getAttribute('srcdoc')
    expect(frame).toContain('<p>Setup moves to Friday.</p>')
    expect(frame).toContain('body{padding:0}')
  })

  it('shows every key a full rewrite sets, in the order sent, and an empty recipient list as cleared', async () => {
    expect(await changeRows({
      subject: 'Renewal terms (revised)',
      body: { contentType: 'Text', content: 'Net 60 works for us.' },
      toRecipients: [recipient('priya@example.com', 'Priya Nair'), recipient('sam@acme.test')],
      ccRecipients: [recipient('cfo@acme.test', 'CFO')],
      bccRecipients: [],
      replyTo: [recipient('intros@example.net')],
      from: recipient('ceo@acme.test', 'Acme CEO'),
      sender: recipient('assistant@acme.test'),
      importance: 'high',
      isReadReceiptRequested: true,
      categories: ['Renewals', 'Q3'],
      flag: { flagStatus: 'flagged' },
    })).toEqual([
      ['Subject →', 'Renewal terms (revised)'],
      ['Body →', 'Net 60 works for us.'],
      ['To →', 'Priya Nair <priya@example.com>sam@acme.test'],
      ['Cc →', 'CFO <cfo@acme.test>'],
      ['Bcc →', 'cleared'],
      ['Reply-to →', 'intros@example.net'],
      ['From →', 'Acme CEO <ceo@acme.test>'],
      ['Sender →', 'assistant@acme.test'],
      ['Importance →', 'high'],
      ['Read receipt →', 'true'],
      ['Categories →', 'RenewalsQ3'],
      ['Flag →', '{"flagStatus":"flagged"}'],
    ])
  })

  it.each([
    ['attachments', { attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: 'AAAA' }] }],
    ['headers', { internetMessageHeaders: [{ name: 'x-forward-to', value: 'collector@exfil.test' }] }],
  ])('keeps today\'s card for a change that sets %s, which Graph sets only on a new message', async (_case, change) => {
    await keepsTodaysCard(asCard({ ...MESSAGE, ...change }), outlookDraftUpdateCustomPreview)
  })

  it('keeps today\'s card for a change that sets a detail to null, which Graph does not define for each detail', async () => {
    await keepsTodaysCard(asCard({ ...MESSAGE, flag: null }), outlookDraftUpdateCustomPreview)
  })

  it('keeps today\'s card for a change that sets only details, since it may be to a received message', async () => {
    await keepsTodaysCard(asCard({ importance: 'high', categories: ['Renewals'], flag: { flagStatus: 'flagged' } }), outlookDraftUpdateCustomPreview)
  })

  it('keeps today\'s card for a change to anything under a message', () => {
    for (const path of ['v1.0/me/messages/AAMk=/send', 'v1.0/me/messages/AAMk=/attachments', 'v1.0/me/messages/AAMk=/', 'v1.0/me/messages/']) {
      expect(customPreviewFor('outlook', 'PATCH', path)).toBeUndefined()
    }
  })
})
