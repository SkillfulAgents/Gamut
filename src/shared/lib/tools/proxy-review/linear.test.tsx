// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { customPreviewFor } from './custom-previews'
import { linearCommentCreateCustomPreview, linearIssueCreateCustomPreview, linearIssueUpdateCustomPreview, readLinearCall } from './linear'

/** The request body as the card gets it: the operation, the query, then pretty-printed variables, cut at 64,000 characters. */
const asCard = (body: unknown) => requestBodyPreview(new TextEncoder().encode(JSON.stringify(body)).buffer) ?? ''

const TEAM = '9cfb482a-81e3-4154-b5b9-2c805e70a02d'
const USER = 'c2d4f6a8-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const STATE = '5e7a9c1b-3d5f-4a7b-9c1d-2e4f6a8b0c2d'
const LABELS = ['e8f0a2c4-6b8d-4f1a-9c3e-5a7b9d1f3c5e', '0a2c4e6f-8b1d-4a3c-9e5f-7b9d1c3e5a7f']
const CREATE = 'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }'
const COMMENT = 'mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }'
const UPDATE = 'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }'

const created = (input: Record<string, unknown>) => readLinearCall(asCard({ query: CREATE, variables: { input: { teamId: TEAM, title: 'Hi', ...input } } }), 'issueCreate')
const commented = (body: string) => readLinearCall(asCard({ query: COMMENT, variables: { input: { issueId: 'SUP-1', body } } }), 'commentCreate')

