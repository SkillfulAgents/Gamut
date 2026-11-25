import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { offersPrivateSkillsets } from '@renderer/lib/capabilities'
import {
  useSkillsets,
  useValidateSkillset,
  useAddSkillset,
  useRemoveSkillset,
  useRefreshSkillset,
  useUpdateSkillsetCredential,
} from '@renderer/hooks/use-skillsets'
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { SETTINGS_CARD_CLASS } from './setting-row'
import { SettingsHeaderActions } from './settings-page'

/**
 * The form that adds a skillset repository, in a dialog off the page title's Add button: the page itself is the
 * list of what is already added.
 */
function AddSkillsetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const validateSkillset = useValidateSkillset()
  const addSkillset = useAddSkillset()
  // A private repository clones on the server, which a sandboxed build can't do.
  const privateSkillsets = offersPrivateSkillsets()
  const [urlInput, setUrlInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    error?: string
  } | null>(null)

  const isBusy = validateSkillset.isPending || addSkillset.isPending

  const reset = () => {
    setUrlInput('')
    setTokenInput('')
    setValidationResult(null)
  }

  const handleValidateAndAdd = async () => {
    if (!urlInput.trim() || isBusy) return
    setValidationResult(null)

    try {
      const input = { url: urlInput.trim(), token: tokenInput.trim() || undefined }
      const result = await validateSkillset.mutateAsync(input)

      if (result.valid) {
        await addSkillset.mutateAsync(input)
        reset()
        onOpenChange(false)
      } else {
        setValidationResult({ valid: false, error: result.error })
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to add skillset',
      })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="skillsets-add-dialog">
        <DialogHeader>
          <DialogTitle>Add a skillset</DialogTitle>
          <DialogDescription>
            A git repository of skills your agents can discover and install. It needs an index.json file.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleValidateAndAdd()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="skillset-url">Repository URL</Label>
            <Input
              id="skillset-url"
              placeholder="https://github.com/org/skillset-repo"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value)
                setValidationResult(null)
              }}
              disabled={isBusy}
              autoFocus
            />
          </div>

          {privateSkillsets && (
            <div className="space-y-2">
              <Label htmlFor="skillset-token">Repository token (optional)</Label>
              <Input
                id="skillset-token"
                type="password"
                autoComplete="off"
                placeholder="Only for a private GitHub repository"
                value={tokenInput}
                onChange={(e) => {
                  setTokenInput(e.target.value)
                  setValidationResult(null)
                }}
                disabled={isBusy}
              />
              {/* The steps are for someone who needs a token: out of the way until asked for. */}
              <Collapsible>
                <CollapsibleTrigger
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  data-testid="skillset-token-help"
                >
                  How to create a token
                  <ChevronDown className="h-3.5 w-3.5 transition-transform [[data-state=closed]>&]:-rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 text-xs">
                  <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                    <li>
                      <a
                        href="https://github.com/settings/personal-access-tokens/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Create a fine-grained personal access token
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>{' '}
                      and choose the repository owner.
                    </li>
                    <li>
                      Under <span className="font-medium text-foreground">Repository access</span>, choose{' '}
                      <span className="font-medium text-foreground">Only select repositories</span> and
                      select this skillset repository.
                    </li>
                    <li>
                      Under <span className="font-medium text-foreground">Repository permissions</span>,
                      set <span className="font-medium text-foreground">Contents</span> to{' '}
                      <span className="font-medium text-foreground">Read-only</span>. GitHub adds Metadata
                      read access automatically.
                    </li>
                    <li>Generate the token and paste it above.</li>
                  </ol>
                  <p className="mt-2 text-muted-foreground">
                    This minimum permission supports discovering, installing, and refreshing skills. A
                    classic token also works with the broader{' '}
                    <code className="rounded bg-muted px-1 py-0.5 text-foreground">repo</code> scope, but a
                    fine-grained token is recommended. Publishing pull requests requires additional write
                    and fork permissions. If GitHub marks an organization token as pending, an organization
                    owner must approve it before it can read private repositories. A private repository
                    must use an HTTPS URL.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {validationResult && !validationResult.valid && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{validationResult.error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!urlInput.trim() || isBusy} data-testid="skillsets-add-submit">
              {isBusy ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Validating...
                </>
              ) : (
                'Add skillset'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const BADGE = 'text-2xs px-1.5 py-0.5 rounded-full font-medium'

export function SkillsetsTab() {
  const { data: skillsets, isLoading } = useSkillsets()
  const removeSkillset = useRemoveSkillset()
  const refreshSkillset = useRefreshSkillset()
  const updateCredential = useUpdateSkillsetCredential()
  const privateSkillsets = offersPrivateSkillsets()
  const [adding, setAdding] = useState(false)
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null)
  const [replacementToken, setReplacementToken] = useState('')
  const [credentialError, setCredentialError] = useState<{
    skillsetId: string
    message: string
  } | null>(null)

  const handleSaveCredential = async (id: string) => {
    if (!replacementToken.trim()) return
    setCredentialError(null)
    try {
      await updateCredential.mutateAsync({ id, token: replacementToken.trim() })
      setReplacementToken('')
      setEditingCredentialId(null)
    } catch (error) {
      setCredentialError({
        skillsetId: id,
        message: error instanceof Error ? error.message : 'Failed to update repository token',
      })
    }
  }

  const handleRemoveCredential = async (id: string) => {
    setCredentialError(null)
    try {
      await updateCredential.mutateAsync({ id, token: null })
      setReplacementToken('')
      setEditingCredentialId(null)
    } catch (error) {
      setCredentialError({
        skillsetId: id,
        message: error instanceof Error ? error.message : 'Failed to remove repository token',
      })
    }
  }

  return (
    <div className="space-y-6">
      {/* Adding is the page's one action, so it sits on the title's row. */}
      <SettingsHeaderActions>
        <Button size="sm" onClick={() => setAdding(true)} data-testid="skillsets-add-button">
          <Plus className="h-4 w-4 mr-1.5" />
          Add
        </Button>
      </SettingsHeaderActions>
      <AddSkillsetDialog open={adding} onOpenChange={setAdding} />

      {isLoading ? (
        <div className={cn(SETTINGS_CARD_CLASS, 'flex items-center gap-2 py-3 px-4 text-[11px] text-muted-foreground')}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading skillsets…
        </div>
      ) : !skillsets || skillsets.length === 0 ? (
        <div className={cn(SETTINGS_CARD_CLASS, 'py-3 px-4 text-[11px] text-muted-foreground')} data-testid="skillsets-empty">
          No skillsets yet. Add a skillset repository to discover and install skills for your agents.
        </div>
      ) : (
        <div className={SETTINGS_CARD_CLASS} data-testid="skillsets-list">
          {skillsets.map((ss) => (
            <div key={ss.id} className="py-3 px-4" data-testid="skillset-row">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-normal truncate">{ss.name}</p>
                    {ss.badgeLabel && (
                      <span className={cn(BADGE, 'bg-primary/10 text-primary')}>{ss.badgeLabel}</span>
                    )}
                    {ss.credential && (
                      <span className={cn(BADGE, 'bg-muted text-muted-foreground')}>
                        Private · {ss.credential.tokenPreview}
                      </span>
                    )}
                  </div>
                  {/* How many skills it holds and what it is: data about the entry, not a description of a setting. */}
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="shrink-0">
                      {ss.skillCount} {ss.skillCount === 1 ? 'skill' : 'skills'}
                    </span>
                    {ss.description && (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="min-w-0 truncate">{ss.description}</span>
                      </>
                    )}
                  </div>
                  {ss.showUrl && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{ss.url}</p>
                  )}
                  {ss.error && (
                    <div className="mt-1.5 flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                      <p className="line-clamp-2 text-[11px] text-destructive">{ss.error}</p>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {privateSkillsets && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const nextId = editingCredentialId === ss.id ? null : ss.id
                        setEditingCredentialId(nextId)
                        setReplacementToken('')
                        setCredentialError(null)
                      }}
                      disabled={updateCredential.isPending || (ss.provider ?? 'github') !== 'github'}
                      title={ss.credential ? 'Replace or remove repository token' : 'Add repository token'}
                    >
                      {editingCredentialId === ss.id ? <X className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => refreshSkillset.mutate(ss.id)}
                    disabled={refreshSkillset.isPending}
                    title="Refresh skillset"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${refreshSkillset.isPending ? 'animate-spin' : ''}`} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeSkillset.mutate(ss.id)}
                    disabled={removeSkillset.isPending}
                    title="Remove skillset"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {editingCredentialId === ss.id && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label={`Repository token for ${ss.name}`}
                      placeholder={ss.credential ? 'Replace repository token' : 'Add repository token'}
                      value={replacementToken}
                      onChange={(e) => {
                        setReplacementToken(e.target.value)
                        setCredentialError(null)
                      }}
                      className="h-8 text-xs"
                      disabled={updateCredential.isPending}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleSaveCredential(ss.id)
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={!replacementToken.trim() || updateCredential.isPending}
                      onClick={() => void handleSaveCredential(ss.id)}
                    >
                      Save
                    </Button>
                    {ss.credential && (
                      <Button
                        size="sm"
                        variant="soft"
                        disabled={updateCredential.isPending}
                        onClick={() => void handleRemoveCredential(ss.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  {credentialError?.skillsetId === ss.id && (
                    <div role="alert" className="flex items-start gap-1.5 text-[11px] text-destructive">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{credentialError.message}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
