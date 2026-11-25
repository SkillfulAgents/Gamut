// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { EmailAccessFields } from './email-access-fields'
import { useEmailDomains } from './email-domains-input'

function Fields({ initial, ...props }: Omit<ComponentProps<typeof EmailAccessFields>, 'domains'> & { initial?: string[] }) {
  const domains = useEmailDomains(props.value, initial)
  return <EmailAccessFields {...props} domains={domains} />
}
const state = vi.hoisted(() => ({ members: ['owner@example.com'] as string[] | undefined, auth: false, pending: false, roster: undefined as Array<{ id: string; name?: string; email: string }> | undefined }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: state.auth, user: { email: 'member@example.com' } }) }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({ usePlatformAuthStatus: () => ({ data: { email: 'owner@example.com' } }) }))
vi.mock('@renderer/hooks/use-agent-members', () => ({ useAgentMembers: () => ({ data: state.roster }) }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({ useAgentIntegrationSetup: () => ({ data: { agentUserEmails: state.members }, isPending: state.pending }) }))
const props = { agentSlug: 'agent', onChange: vi.fn() }
afterEach(cleanup)
beforeEach(() => { state.members = ['owner@example.com']; state.auth = false; state.pending = false; state.roster = undefined })
/** The roster opens on hover or focus, as it does in the sidebar. */
const openRoster = () => { fireEvent.focus(screen.getByTestId('email-access-people')); return screen.getByRole('list', { name: 'People with access' }) }
it('offers four choices as radio rows, each one line that says what it means', async () => {
  const user = userEvent.setup()
  render(<Fields {...props} value="agent-users-and-replies" />)
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
  render(<Fields {...props} onChange={onChange} value="allowed-domains" disabled />)
  // The domains field sits in the chosen row's own block, not under the whole list.
  expect(screen.getByTestId('email-access-allowed-domains').parentElement).toContainElement(screen.getByLabelText('Allowed domains'))
  await user.click(screen.getByTestId('email-access-anyone'))
  expect(onChange).not.toHaveBeenCalled()
})
it('shows the people with access as faces, and names them on hover, the connected account as You', () => {
  render(<Fields {...props} value="agent-users-and-replies" />)
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
  render(<Fields {...props} value="agent-users" />)
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
  render(<Fields {...props} value="agent-users" />)
  expect(screen.getByText('No one with access has an email address yet.')).toBeInTheDocument()
  expect(screen.queryByTestId('email-access-people')).not.toBeInTheDocument()
})
it('does not confuse an unavailable list with an empty list', () => {
  state.members = undefined
  render(<Fields {...props} value="agent-users" />)
  expect(screen.getByText('Couldn’t load who has access.')).toBeInTheDocument()
  expect(screen.queryByText(/No one with access/)).not.toBeInTheDocument()
})
it('keeps the list to an owner when it cannot be previewed', () => {
  render(<Fields {...props} value="agent-users" canPreview={false} />)
  expect(screen.getByText('An owner can see who has access.')).toBeInTheDocument()
  expect(screen.queryByText(/owner@example.com/)).not.toBeInTheDocument()
})
it('asks for the domains under that choice, and warns only for a public inbox', () => {
  const { rerender } = render(<Fields {...props} value="allowed-domains" initial={['company.com']} />)
  // What's already allowed is listed under the field, which waits for another.
  expect(screen.getByLabelText('Allowed domains')).toHaveValue('')
  expect(screen.getByRole('list', { name: 'Added domains' })).toHaveTextContent('company.com')
  expect(screen.queryByTestId('email-access-people')).not.toBeInTheDocument()
  expect(screen.queryByRole('note')).not.toBeInTheDocument()
  rerender(<Fields {...props} value="anyone" />)
  expect(screen.queryByLabelText('Allowed domains')).not.toBeInTheDocument()
  expect(screen.getByRole('note')).toHaveTextContent('Keep approvals on for sensitive actions.')
  expect(screen.queryByText(/Mail that fails sender checks/)).not.toBeInTheDocument()
  expect(screen.queryByText(/never by email/)).not.toBeInTheDocument()
})
it('adds, deduplicates and removes domains with Add, Enter or blur', () => {
  render(<Fields {...props} value="allowed-domains" domainsLaterNote />)
  expect(screen.getByText(/You can add more later/)).toBeInTheDocument()
  const field = screen.getByLabelText('Allowed domains')
  expect(screen.getByTestId('email-domains-add')).toBeDisabled()
  fireEvent.change(field, { target: { value: 'Company.com' } })
  fireEvent.click(screen.getByTestId('email-domains-add'))
  expect(field).toHaveValue('')
  expect(field).toHaveAttribute('placeholder', 'Add another domain')
  fireEvent.change(field, { target: { value: 'team.company.com' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  fireEvent.change(field, { target: { value: '@Company.com' } })
  fireEvent.blur(field)
  const list = screen.getByRole('list', { name: 'Added domains' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Remove company.com' }))
  expect(within(list).getAllByRole('listitem')).toHaveLength(1)
  expect(list).toHaveTextContent('team.company.com')
})

it('reads email domains and URL hostnames and keeps invalid entries editable', () => {
  render(<Fields {...props} value="allowed-domains" />)
  const field = screen.getByLabelText('Allowed domains')
  fireEvent.change(field, { target: { value: 'sam@acme.com, https://directory.org/people/p@customer.com; https://example.org?u=a@another.org, acme, acme.com' } })
  const list = screen.getByRole('list', { name: 'Added domains' })
  expect(within(list).getAllByRole('listitem').map(row => row.textContent)).toEqual(['acme.com', 'directory.org', 'example.org'])
  expect(field).toHaveValue('acme')
  expect(screen.getByRole('alert')).toHaveTextContent('“acme” isn’t a domain')
  fireEvent.change(field, { target: { value: 'acme.org' } })
  fireEvent.blur(field)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(list).toHaveTextContent('acme.org')
})
