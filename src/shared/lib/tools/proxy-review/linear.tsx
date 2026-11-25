import { useMemo } from 'react'
import type { ElementContent } from 'hast'
import type { Link, Nodes } from 'mdast'
import type { Components } from 'react-markdown'
import type { DocumentNode, FloatValueNode, IntValueNode, OperationDefinitionNode, ValueNode } from 'graphql'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { Markdown } from '@renderer/components/ui/markdown'
import { safeHref } from '@renderer/lib/markdown-url-transform'
import { REMARK_PLUGINS } from '@renderer/lib/remark-plugins'
import { ClampedBody, WebAddresses } from './email-html'
import { DIRECTION_CONTROLS, isRecord } from './github'
import type { CustomPreview } from './custom-previews'

/** The Linear writes the card draws, by their GraphQL root field. */
export type LinearWrite = 'issueCreate' | 'commentCreate' | 'issueUpdate'

/** A Linear write as the card's copy of the request shows it. */
export interface LinearCall {
  /** The issue a comment goes on or a change applies to. Absent for a new issue. */
  issue?: string
  /** Absent when the input sets no title as text. */
  title?: string
  /** The description, or the comment, as the Markdown Linear draws. */
  markdown?: string
  /** Linear's priority, 0 to 4. */
  priority?: number
  /** Every other input key, in the order sent, with its value as the card draws it. A change lists every key it sets. */
  details: { key: string; value: LinearValue }[]
  /** Every image source the Markdown names. A link draws its target as its text or after it. */
  webAddresses: string[]
  /** Each link's target as the Markdown names it, by where the link starts. Absent when no Markdown draws. */
  links?: Map<number, string>
}

/**
 * A value as the card draws it: text, a word for ids with the ids on hover, a chip per item, a cleared or empty field,
 * the Markdown a change sets, or JSON as sent.
 */
export type LinearValue =
  | { kind: 'text' | 'sent'; text: string }
  | { kind: 'ids'; ids: string[]; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'cleared' | 'none' }
  | { kind: 'markdown'; markdown: string }

/** The arguments each write takes. Any other argument keeps today's card. */
const ARGUMENTS: Record<LinearWrite, string[]> = { issueCreate: ['input'], commentCreate: ['input'], issueUpdate: ['id', 'input'] }

/** Input keys whose content Linear draws in place of the text the card shows. */
const REPLACES_CONTENT = /^(descriptionData|bodyData)$|template/i

/** Markdown nodes that draw somewhere else, or not at all. */
const HIDDEN_MARKDOWN = new Set(['html', 'definition', 'footnoteDefinition', 'footnoteReference'])

const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

/** Text that draws something: not a space, and not a character that draws nothing, such as a zero-width space or a braille blank. */
const VISIBLE = /[^\s\p{Default_Ignorable_Code_Point}\u2800]/u

const LINE_BREAK = /[\n\r\u2028\u2029]/

/** A Linear id. Other text sent as an id, such as "SUP-99", draws as itself. */
const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isLinearId = (value: unknown): value is string => typeof value === 'string' && LINEAR_ID.test(value)

/** A list of ids Linear adds to the field, or removes from it, in place of setting it. */
const ADDS_OR_REMOVES = /^(added|removed)\w*Ids$/

/** A word the card draws in place of ids or an emptied field. */
const CARD_WORD = /^(updated|included|set|none|cleared|replaced \(\d+\)|\d+ (included|set|added|removed))$/

/** Keys Linear clears when a change sends null, or leaves unset when a new issue does, as its schema says. Null elsewhere draws as sent. */
const NULL_CLEARS: Record<LinearWrite, Set<string>> = {
  issueCreate: new Set(['assigneeId', 'estimate', 'projectId']),
  commentCreate: new Set(),
  issueUpdate: new Set(['assigneeId', 'cycleId', 'delegateId', 'dueDate', 'estimate', 'parentId', 'projectId', 'projectMilestoneId', 'snoozedUntilAt', 'trashed']),
}

const isJson = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Text that draws as sent without quotes: one line, no space at either end, and something that draws.
 * Text that reads as another value, such as "true", "1" or one of the card's own words like "updated" or "2 added", keeps its quotes.
 */
const plain = (value: unknown): value is string =>
  typeof value === 'string' && value === value.trim() && VISIBLE.test(value) && !LINE_BREAK.test(value) && !CARD_WORD.test(value) && !isJson(value)

