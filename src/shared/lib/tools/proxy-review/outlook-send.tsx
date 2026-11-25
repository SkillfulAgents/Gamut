import type { ReactNode } from 'react'
import { ClampedBody, EmailHtml, WebAddresses, decodedValues, webAddresses, withImages } from './email-html'
import { bodyOf, isRecord } from './github'
import { GmailSendView, type GmailSend } from './gmail-send'
import type { CustomPreview } from './custom-previews'

/**
 * Message keys the card draws, each in its own place. Graph reads key names in any case, so any other spelling, or any other key,
 * keeps today's card.
 */
const PLACED_KEYS = new Set(['subject', 'body', 'from', 'sender', 'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo', 'attachments', 'internetMessageHeaders'])
/** Message keys the card lists in the details box as sent. */
const DETAIL_KEYS = new Set(['importance', 'isReadReceiptRequested', 'isDeliveryReceiptRequested', 'categories', 'flag'])
const SEND_KEYS = new Set(['message', 'saveToSentItems'])
const ATTACHMENT_KEYS = new Set(['@odata.type', 'name', 'contentType', 'contentBytes', 'contentId', 'isInline'])

const hasOnly = (record: Record<string, unknown>, keys: ReadonlySet<string>) => Object.keys(record).every((key) => keys.has(key))
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'
const optionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean'

/** A value as sent. Anything but a non-empty string is shown as JSON, so an empty string or false stays visible. */
const shown = (value: unknown) => (typeof value === 'string' && value ? value : JSON.stringify(value))

/** Characters that would split a name from its address differently on the card. */
const ADDRESS_BREAKS = /[<>\r\n\u2028\u2029]/

/** One `{ emailAddress: { address, name } }` as `Name <address>`, or the address when it has no name. */
function addressOf(value: unknown): string | undefined {
  const emailAddress = isRecord(value) && Object.keys(value).length === 1 ? value.emailAddress : undefined
  if (!isRecord(emailAddress) || !hasOnly(emailAddress, new Set(['address', 'name']))) return undefined
  const { address, name } = emailAddress
  if (typeof address !== 'string' || !address.trim() || !optionalString(name) || name?.trim() === '' || ADDRESS_BREAKS.test(`${address}${name ?? ''}`)) return undefined
  return name === undefined ? address : `${name} <${address}>`
}

/** A list where every entry reads. Absent is none. */
function listOf<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries = value.map(read)
  return entries.every((entry): entry is T => entry !== undefined) ? entries : undefined
}

/** The body, text or HTML. Absent is empty. */
function contentOf(value: unknown): { html?: string; text: string } | undefined {
  if (value === undefined) return { text: '' }
  if (!isRecord(value) || !hasOnly(value, new Set(['contentType', 'content'])) || typeof value.content !== 'string' || typeof value.contentType !== 'string') return undefined
  if (/^html$/i.test(value.contentType)) return { html: value.content, text: '' }
  return /^text$/i.test(value.contentType) ? { text: value.content } : undefined
}

/** Padded base64, as Graph takes an attachment's bytes. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** A file attachment. Any other kind, such as a link to a shared file or an attached item, keeps today's card. */
function fileAttachmentOf(value: unknown) {
  if (!isRecord(value) || value['@odata.type'] !== '#microsoft.graph.fileAttachment' || !hasOnly(value, ATTACHMENT_KEYS)) return undefined
  const { name, contentType, contentBytes, contentId, isInline } = value
  if (typeof name !== 'string' || typeof contentBytes !== 'string' || !BASE64.test(contentBytes)) return undefined
  if (!optionalString(contentType) || !optionalString(contentId) || !optionalBoolean(isInline)) return undefined
  return { contentType, contentBytes, contentId }
}

/**
 * An extra header, as a details row. Graph takes only `x-` names, so a name that could pass for a recipient row keeps today's card,
 * as does a value with a line break, which would read as a second row.
 */
function headerOf(header: unknown): { label: string; value: string } | undefined {
  return isRecord(header) && hasOnly(header, new Set(['name', 'value'])) && typeof header.name === 'string' && /^x-[\x21-\x39\x3b-\x7e]+$/i.test(header.name) && typeof header.value === 'string' && !/[\r\n\u2028\u2029]/.test(header.value)
    ? { label: header.name, value: shown(header.value) }
    : undefined
}

/**
 * Whether the body names an attachment anywhere the card cannot draw it. Only an image whose source is one of the attachments it read
 * draws, so a `cid:` in a style, a style sheet, or any other attribute counts. Text is not read, so prose that says "cid:" draws.
 */
