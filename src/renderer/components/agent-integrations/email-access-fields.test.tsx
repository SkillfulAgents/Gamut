// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { EmailAccessFields, parseEmailDomains } from './email-access-fields'
const state = vi.hoisted(() => ({ members: ['owner@example.com'] as string[] | undefined, auth: false, pending: false, roster: undefined as Array<{ id: string; name?: string; email: string }> | undefined }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: state.auth, user: { email: 'member@example.com' } }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: () => ({ data: state.roster }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({ useAgentIntegrationSetup: () => ({ data: { agentUserEmails: state.members }, isPending: state.pending }) }))
const props = { agentSlug: 'agent', onChange: vi.fn(), domains: '', onDomainsChange: vi.fn() }
afterEach(cleanup)
beforeEach(() => { state.members = ['owner@example.com']; state.auth = false; state.pending = false; state.roster = undefined })
/** The roster opens on hover or focus, as it does in the sidebar. */
const openRoster = () => { fireEvent.focus(screen.getByTestId('email-access-people')); return screen.getByRole('list', { name: 'People with access' }) }
it('offers four choices as radio rows, each one line that says what it means', async () => {
  const user = userEvent.setup()
  render(<EmailAccessFields {...props} value="agent-users-and-replies" />)
  const group = screen.getByRole('radiogroup', { name: 'Email access' })
  expect(within(group).getAllByRole('radio').map(option => option.textContent)).toEqual([
    'Only people with access to this agent', 'People with access, plus anyone it emails first', 'Only people at domains you choose', 'Anyone',
  ])
  expect(within(group).getByRole('radio', { name: 'People with access, plus anyone it emails first' })).toBeChecked()
  expect(within(group).getAllByRole('radio', { checked: true })).toHaveLength(1)
  await user.click(screen.getByTestId('email-access-anyone'))
  expect(props.onChange).toHaveBeenCalledWith('anyone')
})
it('opens what a choice needs under its own row, and leaves the choices alone when disabled', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<EmailAccessFields {...props} onChange={onChange} value="allowed-domains" disabled />)
  // The domains field sits in the chosen row's own block, not under the whole list.
  expect(screen.getByTestId('email-access-allowed-domains').parentElement).toContainElement(screen.getByLabelText('Allowed domains'))
  await user.click(screen.getByTestId('email-access-anyone'))
  expect(onChange).not.toHaveBeenCalled()
})
it('shows the people with access as faces, and names them on hover, the connected account as You', () => {
  render(<EmailAccessFields {...props} value="agent-users-and-replies" />)
  expect(screen.getByTestId('email-access-people')).toHaveAccessibleName('1 person with access')
  const roster = openRoster()
  expect(within(roster).getAllByRole('listitem')).toHaveLength(1)
  expect(within(roster).getByRole('listitem')).toHaveTextContent('owner@example.com')
  expect(within(roster).getByRole('listitem')).toHaveTextContent('You')
  // Who has access today, and nothing to do about it here.
  expect(within(screen.getByTestId('email-access-people-list')).queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByText(/Mail that fails sender checks is rejected/)).toBeInTheDocument()
})
it('labels the signed-in member as You in auth mode, with names from the roster where it has them', () => {
  state.auth = true; state.members = ['owner@example.com', 'member@example.com']
  state.roster = [{ id: 'u1', name: 'Olive Owner', email: 'Owner@example.com' }]
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByTestId('email-access-people')).toHaveAccessibleName('2 people with access')
  const [owner, member] = within(openRoster()).getAllByRole('listitem')
  expect(owner).toHaveTextContent('Olive Owner')
  // Matched to the roster whatever the address's case.
  expect(owner).toHaveTextContent('Owner@example.com')
  expect(owner).not.toHaveTextContent('You')
  // Someone the roster doesn't list (an admin, say) still shows, by address.
  expect(member).toHaveTextContent('member@example.com')
  expect(member).toHaveTextContent('You')
})
it('shows empty membership explicitly without inventing a connected-account allowance', () => {
  state.members = []
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByText('No one with access has an email address yet.')).toBeInTheDocument()
  expect(screen.queryByTestId('email-access-people')).not.toBeInTheDocument()
})
it('does not confuse an unavailable list with an empty list', () => {
  state.members = undefined
  render(<EmailAccessFields {...props} value="agent-users" />)
  expect(screen.getByText('Couldn’t load who has access.')).toBeInTheDocument()
  expect(screen.queryByText(/No one with access/)).not.toBeInTheDocument()
})
it('keeps the list to an owner when it cannot be previewed', () => {
  render(<EmailAccessFields {...props} value="agent-users" canPreview={false} />)
  expect(screen.getByText('An owner can see who has access.')).toBeInTheDocument()
  expect(screen.queryByText(/owner@example.com/)).not.toBeInTheDocument()
})
it('asks for the domains under that choice, and warns only for a public inbox', () => {
  const { rerender } = render(<EmailAccessFields {...props} value="allowed-domains" domains="company.com" />)
  // What's already allowed is listed under the field, which waits for another.
  expect(screen.getByLabelText('Allowed domains')).toHaveValue('')
  expect(screen.getByRole('list', { name: 'Added domains' })).toHaveTextContent('company.com')
  expect(screen.queryByTestId('email-access-people')).not.toBeInTheDocument()
  expect(screen.queryByRole('note')).not.toBeInTheDocument()
  rerender(<EmailAccessFields {...props} value="anyone" />)
  expect(screen.queryByLabelText('Allowed domains')).not.toBeInTheDocument()
  expect(screen.getByRole('note')).toHaveTextContent('Keep approvals on for sensitive actions.')
  expect(screen.queryByText(/Mail that fails sender checks/)).not.toBeInTheDocument()
  expect(screen.queryByText(/never by email/)).not.toBeInTheDocument()
})
it('adds domains one at a time, with Add or Enter, and takes one off again', () => {
  const onDomainsChange = vi.fn()
  const { rerender } = render(<EmailAccessFields {...props} value="allowed-domains" onDomainsChange={onDomainsChange} domainsLaterNote />)
  expect(screen.getByText(/You can add more later/)).toBeInTheDocument()
  const field = screen.getByLabelText('Allowed domains')
  expect(screen.getByTestId('email-domains-add')).toBeDisabled()
  fireEvent.change(field, { target: { value: 'Company.com' } })
  fireEvent.click(screen.getByTestId('email-domains-add'))
  expect(onDomainsChange).toHaveBeenLastCalledWith('company.com')
  expect(field).toHaveValue('')

  rerender(<EmailAccessFields {...props} value="allowed-domains" domains="company.com" onDomainsChange={onDomainsChange} />)
  expect(field).toHaveAttribute('placeholder', 'Add another domain')
  fireEvent.change(field, { target: { value: 'team.company.com' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(onDomainsChange).toHaveBeenLastCalledWith('company.com, team.company.com')

  rerender(<EmailAccessFields {...props} value="allowed-domains" domains="company.com, team.company.com" onDomainsChange={onDomainsChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove company.com' }))
  expect(onDomainsChange).toHaveBeenLastCalledWith('team.company.com')
})
it('takes a pasted list apart, reads a domain out of an address or a link, and keeps what isn’t one in the field', () => {
  const onDomainsChange = vi.fn()
  render(<EmailAccessFields {...props} value="allowed-domains" onDomainsChange={onDomainsChange} />)
  const field = screen.getByLabelText('Allowed domains')
  fireEvent.change(field, { target: { value: 'sam@acme.com, https://example.org/team; acme, acme.com' } })
  expect(onDomainsChange).toHaveBeenLastCalledWith('acme.com, example.org')
  expect(field).toHaveValue('acme')
  expect(screen.getByRole('alert')).toHaveTextContent('“acme” isn’t a domain')
  // Typing again clears the complaint.
  fireEvent.change(field, { target: { value: 'acme.' } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('adds a domain left in the field when focus moves on, so submitting doesn’t lose it', () => {
  const onDomainsChange = vi.fn()
  render(<EmailAccessFields {...props} value="allowed-domains" onDomainsChange={onDomainsChange} />)
  const field = screen.getByLabelText('Allowed domains')
  fireEvent.change(field, { target: { value: 'company.com' } })
  fireEvent.blur(field)
  expect(onDomainsChange).toHaveBeenLastCalledWith('company.com')
})
it('reads a pasted list of domains once each, lower-cased', () => {
  expect(parseEmailDomains('Company.com, team.company.com, company.com')).toEqual(['company.com', 'team.company.com'])
})