/** A code block language the card draws as a label above the block. */
const CODE_LANGUAGE = /^[\w+#.-]+$/

/** A bare www. address or email links with an http:// or mailto: the text does not hold. */
const bareTarget = (url: string, text: string) => url === `http://${text}` || url === `mailto:${text}`

const isBareAddress = ({ url, children: [only, ...rest] }: Link) => rest.length === 0 && only?.type === 'text' && bareTarget(url, only.value)

// As <Markdown> parses, so the tree checked is the tree drawn.
const markdownParser = unified().use(remarkParse).use(REMARK_PLUGINS)

/**
 * Markdown that draws all it holds, with every image source it names and each link's target by where the link starts. No markdown
 * for text that draws nothing, as "#", "&#32;" or "&#8203;" do. Undefined for raw HTML, definitions, footnotes, a link title, a target
 * the renderer blanks, a code block's info string past one word, an image's alt text drawn other than sent, table cells past the
 * header, or decoded text that holds a direction control or draws the card's own "(→" target note.
 */
function drawnMarkdown(markdown: string): { markdown?: string; webAddresses: string[]; links?: Map<number, string> } | undefined {
  const targets: string[] = []
  const links = new Map<number, string>()
  const blank = (node: Nodes): boolean =>
    !('value' in node && VISIBLE.test(node.value)) && !('alt' in node && VISIBLE.test(node.alt ?? '')) && (!('children' in node) || node.children.every(blank))
  const draws = (node: Nodes): boolean => {
    if (HIDDEN_MARKDOWN.has(node.type)) return false
    if (Object.values(node).some((value) => typeof value === 'string' && (DIRECTION_CONTROLS.test(value) || value.includes('(→')))) return false
    if (node.type === 'code' && (node.meta || (node.lang && !(CODE_LANGUAGE.test(node.lang) && markdown.includes(node.lang))))) return false
    if (node.type === 'table' && node.children.some((row) => row.children.length > (node.align?.length ?? 0))) return false
    if (node.type === 'image' && !markdown.startsWith(`![${node.alt ?? ''}](`, node.position?.start.offset)) return false
    if (node.type === 'link' || node.type === 'image') {
      // A target the renderer blanks, such as ftp: or data:, would draw no target.
      if (node.title || (node.url && !safeHref(node.url))) return false
      if (node.type === 'link' && node.position?.start.offset !== undefined) links.set(node.position.start.offset, node.url)
      if (markdown.includes(node.url)) {
        if (node.type === 'image') targets.push(node.url)
      }
      // A bare www. address or email links with an http:// or mailto: the text does not hold, and draws as the text sent.
      else if (node.type === 'image' || !isBareAddress(node)) return false
    }
    return !('children' in node) || node.children.every(draws)
  }
  // The plugins change the tree in place. The source travels with it: remarkTrimAutolinkLiteral reads it.
  const tree = markdownParser.parse(markdown)
  markdownParser.runSync(tree, markdown)
  if (blank(tree)) return { webAddresses: [] }
  // An empty target opens nothing, so it is not listed.
  return draws(tree) ? { markdown, webAddresses: [...new Set(targets)].filter(Boolean), links } : undefined
}

/**
 * The card's copy of a GraphQL request: an `operation:` line when it names one, the query, then the variables, apart by blank lines.
 * Pretty-printed JSON has no blank line, so the variables are what follows the last one.
 */
function splitPreview(requestBody: string): { operationName?: string; query: string; variables: unknown } | undefined {
  const chunks = requestBody.split('\n\n')
  const named = /^operation: ([^]*)$/.exec(chunks[0])
  const rest = named ? chunks.slice(1) : chunks
  let variables: unknown = {}
  if (rest.length > 1) {
    try {
      variables = JSON.parse(rest[rest.length - 1])
      rest.pop()
    } catch {
      // The last part is the query's.
    }
  }
  return rest.length > 0 ? { ...(named ? { operationName: named[1] } : {}), query: rest.join('\n\n'), variables } : undefined
}

/**
 * A Linear write, read from the request body the card shows. Undefined when the request runs anything besides this one write,
 * or when the card could draw something other than what Linear stores. A copy cut short fails the JSON or GraphQL parse.
 */
export async function readLinearCall(requestBody: string, write: LinearWrite): Promise<LinearCall | undefined> {
  const split = splitPreview(requestBody)
  if (!split || !isRecord(split.variables)) return undefined
  const { variables } = split
  const { Kind, OperationTypeNode, parse, valueFromASTUntyped, visit } = await import('graphql')
  let document: DocumentNode
  try {
    document = parse(split.query)
  } catch {
    return undefined
  }
  const operations = document.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  const operation = operations.length === 1 ? operations[0] : undefined
  if (operation?.operation !== OperationTypeNode.MUTATION) return undefined
  if (split.operationName !== undefined && operation.name?.value !== split.operationName) return undefined
  const root = operation.selectionSet.selections.length === 1 ? operation.selectionSet.selections[0] : undefined
  if (root?.kind !== Kind.FIELD || root.name.value !== write) return undefined
  if (operation.directives?.length || root.directives?.length) return undefined
  const rootArguments = root.arguments ?? []
  const names = rootArguments.map((argument) => argument.name.value)
  if (new Set(names).size !== names.length || names.some((name) => !ARGUMENTS[write].includes(name))) return undefined
  // Every variable the write reads must be sent, and every one sent must be read by the write's arguments alone.
  let anywhere = 0
  visit(document, { VariableDefinition: () => false, Variable: () => { anywhere += 1 } })
  const read: string[] = []
  let repeated = false
  // A number Linear would store as another, such as 1e999 as Infinity or 2^53 + 1 as 2^53.
  let rounded = false
  const rounds = (node: IntValueNode | FloatValueNode) => {
    const number = Number(node.value)
    rounded ||= !Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))
  }
  for (const argument of rootArguments) {
    visit(argument, {
      Variable: (node) => { read.push(node.name.value) },
      ObjectValue: (node) => { repeated ||= new Set(node.fields.map((field) => field.name.value)).size !== node.fields.length },
      IntValue: rounds,
      FloatValue: rounds,
    })
  }
  if (repeated || rounded || read.length !== anywhere) return undefined
  if (read.some((name) => !Object.hasOwn(variables, name)) || Object.keys(variables).some((name) => !read.includes(name))) return undefined
  const args = Object.fromEntries(rootArguments.map((argument) => [argument.name.value, valueFromASTUntyped(argument.value, variables)]))
  const { input, id } = args
  if (!isRecord(input) || DIRECTION_CONTROLS.test(JSON.stringify(args))) return undefined
  if (Object.keys(input).some((key) => REPLACES_CONTENT.test(key))) return undefined
  // Linear leaves a description sent as null as it is, and an empty list of ids to add or remove changes nothing. Its schema does not say what null there does.
  if (write === 'issueUpdate' && input.description === null) return undefined
  if (Object.entries(input).some(([key, value]) => ADDS_OR_REMOVES.test(key) && (value === null || (Array.isArray(value) && value.length === 0)))) return undefined
  let issue: string | undefined
  if (write !== 'issueCreate') {
    const target = write === 'issueUpdate' ? id : input.issueId
    if (typeof target !== 'string') return undefined
    issue = target
  }
  // As JSON, with each number spelled as sent, so 1.0 shows as 1.0.
  const asSent = (node: ValueNode): string => {
    if (node.kind === Kind.INT || node.kind === Kind.FLOAT) return node.value
    if (node.kind === Kind.LIST) return `[${node.values.map(asSent).join(',')}]`
    if (node.kind === Kind.OBJECT) return `{${node.fields.map((field) => `${JSON.stringify(field.name.value)}:${asSent(field.value)}`).join(',')}}`
    return JSON.stringify(valueFromASTUntyped(node, variables))
  }
  const inputNode = rootArguments.find((argument) => argument.name.value === 'input')?.value
  const sent = (key: string) => {
    const field = inputNode?.kind === Kind.OBJECT ? inputNode.fields.find((f) => f.name.value === key) : undefined
    return field ? asSent(field.value) : JSON.stringify(input[key])
  }
  const markdownKey = write === 'commentCreate' ? 'body' : 'description'
  // A title with a space at either end, or text that draws nothing, is listed as sent, not drawn blank.
  const title = write !== 'commentCreate' && plain(input.title) ? input.title : undefined
  const text = input[markdownKey]
  const shown = typeof text === 'string' ? drawnMarkdown(text) : { webAddresses: [] }
  if (!shown) return undefined
  const { markdown, webAddresses, links } = shown
  const priority = typeof input.priority === 'number' && Number.isInteger(input.priority) && input.priority >= 0 && input.priority < PRIORITIES.length && sent('priority') === String(input.priority) ? input.priority : undefined
  const drawnValue = (key: string): LinearValue => {
    const value = input[key]
    // Text that draws nothing is listed as sent.
    if (key === markdownKey && typeof value === 'string') return markdown !== undefined ? { kind: 'markdown', markdown } : { kind: 'sent', text: sent(key) }
    if (key === 'priority' && priority !== undefined) return { kind: 'text', text: `${priority} (${PRIORITIES[priority]})` }
    if (value === null) return NULL_CLEARS[write].has(key) ? { kind: write === 'issueUpdate' ? 'cleared' : 'none' } : { kind: 'sent', text: sent(key) }
    // An id reads as nothing to a person, so it draws as what the request does with it, not as a guess at what changes. The request below lists it.
    if (key.endsWith('Id') && isLinearId(value)) return { kind: 'ids', ids: [value], text: write === 'issueUpdate' ? 'updated' : 'set' }
    if (key.endsWith('Ids') && Array.isArray(value)) {
      if (value.length === 0) return { kind: write === 'issueUpdate' ? 'cleared' : 'none' }
      if (!value.every(isLinearId)) return { kind: 'sent', text: sent(key) }
      const addsOrRemoves = ADDS_OR_REMOVES.exec(key)
      const count = addsOrRemoves ? `${value.length} ${addsOrRemoves[1]}` : write === 'issueUpdate' ? `replaced (${value.length})` : `${value.length} set`
      return { kind: 'ids', ids: value, text: count }
    }
    if (plain(value)) return { kind: 'text', text: value }
    if (Array.isArray(value) && value.length > 0 && value.every(plain)) return { kind: 'list', items: value }
    return { kind: typeof value === 'number' || typeof value === 'boolean' ? 'text' : 'sent', text: sent(key) }
  }
  // A change lists every key it sets, a row each. A new issue or a comment draws its title, text and priority above the rest.
  const apart = write !== 'issueUpdate'
  const drawn = new Set(apart ? [
    ...(title !== undefined ? ['title'] : []),
    ...(markdown !== undefined ? [markdownKey] : []),
    ...(priority !== undefined ? ['priority'] : []),
    ...(write === 'commentCreate' ? ['issueId'] : []),
  ] : [])
  const details = Object.keys(input).filter((key) => !drawn.has(key)).map((key) => ({ key, value: drawnValue(key) }))
  return apart ? { issue, title, markdown, priority, details, webAddresses, links } : { issue, details, webAddresses, links }
}