function hidesAnImage(html: string, images: ReadonlyMap<string, string>) {
  const page = new DOMParser().parseFromString(html, 'text/html')
  for (const image of page.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    if (src.startsWith('cid:') && images.has(src.slice(4))) image.removeAttribute('src')
  }
  return decodedValues(page).some((value) => /cid:/i.test(value))
}

/**
 * The email in an Outlook send, new draft, or draft change, read from the request body the card shows. Undefined when the copy is
 * cut short, or any part does not read in full. A send carries its message under `message`, a draft is the message itself.
 */
function readOutlookMessage(requestBody: string, draft: boolean): GmailSend | undefined {
  const body = bodyOf(requestBody)
  const message = draft ? body : body?.message
  if (!body || !isRecord(message)) return undefined
  // Graph's own sendMail example sends saveToSentItems as the text "false".
  if (!draft && (!hasOnly(body, SEND_KEYS) || !(optionalBoolean(body.saveToSentItems) || body.saveToSentItems === 'true' || body.saveToSentItems === 'false'))) return undefined
  if (!Object.keys(message).every((key) => PLACED_KEYS.has(key) || DETAIL_KEYS.has(key))) return undefined
  const from = message.from === undefined ? undefined : addressOf(message.from)
  const sender = message.sender === undefined ? undefined : addressOf(message.sender)
  // Without a from, the card cannot say which mailbox the sender sends for.
  if ((message.from !== undefined && !from) || (message.sender !== undefined && (!sender || !from))) return undefined
  const to = listOf(message.toRecipients, addressOf)
  const cc = listOf(message.ccRecipients, addressOf)
  const bcc = listOf(message.bccRecipients, addressOf)
  const replyTo = listOf(message.replyTo, addressOf)
  if (!to || !cc || !bcc || !replyTo) return undefined
  const { subject } = message
  const content = contentOf(message.body)
  const attachments = listOf(message.attachments, fileAttachmentOf)
  const headers = listOf(message.internetMessageHeaders, headerOf)
  if (!optionalString(subject) || !content || !attachments || !headers) return undefined
  // Only an HTML body places images. Senders often label an image application/octet-stream. A contentId on any other part, or on two
  // parts, keeps today's card.
  const images = new Map<string, string>()
  if (content.html) {
    // Classic Outlook draws what an `<!--[if mso]>` comment holds. The card drops comments, so it would not show it.
    if (/<!--\[if/i.test(content.html)) return undefined
    for (const { contentId, contentType, contentBytes } of attachments) {
      if (contentId === undefined) continue
      if (!contentType || !/^(image\/[\w.+-]+|application\/octet-stream)$/i.test(contentType)) return undefined
      if (images.has(contentId)) return undefined
      images.set(contentId, `data:${contentType};base64,${contentBytes}`)
    }
    if (hidesAnImage(content.html, images)) return undefined
  }
  return {
    ...(from ? { from } : {}),
    to,
    cc,
    bcc,
    replyTo,
    subject: subject ?? '',
    details: [
      ...(sender ? [{ label: 'sender', value: sender }] : []),
      ...headers,
      ...Object.entries(message).filter(([key]) => DETAIL_KEYS.has(key)).map(([key, value]) => ({ label: key, value: shown(value) })),
      ...(!draft && body.saveToSentItems !== undefined ? [{ label: 'saveToSentItems', value: shown(body.saveToSentItems) }] : []),
    ],
    ...(content.html ? { html: withImages(content.html, images) } : {}),
    text: content.text,
    webAddresses: content.html ? webAddresses(content.html) : [],
    attachments: attachments.length > 0,
    cut: false,
  }
}

/** Message keys Graph changes only on a draft. A change that sets none of them may be to a received message. */
const DRAFT_ONLY_KEYS = new Set(['subject', 'body', 'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo'])

/**
 * A draft change: the message as read, and the keys it sets, in the order sent. Outlook leaves every other key as it is. Undefined
 * when the message does not read, when it sets attachments or headers, which Graph sets only on a new message, when it sets a detail
 * to null, which Graph's docs do not define for each detail, or when it sets no draft-only key.
 */
function readOutlookChange(requestBody: string): { email: GmailSend; message: Record<string, unknown> } | undefined {
  const email = readOutlookMessage(requestBody, true)
  const message = bodyOf(requestBody)
  if (!email || !message || Object.hasOwn(message, 'attachments') || Object.hasOwn(message, 'internetMessageHeaders')) return undefined
  if (Object.entries(message).some(([key, value]) => DETAIL_KEYS.has(key) && value === null) || !Object.keys(message).some((key) => DRAFT_ONLY_KEYS.has(key))) return undefined
  return { email, message }
}

const MUTED = 'text-[#5f6368] dark:text-[#9aa0a6]'
const CHIP = 'inline-flex rounded-full border border-[#dadce0] px-2 py-0.5 text-xs dark:border-[#5f6368]'
const CLEARED = <span className={`${CHIP} ${MUTED}`}>cleared</span>

const CHANGE_LABELS: Record<string, string> = {
  subject: 'Subject', body: 'Body', from: 'From', sender: 'Sender', toRecipients: 'To', ccRecipients: 'Cc', bccRecipients: 'Bcc', replyTo: 'Reply-to',
  importance: 'Importance', isReadReceiptRequested: 'Read receipt', isDeliveryReceiptRequested: 'Delivery receipt',
  categories: 'Categories', flag: 'Flag',
}

/** One line per recipient, or cleared for none. */
const lines = (values: string[]) => (values.length === 0 ? CLEARED : values.map((value, index) => <div key={index}>{value}</div>))

/** A value as sent: text, true or false, a chip per category, or JSON as sent. */
function sentValue(value: unknown): ReactNode {
  if ((typeof value === 'string' && value) || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item)) {
    return <span className="flex flex-wrap gap-1">{value.map((item, index) => <span key={index} className={`${CHIP} break-words`}>{item}</span>)}</span>
  }
  return <code className="break-all">{JSON.stringify(value)}</code>
}