describe('a Linear write on the card', () => {
  it('draws a new issue as a Linear draft: title, description, priority, then a row per other key', async () => {
    const description = 'Steps:\n1. Post 3000 chars via proxy\n2. Card cuts at 2000\n\nExpected: full text.'
    const requestBody = asCard({ query: CREATE, variables: { input: { teamId: TEAM, title: 'Approval card truncates long Slack messages', description, assigneeId: USER, priority: 2, labelIds: [LABELS[0]], subscriberIds: [] } } })
    const endpoint = 'Mutation: issueCreate - Create a new issue'
    expect(customPreviewFor('linear', 'POST', 'graphql', endpoint)).toBe(linearIssueCreateCustomPreview)
    expect(linearIssueCreateCustomPreview.title).toBe('Allow creating this issue in Linear?')
    render(<>{await linearIssueCreateCustomPreview.read(requestBody)}</>)
    expect(screen.getByTestId('linear-call-frame').textContent).toBe('New issue')
    expect(screen.getByTestId('linear-call-title').textContent).toBe('Approval card truncates long Slack messages')
    expect(screen.getByTestId('linear-call-body').querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByTestId('linear-call-priority').textContent).toBe('2 (High)')
    expect(screen.getByTestId('linear-call-details').textContent).toBe('Team →setAssignee →setLabels →1 setSubscribers →none')
    expect([...screen.getByTestId('linear-call-details').querySelectorAll('abbr')].map((word) => word.title)).toEqual([TEAM, USER, LABELS[0]])
  })

  it('draws a comment under the issue it goes on, with an inline input, every other key, and every web address it names', async () => {
    const query = 'mutation { commentCreate(input: { issueId: "SUP-1188", createOnSyncedSlackThread: true, body: "Ping https://linear.app/acme/profiles/dana. Logs: [run 88](https://logs.example.com/run/88) ![chart](https://img.example.com/c.png)" }) { success } }'
    expect(customPreviewFor('linear', 'POST', 'graphql', 'Mutation: commentCreate - Create a comment')).toBe(linearCommentCreateCustomPreview)
    expect(linearCommentCreateCustomPreview.title).toBe('Allow commenting on this Linear issue?')
    render(<>{await linearCommentCreateCustomPreview.read(asCard({ query }))}</>)
    expect(screen.getByTestId('linear-call-frame').textContent).toBe('Comment on SUP-1188')
    expect(screen.getByTestId('linear-call-body').textContent).toContain('Logs: run 88 (→ https://logs.example.com/run/88) chart')
    expect(screen.getByTestId('linear-call-body').querySelector('a, img')).toBeNull()
    expect(screen.getByTestId('linear-call-details').textContent).toBe('createOnSyncedSlackThread →true')
    expect([...screen.getByTestId('email-web-addresses').querySelectorAll('li')].map((item) => item.textContent)).toEqual(['https://img.example.com/c.png'])
  })

  it('draws a change as a row per key it sets, its title and description among them', async () => {
    const requestBody = asCard({ query: UPDATE, variables: { id: 'SUP-1207', input: { stateId: STATE, title: 'Retitled', priority: 1, description: '- one', dueDate: null } } })
    expect(customPreviewFor('linear', 'POST', 'graphql', 'Mutation: issueUpdate - Update an issue')).toBe(linearIssueUpdateCustomPreview)
    expect(linearIssueUpdateCustomPreview.title).toBe('Allow changing this Linear issue?')
    render(<>{await linearIssueUpdateCustomPreview.read(requestBody)}</>)
    expect(screen.getByTestId('linear-call-frame').textContent).toBe('SUP-1207 · Changes')
    expect(screen.queryByTestId('linear-call-title')).toBeNull()
    expect(screen.queryByTestId('linear-call-priority')).toBeNull()
    expect(screen.getByTestId('linear-call-details').textContent).toBe('State →updatedTitle →RetitledPriority →1 (Urgent)Description →\none\nDue date →cleared')
    expect(screen.getByTestId('linear-call-body').querySelectorAll('li')).toHaveLength(1)
  })

  const change = async (input: Record<string, unknown>) => (await readLinearCall(asCard({ query: UPDATE, variables: { id: 'SUP-1', input } }), 'issueUpdate'))?.details
  it.each([
    ['text as itself', { dueDate: '2026-12-05' }, { kind: 'text', text: '2026-12-05' }],
    ['an id as updated', { assigneeId: USER }, { kind: 'ids', ids: [USER], text: 'updated' }],
    ['ids as the count they replace the list with', { labelIds: LABELS }, { kind: 'ids', ids: LABELS, text: 'replaced (2)' }],
    ['ids to add as the count added', { addedLabelIds: LABELS }, { kind: 'ids', ids: LABELS, text: '2 added' }],
    ['an id not shaped like a Linear id as text', { parentId: 'SUP-99' }, { kind: 'text', text: 'SUP-99' }],
    ['ids not all shaped like a Linear id as sent', { labelIds: [LABELS[0], 'l2'] }, { kind: 'sent', text: JSON.stringify([LABELS[0], 'l2']) }],
    ['an emptied list of ids as cleared', { labelIds: [] }, { kind: 'cleared' }],
    ['a cleared id as cleared', { assigneeId: null }, { kind: 'cleared' }],
    ['null as sent on a key Linear does not clear with it', { stateId: null }, { kind: 'sent', text: 'null' }],
    ['a number as spelled', { estimate: 2 }, { kind: 'text', text: '2' }],
    ['an object as sent', { sla: { days: 2 } }, { kind: 'sent', text: '{"days":2}' }],
    ['a list holding blank text as sent', { tags: ['bug', ' '] }, { kind: 'sent', text: '["bug"," "]' }],
    ['text with a line break in quotes', { title: 'Fix\nAssignee → u9' }, { kind: 'sent', text: '"Fix\\nAssignee → u9"' }],
  ])('draws %s', async (_case, input, value) => {
    expect(await change(input)).toEqual([{ key: Object.keys(input)[0], value }])
  })

  it.each([['updated'], ['replaced (2)'], ['2 added'], ['true']])('keeps quotes on text that reads as another value, %s', async (text) => {
    expect(await change({ dueDate: text })).toEqual([{ key: 'dueDate', value: { kind: 'sent', text: JSON.stringify(text) } }])
  })

  it('draws a cleared field as a muted tag, a changed id as a word with the id on hover, and blank text in quotes', async () => {
    render(<>{await linearIssueUpdateCustomPreview.read(asCard({ query: UPDATE, variables: { id: 'SUP-1', input: { dueDate: null, stateId: STATE, assigneeId: USER, labelIds: LABELS, subscriberIds: [], title: ' ', teamId: null } } }))}</>)
    const values = [...screen.getByTestId('linear-call-details').querySelectorAll('dd')]
    expect(values.map((value) => [value.textContent, value.querySelector('abbr')?.title])).toEqual([
      ['cleared', undefined], ['updated', STATE], ['updated', USER], ['replaced (2)', LABELS.join('\n')], ['cleared', undefined], ['" "', undefined], ['null', undefined],
    ])
    expect(values.at(-1)?.querySelector('code')?.textContent).toBe('null')
  })

  it('keeps today\'s card for a change that sends the description as null, which Linear leaves as it is', async () => {
    expect(await change({ description: null })).toBeUndefined()
  })

  it.each([
    ['an empty addedLabelIds, which changes nothing', { addedLabelIds: [] }],
    ['removedReleaseIds sent as null', { removedReleaseIds: null }],
  ])('keeps today\'s card for %s', async (_case, input) => {
    expect(await change(input)).toBeUndefined()
  })

  it('draws null on a new issue as none where Linear leaves the key unset, else as sent', async () => {
    expect((await created({ assigneeId: null, cycleId: null }))?.details).toEqual([
      { key: 'teamId', value: { kind: 'ids', ids: [TEAM], text: 'set' } },
      { key: 'assigneeId', value: { kind: 'none' } },
      { key: 'cycleId', value: { kind: 'sent', text: 'null' } },
    ])
  })

  it.each([
    ['an emptied description', UPDATE, { id: 'SUP-1', input: { description: '' } }, 'issueUpdate', { issue: 'SUP-1', details: [{ key: 'description', value: { kind: 'sent', text: '""' } }], webAddresses: [] }],
    ['a title of only a zero-width space', UPDATE, { id: 'SUP-1', input: { title: '\u200b' } }, 'issueUpdate', { issue: 'SUP-1', details: [{ key: 'title', value: { kind: 'sent', text: '"\u200b"' } }], webAddresses: [] }],
    ['a title of only a braille blank', UPDATE, { id: 'SUP-1', input: { title: '\u2800' } }, 'issueUpdate', { issue: 'SUP-1', details: [{ key: 'title', value: { kind: 'sent', text: '"\u2800"' } }], webAddresses: [] }],
    ['a description that draws nothing, an empty heading', UPDATE, { id: 'SUP-1', input: { description: '#' } }, 'issueUpdate', { issue: 'SUP-1', details: [{ key: 'description', value: { kind: 'sent', text: '"#"' } }], webAddresses: [] }],
    ['a comment that draws nothing, a decoded space', COMMENT, { input: { issueId: 'SUP-1', body: '&#32;' } }, 'commentCreate', { issue: 'SUP-1', details: [{ key: 'body', value: { kind: 'sent', text: '"&#32;"' } }], webAddresses: [] }],
    ['a description that draws nothing, a decoded zero-width space', UPDATE, { id: 'SUP-1', input: { description: '&#8203;' } }, 'issueUpdate', { issue: 'SUP-1', details: [{ key: 'description', value: { kind: 'sent', text: '"&#8203;"' } }], webAddresses: [] }],
  ] as const)('lists %s as sent, not drawn blank', async (_case, query, variables, write, call) => {
    expect(await readLinearCall(asCard({ query, variables }), write)).toEqual(call)
  })

  it('draws a bare www. address, an email, a link or an autolink as its text, and lists none of them, as the card draws each', async () => {
    render(<>{await linearCommentCreateCustomPreview.read(asCard({ query: COMMENT, variables: { input: { issueId: 'SUP-1', body: 'Docs at www.acme.test, or ask dana@acme.test. Logs: https://logs.acme.test/88 or <https://acme.test/docs>' } } }))}</>)
    expect(screen.getByTestId('linear-call-body').textContent).toBe('Docs at www.acme.test, or ask dana@acme.test. Logs: https://logs.acme.test/88 or https://acme.test/docs')
    expect(screen.queryByTestId('email-web-addresses')).toBeNull()
  })

  it('draws a code block with its one-word language as a label above it, and wraps its lines and a table to the card, so none sits out of view', async () => {
    render(<>{await linearCommentCreateCustomPreview.read(asCard({ query: COMMENT, variables: { input: { issueId: 'SUP-1', body: '```ts\na' + ' '.repeat(500) + 'b\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |' } } }))}</>)
    const body = screen.getByTestId('linear-call-body')
    expect(body.textContent).toMatch(/^tsa {500}b\n/)
    expect(body.querySelector('pre')?.className).toBe('whitespace-pre-wrap break-words')
    expect(body.querySelector('table')?.closest('.prose')?.classList).toContain('prose-table:table-fixed')
  })

  it('draws a link whose text names another address as underlined body text with its target after it, as written, not as the renderer encodes it', async () => {
    render(<>{await linearCommentCreateCustomPreview.read(asCard({ query: COMMENT, variables: { input: { issueId: 'SUP-1210', body: 'Setup guide: [https://acme.test/docs](https://exfil.test/x). See [the doc](<https://acme.test/a b>).' } } }))}</>)
    const body = screen.getByTestId('linear-call-body')
    expect(body.querySelector('a')).toBeNull()
    expect(body.textContent).toBe('Setup guide: https://acme.test/docs (→ https://exfil.test/x). See the doc (→ https://acme.test/a b).')
    expect(body.querySelector('.prose span')?.className).toBe('underline')
  })

  it.each([
    ['no title', {}, true, 'Team →set'],
    ['a null title', { title: null }, true, 'Team →setTitle →null'],
    ['a title with a space at either end', { title: ' Fix ' }, false, 'Team →setTitle →" Fix "'],
  ])('draws "(no title)" above a new issue only when it has %s', async (_case, title, untitled, details) => {
    render(<>{await linearIssueCreateCustomPreview.read(asCard({ query: CREATE, variables: { input: { teamId: TEAM, ...title } } }))}</>)
    expect(screen.queryByTestId('linear-call-title')?.textContent).toBe(untitled ? '(no title)' : undefined)
    expect(screen.getByTestId('linear-call-details').textContent).toBe(details)
  })

  it.each([
    ['a write other than the three', 'Mutation: issueDelete - Delete an issue'],
    ['a review whose endpoint is ambiguous', undefined],
    ['a query', 'Query: issues - List issues'],
  ])('keeps today\'s card for %s', (_case, endpoint) => {
    expect(customPreviewFor('linear', 'POST', 'graphql', endpoint)).toBeUndefined()
  })

  it('keeps today\'s card for a query, even one that names a write', async () => {
    expect(await readLinearCall(asCard({ query: `query Q { issueCreate(input: { teamId: "${TEAM}", title: "x" }) { success } }` }), 'issueCreate')).toBeUndefined()
  })

  const comment = { issueId: 'SUP-1201', body: 'Looks good to me.' }
  it.each([
    ['two operations, though the request names one', { operationName: 'A', query: `${COMMENT.replace('AddComment', 'A')} mutation B { issueDelete(id: "SUP-1001") { success } }`, variables: { input: comment } }],
  ])('keeps today\'s card for %s', async (_case, body) => {
    expect(await readLinearCall(asCard(body), 'commentCreate')).toBeUndefined()
  })

  it('keeps today\'s card for an alias that hides a second root field', async () => {
    expect(await readLinearCall(asCard({ query: `mutation { issueCreate(input: { teamId: "${TEAM}", title: "Weekly sync notes" }) { success } del: issueDelete(id: "SUP-1002") { success } }` }), 'issueCreate')).toBeUndefined()
  })

  it('keeps today\'s card for a write reached through a fragment', async () => {
    const query = `mutation { ...issueCreate } fragment issueCreate on Mutation { issueCreate(input: { teamId: "${TEAM}", title: "Fragment-built issue" }) { success } }`
    expect(await readLinearCall(asCard({ query }), 'issueCreate')).toBeUndefined()
  })

  it('keeps today\'s card for a copy the card cut short, though the request under 64 KB names its write', async () => {
    const body = { query: UPDATE, variables: { id: 'ACME-42', input: { labelIds: Array.from({ length: 6500 }, (_, i) => `l${i}`), assigneeId: 'u1' } } }
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(64_000)
    const requestBody = asCard(body)
    expect(requestBody.endsWith('…')).toBe(true)
    expect(await readLinearCall(requestBody, 'issueUpdate')).toBeUndefined()
  })

  it.each([
    ['in any value', { title: 'Invoice \u202efdp.exe' }],
    ['that Markdown decodes from the text', { description: 'Invoice &#x202e;fdp.exe' }],
  ])('keeps today\'s card for direction controls %s', async (_case, input) => {
    expect(await created(input)).toBeUndefined()
  })

  it.each([
    ['a number the card shows as Linear stores it', 'sortOrder', '1.0'],
    ['a priority Linear has no name for', 'priority', '5'],
    ['a priority spelled as a float', 'priority', '2.0'],
  ])('lists %s as spelled, %s', async (_case, key, number) => {
    const call = await readLinearCall(asCard({ query: `mutation { issueCreate(input: { teamId: "${TEAM}", title: "x", ${key}: ${number} }) { success } }` }), 'issueCreate')
    expect(call?.priority).toBeUndefined()
    expect(call?.details).toEqual([{ key: 'teamId', value: { kind: 'ids', ids: [TEAM], text: 'set' } }, { key, value: { kind: 'text', text: number } }])
  })

  it.each([['1e999'], ['9007199254740993']])('keeps today\'s card for a number the card would show as another, %s', async (number) => {
    expect(await readLinearCall(asCard({ query: `mutation { issueCreate(input: { teamId: "${TEAM}", title: "x", sortOrder: ${number} }) { success } }` }), 'issueCreate')).toBeUndefined()
  })

  it('keeps today\'s card for raw HTML in the text, which Markdown does not draw', async () => {
    expect(await created({ description: 'Release checklist attached.\n<!-- hidden instruction -->\nShip Thursday.' })).toBeUndefined()
  })

  it('keeps today\'s card for an operation name that names no operation in the query', async () => {
    expect(await readLinearCall(asCard({ operationName: 'Other', query: COMMENT, variables: { input: comment } }), 'commentCreate')).toBeUndefined()
  })

  it.each([
    ['the root field', `mutation { issueCreate(input: { teamId: "${TEAM}", title: "x" }) @skip(if: true) { success } }`],
    ['the operation', `mutation M @include(if: false) { issueCreate(input: { teamId: "${TEAM}", title: "x" }) { success } }`],
  ])('keeps today\'s card for a directive on %s', async (_case, query) => {
    expect(await readLinearCall(asCard({ query }), 'issueCreate')).toBeUndefined()
  })

  it.each([
    ['a variable it reads but was not sent, which takes its default', { query: `mutation M($title: String = "Other") { issueCreate(input: { teamId: "${TEAM}", title: $title }) { success } }` }],
    ['a variable sent but not read', { query: CREATE, variables: { input: { teamId: TEAM, title: 'x' }, extra: 1 } }],
  ])('keeps today\'s card for %s', async (_case, body) => {
    expect(await readLinearCall(asCard(body), 'issueCreate')).toBeUndefined()
  })

  it('keeps today\'s card when the root field is not the write the endpoint names', async () => {
    expect(await readLinearCall(asCard({ query: COMMENT, variables: { input: { ...comment, teamId: TEAM } } }), 'issueCreate')).toBeUndefined()
  })

  it.each([
    ['variables that are not an object', { query: `mutation { issueCreate(input: { teamId: "${TEAM}", title: "x" }) { success } }`, variables: [] }],
    ['an input that is not an object', { query: 'mutation { issueCreate(input: "x") { success } }' }],
  ])('keeps today\'s card for %s', async (_case, body) => {
    expect(await readLinearCall(asCard(body), 'issueCreate')).toBeUndefined()
  })

  it.each([['descriptionData'], ['lastAppliedTemplateId']])('keeps today\'s card for %s, which Linear draws in place of the text', async (key) => {
    expect(await created({ [key]: 'x' })).toBeUndefined()
  })

  it.each([
    ['a link definition', 'See [the doc][1].\n\n[1]: https://exfil.test/x'],
    ['a footnote', 'See the doc.[^1]\n\n[^1]: https://exfil.test/x'],
    ['a link title', 'See [the doc](https://acme.test/docs "https://exfil.test/x").'],
    ['a code block\'s info string', '```sh https://exfil.test/x\nls\n```'],
    ['a code block\'s meta', '```ts title=x\nls\n```'],
    ['a link inside an image\'s alt text', '![see [docs](https://exfil.test/x)](https://acme.test/c.png)'],
    ['a table row wider than its header', '| Step |\n| - |\n| Ship | https://exfil.test/x |'],
    ['a link target the text does not hold', 'See [the doc](https://acme.test/&#x64;oc).'],
  ])('keeps today\'s card for %s, which Markdown draws elsewhere or not at all', async (_case, body) => {
    expect(await commented(body)).toBeUndefined()
  })

  it('keeps today\'s card for a link to ftp://exfil.test/x, whose target the renderer blanks', async () => {
    expect(await commented('See [the doc](ftp://exfil.test/x).')).toBeUndefined()
  })

  it.each([['(→'], ['(&rarr;']])('keeps today\'s card for text that draws the card\'s own target note, as %s', async (note) => {
    expect(await commented(`See [the doc](https://acme.test/docs) ${note} https://good.test).`)).toBeUndefined()
  })

  it('keeps today\'s card for a comment that names no issue', async () => {
    expect(await readLinearCall(asCard({ query: COMMENT, variables: { input: { body: 'hi' } } }), 'commentCreate')).toBeUndefined()
  })

  it.each([
    ['an argument besides the input', `mutation { issueCreate(input: { teamId: "${TEAM}", title: "x" }, teamKey: "OPS") { success } }`, {}],
    ['a variable read outside the arguments', 'mutation M($input: IssueCreateInput!, $n: Int = 5) { issueCreate(input: $input) { issue { comments(first: $n) { nodes { id } } } } }', { input: { teamId: TEAM } }],
  ])('keeps today\'s card for %s', async (_case, query, variables) => {
    expect(await readLinearCall(asCard({ query, variables }), 'issueCreate')).toBeUndefined()
  })

  it.each([
    ['input field', `mutation { issueCreate(input: { teamId: "${TEAM}", title: "Shown", title: "Sent" }) { success } }`],
    ['argument', `mutation { issueCreate(input: { teamId: "${TEAM}", title: "Shown" }, input: { teamId: "${TEAM}", title: "Sent" }) { success } }`],
  ])('keeps today\'s card for a repeated %s', async (_case, query) => {
    expect(await readLinearCall(asCard({ query }), 'issueCreate')).toBeUndefined()
  })
})
