import { describe, expect, it } from 'vitest'
import { isOpenQuestion, isRecoveredRequest, isSinglePlainQuestion, requestQuestions, requestText } from './request-text'

const question = (text: string, labels: string[] = []) => ({ question: text, options: labels.map((label) => ({ label })) })
const ask = (...questions: unknown[]) => ({ kind: 'question', payload: { questions } })
const recovered = { kind: 'question', payload: { recovered: true } }

describe('requestQuestions', () => {
  it('parses a question request, with defaults', () => {
    expect(requestQuestions(ask({ question: 'Which?' }))).toEqual([{ question: 'Which?', options: [], multiSelect: false }])
  })

  it('is null for another kind, a recovered stub, or a payload that does not fit', () => {
    expect(requestQuestions({ kind: 'secret', payload: { questions: [question('Which?')] } })).toBeNull()
    expect(requestQuestions(recovered)).toBeNull()
    expect(requestQuestions(ask())).toBeNull()
    expect(requestQuestions(ask({ question: '' }))).toBeNull()
    expect(requestQuestions({ kind: 'question', payload: null })).toBeNull()
  })
})

describe('which questions a typed reply can answer', () => {
  it('isOpenQuestion: any question card that is not a recovered stub (chat\'s pick)', () => {
    expect(isOpenQuestion(ask(question('A?')))).toBe(true)
    expect(isOpenQuestion(ask(question('A?'), question('B?')))).toBe(true)
    expect(isOpenQuestion(recovered)).toBe(false)
    expect(isOpenQuestion({ kind: 'secret', payload: {} })).toBe(false)
    expect(isRecoveredRequest(recovered)).toBe(true)
    expect(isRecoveredRequest({ kind: 'question', payload: null })).toBe(false)
  })

  it('isSinglePlainQuestion: exactly one parsed question (MCP\'s rule, per request)', () => {
    expect(isSinglePlainQuestion(ask(question('A?', ['Yes', 'No'])))).toBe(true)
    expect(isSinglePlainQuestion(ask(question('A?'), question('B?')))).toBe(false)
    expect(isSinglePlainQuestion(recovered)).toBe(false)
    expect(isSinglePlainQuestion(ask({ question: 'A?', options: [{ label: '' }] }))).toBe(false)
    expect(isSinglePlainQuestion({ kind: 'secret', payload: { questions: [question('A?')] } })).toBe(false)
  })
})

describe('requestText', () => {
  it('lists every question of a card with its options', () => {
    expect(requestText(ask(question('Which colour?', ['Red', 'Blue']), question('Why?')))).toBe('Which colour? (options: Red, Blue)\nWhy?')
  })

  it('says a question was asked when the card cannot be read (a recovered stub)', () => {
    expect(requestText(recovered)).toBe('The agent asked a question.')
  })

  it.each([
    [{ kind: 'secret', payload: { secretName: 'API_KEY', reason: 'to call the API' } }, 'The agent needs the secret API_KEY: to call the API'],
    [{ kind: 'connected_account', payload: { toolkit: 'gmail' } }, 'The agent wants the person to connect their gmail account'],
    [{ kind: 'file', payload: { description: 'the contract' } }, 'The agent wants the person to upload a file: the contract'],
    [{ kind: 'login', payload: {} }, 'The agent needs the person to sign in to a website.'],
    [{ kind: 'browser_input', payload: { message: 'Solve the captcha' } }, 'Solve the captcha'],
    [{ kind: 'computer_use', payload: { appName: 'Notes' } }, 'The agent wants to use Notes'],
    [{ kind: 'script_run', payload: { explanation: 'clean up' } }, 'The agent wants approval to run a script: clean up'],
    [{ kind: 'remote_mcp', payload: { name: 'Linear' } }, 'The agent wants to connect a remote MCP server (Linear)'],
    [{ kind: 'capability_review', payload: { capability: 'workflows' } }, 'The agent wants approval to run a workflow'],
    [{ kind: 'integration_setup', payload: {} }, 'The agent asked the person to set up an integration'],
    [{ kind: 'proxy_review', payload: {} }, 'The agent is waiting on a decision from the person in Gamut.'],
  ])('%o', (request, text) => {
    expect(requestText(request)).toBe(text)
  })
})