/** The value a key sets, as the email card draws that part. */
function changeValue(key: string, message: Record<string, unknown>, email: GmailSend): ReactNode {
  switch (key) {
    case 'subject': return shown(email.subject)
    case 'body': return email.html
      ? <ClampedBody><EmailHtml html={email.html} inline /></ClampedBody>
      : email.text ? <ClampedBody><div data-testid="outlook-change-body">{email.text}</div></ClampedBody> : shown(email.text)
    case 'toRecipients': return lines(email.to)
    case 'ccRecipients': return lines(email.cc)
    case 'bccRecipients': return lines(email.bcc)
    case 'replyTo': return lines(email.replyTo)
    case 'from': return email.from
    case 'sender': return addressOf(message.sender)
    default: return sentValue(message[key])
  }
}

/** A draft change as Outlook applies it, in the email card's frame: a row per key sent, the label beside the value it sets. */
function OutlookChangeView({ email, message }: { email: GmailSend; message: Record<string, unknown> }) {
  return (
    <article
      aria-label="Email preview"
      data-testid="outlook-change"
      className="mt-3 rounded-md border border-[#e0e0e0] bg-white px-4 py-3 font-[Roboto,Arial,sans-serif] text-[#1f1f1f] dark:border-[#3c4043] dark:bg-[#1f1f1f] dark:text-[#e3e3e3]"
    >
      <p className={`text-xs ${MUTED}`}>Draft · Changes</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {Object.keys(message).map((key) => (
          <div key={key} className="contents">
            {/* Inter's arrow: Roboto's is longer. */}
            <dt className={`text-right ${MUTED}`}>{CHANGE_LABELS[key]} <span className="font-[Inter,system-ui,sans-serif]">→</span></dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">{changeValue(key, message, email)}</dd>
          </div>
        ))}
      </dl>
      <WebAddresses addresses={email.webAddresses} />
    </article>
  )
}

function outlookCustomPreview(method: string, path: RegExp, title: string, draft: boolean): CustomPreview {
  return {
    toolkit: 'outlook',
    method,
    path,
    title,
    read: async (requestBody) => {
      const email = readOutlookMessage(requestBody, draft)
      return email ? <GmailSendView email={email} /> : undefined
    },
  }
}

export const outlookSendCustomPreview = outlookCustomPreview('POST', /^v1\.0\/me\/sendMail$/, 'Allow sending this email from Outlook?', false)
export const outlookDraftCreateCustomPreview = outlookCustomPreview('POST', /^v1\.0\/me\/messages$/, 'Allow saving this draft in Outlook?', true)
export const outlookDraftUpdateCustomPreview: CustomPreview = {
  toolkit: 'outlook',
  method: 'PATCH',
  path: /^v1\.0\/me\/messages\/[^/]+$/,
  title: 'Allow changing this draft in Outlook?',
  read: async (requestBody) => {
    const change = readOutlookChange(requestBody)
    return change ? <OutlookChangeView {...change} /> : undefined
  },
}