const MUTED = 'text-[#6b6f76] dark:text-[#8a8f98]'

const drawnText = (node: ElementContent): string => (node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(drawnText).join('') : '')

// A link draws as its text, and an image as its alt text, so nothing opens or loads here. An image's source is listed below the text.
const linearMarkdown = (links?: Map<number, string>): Components => ({
  // A link whose text is not its target shows the target after the text, so text that names another address cannot hide it.
  // The target shows as written: the renderer's href is encoded, so "a b" would draw as "a%20b". Its text is underlined in the
  // body's colour, as it does not open.
  a: ({ node, href, children }) => {
    const text = node?.children.map(drawnText).join('') ?? ''
    const offset = node?.position?.start.offset
    const target = (offset !== undefined ? links?.get(offset) : undefined) ?? href
    return (
      <>
        <span className="underline">{children}</span>
        {target && target !== text && !bareTarget(target, text) && <span className={`font-mono ${MUTED}`}> (→ {target})</span>}
      </>
    )
  },
  img: ({ alt }) => <>{alt}</>,
  // A code block's language draws as a label above it. Its lines wrap, as a line past the card's width would be out of view.
  pre: ({ node, children }) => {
    const code = node?.children[0]
    const classes = code?.type === 'element' ? code.properties.className : undefined
    return (
      <>
        {Array.isArray(classes) && classes.length > 0 && <span className={`mt-3 block text-xs ${MUTED}`}>{String(classes[0]).replace(/^language-/, '')}</span>}
        <pre className="whitespace-pre-wrap break-words">{children}</pre>
      </>
    )
  },
})

