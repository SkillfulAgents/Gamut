// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const useSettingsMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useUpdateSettings: () => ({ mutate: vi.fn() }),
}))

import { AuthTab } from './auth-tab'

describe('AuthTab', () => {
  beforeEach(() => {
    useSettingsMock.mockReturnValue({
      isLoading: false,
      data: {
        auth: {
          signupMode: 'invitation_only',
          requireAdminApproval: true,
          allowLocalAuth: true,
          allowSocialAuth: false,
          passwordMinLength: 12,
          trustedOrigins: [],
        },
      },
    })
  })

  it('hides Signup & Access, Authentication Methods, and Password Policy when platform-controlled', () => {
    render(<AuthTab hideLocalAuthSections />)
    expect(screen.queryByText('Signup & access')).not.toBeInTheDocument()
    expect(screen.queryByText('Authentication methods')).not.toBeInTheDocument()
    expect(screen.queryByText('Password policy')).not.toBeInTheDocument()
    expect(screen.getByText('Session & lockout')).toBeInTheDocument()
    expect(screen.getByText('Trusted origins')).toBeInTheDocument()
  })

  it('shows local auth sections by default', () => {
    render(<AuthTab />)
    expect(screen.getByText('Signup & access')).toBeInTheDocument()
    expect(screen.getByText('Authentication methods')).toBeInTheDocument()
    expect(screen.getByText('Password policy')).toBeInTheDocument()
  })
})
