import { describe, it, expect } from 'vitest'
import { formatAgentEntry, formatAgentList } from './list-agents'
import type { ListedAgent } from './host-response-schemas'

const bare: ListedAgent = {
  slug: 'billing-ops-x7', name: 'Billing Ops', description: 'Handles invoices', createdAt: '2026-09-14T10:00:00.000Z',
  members: [], memberCount: 0, running: false, needsInput: false, lastActivityAt: null,
  sessionCount: 0, automatedSessionCount: 0, dashboards: [], accountServices: [],
}

describe('formatAgentEntry', () => {
  it('prints the resume, marking agent members and invited people and counting the members past the cap', () => {
    expect(formatAgentEntry({
      ...bare,
      members: [
        { name: 'Jeremy', role: 'owner', kind: 'person' },
        { name: 'Sam', role: 'viewer', kind: 'person', invited: true },
        { name: 'Partner Manager', role: 'user', kind: 'agent' },
      ],
      memberCount: 5,
      running: true,
      needsInput: true,
      lastActivityAt: '2026-11-23T08:00:00.000Z',
      sessionCount: 41,
      automatedSessionCount: 12,
      dashboards: ['Pipeline'],
      accountServices: ['gmail', 'slack'],
    })).toBe([
      '- billing-ops-x7 (Billing Ops) — Handles invoices',
      '  Members (5): Jeremy (owner), Sam (viewer, invited), Partner Manager (agent, user), +2 more',
      '  Created 2026-09-14 · running now · needs input · last active 2026-11-23 · 41 sessions, 12 automated',
      '  Dashboards: Pipeline',
      '  Accounts: gmail, slack',
    ].join('\n'))
  })

  it('leaves out every line it has nothing for, members included when sign-in is off', () => {
    expect(formatAgentEntry(bare)).toBe('- billing-ops-x7 (Billing Ops) — Handles invoices\n  Created 2026-09-14 · 0 sessions')
  })
})

describe('formatAgentList', () => {
  const sales = { ...bare, slug: 'sales-desk-a1', name: 'Sales Desk', description: undefined }

  it('groups the entries under the person\'s sections in their order, an empty one included', () => {
    expect(formatAgentList([bare, sales], {
      personName: 'Jeremy',
      sections: [
        { name: 'Sales', agents: ['sales-desk-a1'] },
        { name: 'Your Agents', agents: ['billing-ops-x7'] },
        { name: 'Archive', agents: [] },
      ],
    })).toBe([
      'Available agents (2):',
      'Your sidebar sections (for Jeremy):',
      '## Sales',
      '- sales-desk-a1 (Sales Desk)\n  Created 2026-09-14 · 0 sessions',
      '## Your Agents',
      formatAgentEntry(bare),
      '## Archive',
      '(no agents listed here)',
    ].join('\n'))
  })

  it('prints one flat list when no person is behind the call', () => {
    expect(formatAgentList([bare])).toBe(`Available agents (1):\n${formatAgentEntry(bare)}`)
  })
})