/** Readable names for the input keys Linear's editor names. Any other key shows as sent. */
const LABELS: Record<string, string> = {
  teamId: 'Team', stateId: 'State', assigneeId: 'Assignee', labelIds: 'Labels', projectId: 'Project', parentId: 'Parent', cycleId: 'Cycle',
  dueDate: 'Due date', priority: 'Priority', title: 'Title', description: 'Description', subscriberIds: 'Subscribers', estimate: 'Estimate',
}

const CHIP = 'inline-flex rounded-full border border-[#e0e0e6] px-2 py-0.5 text-xs dark:border-[#2e3035]'

/** The description or comment as Linear draws it, cut to a few lines until opened. */
function LinearMarkdown({ markdown, links, text }: { markdown: string; links?: Map<number, string>; text: string }) {
  const components = useMemo(() => linearMarkdown(links), [links])
  return (
    <ClampedBody more={`Show full ${text}`}>
      <div className="prose prose-sm max-w-none break-words text-inherit prose-table:table-fixed dark:prose-invert prose-headings:text-base prose-p:my-1.5 prose-pre:mt-0 prose-li:my-0.5 marker:text-[#6b6f76] dark:marker:text-[#8a8f98]">
        <Markdown components={components}>{markdown}</Markdown>
      </div>
    </ClampedBody>
  )
}

