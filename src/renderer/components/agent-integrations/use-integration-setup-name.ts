import { useState, type ChangeEvent } from 'react'

/** Follow the agent's name until a suggestion or an edit supplies an explicit integration name. */
export function useIntegrationSetupName(defaultName: string, suggested?: string, maxLength?: number) {
  const fallback = defaultName.trim().slice(0, maxLength)
  const [draft, setDraft] = useState(suggested?.trim().slice(0, maxLength) || undefined)
  const override = draft?.trim() || undefined
  return {
    effective: override ?? fallback,
    // Chat integrations inherit future agent renames unless setup supplies an override.
    override,
    input: {
      value: draft ?? fallback,
      placeholder: fallback,
      maxLength,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    },
  }
}

export type IntegrationSetupName = ReturnType<typeof useIntegrationSetupName>