/** A row's value. Ids show on hover over their word, and a chip wraps inside the value column. */
function LinearValueView({ value }: { value: Exclude<LinearValue, { kind: 'markdown' }> }) {
  switch (value.kind) {
    case 'text': return <>{value.text}</>
    case 'sent': return <code className="break-all">{value.text}</code>
    case 'ids': return <abbr className="cursor-help" title={value.ids.join('\n')}>{value.text}</abbr>
    case 'cleared': case 'none': return <span className={`${CHIP} ${MUTED}`}>{value.kind}</span>
    case 'list': return (
      <span className="flex flex-wrap gap-1">
        {value.items.map((item, index) => <span key={index} className={`${CHIP} break-words`}>{item}</span>)}
      </span>
    )
  }
}

/** A Linear issue as its editor shows one: the title, the text, then a row per other key, the label beside the value it sets. */
function LinearCard({ frame, call, untitled, text }: { frame: string; call: LinearCall; untitled?: boolean; text: string }) {
  return (
    <article
      aria-label="Linear preview"
      data-testid="linear-call"
      className="mt-3 rounded-md border border-[#e0e0e6] bg-white px-4 py-3 font-[Inter,system-ui,sans-serif] text-[#282a30] dark:border-[#2e3035] dark:bg-[#1b1c1f] dark:text-[#e2e2e6]"
    >
      <p className={`text-xs ${MUTED}`} data-testid="linear-call-frame">{frame}</p>
      {(call.title !== undefined || (untitled && !call.details.some(({ key, value }) => key === 'title' && !(value.kind === 'sent' && value.text === 'null')))) && <h3 className="mt-1 whitespace-pre-wrap break-words text-lg font-semibold leading-snug" data-testid="linear-call-title">{call.title ?? '(no title)'}</h3>}
      {call.markdown !== undefined && <div className="mt-2" data-testid="linear-call-body"><LinearMarkdown markdown={call.markdown} links={call.links} text={text} /></div>}
      {call.priority !== undefined && <span className={`mt-3 ${CHIP}`} data-testid="linear-call-priority">{call.priority} ({PRIORITIES[call.priority]})</span>}
      {call.details.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm" data-testid="linear-call-details">
          {call.details.map(({ key, value }) => (
            <div key={key} className="contents">
              <dt className={`text-right ${MUTED}`}>{LABELS[key] ?? key} →</dt>
              {value.kind === 'markdown'
                ? <dd className="col-span-2" data-testid="linear-call-body"><LinearMarkdown markdown={value.markdown} links={call.links} text={text} /></dd>
                : <dd className="min-w-0 whitespace-pre-wrap break-words"><LinearValueView value={value} /></dd>}
            </div>
          ))}
        </dl>
      )}
      <WebAddresses addresses={call.webAddresses} heading={`Web addresses in this ${text}`} />
    </article>
  )
}

function linearCustomPreview(write: LinearWrite, title: string, frame: (issue?: string) => string, text: string, untitled?: boolean): CustomPreview {
  return {
    toolkit: 'linear',
    method: 'POST',
    path: /^graphql$/,
    operation: `Mutation: ${write}`,
    title,
    read: async (requestBody) => {
      const call = await readLinearCall(requestBody, write)
      return call ? <LinearCard frame={frame(call.issue)} call={call} untitled={untitled} text={text} /> : undefined
    },
  }
}

export const linearIssueCreateCustomPreview = linearCustomPreview('issueCreate', 'Allow creating this issue in Linear?', () => 'New issue', 'description', true)
export const linearCommentCreateCustomPreview = linearCustomPreview('commentCreate', 'Allow commenting on this Linear issue?', (issue) => `Comment on ${issue}`, 'comment')
export const linearIssueUpdateCustomPreview = linearCustomPreview('issueUpdate', 'Allow changing this Linear issue?', (issue) => `${issue} · Changes`, 'description')
