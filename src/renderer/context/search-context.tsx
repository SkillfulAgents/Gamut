import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

interface SearchActions {
  openSearch: () => void
  closeSearch: () => void
}

// Two contexts, so that opening or closing search renders only what shows the
// dialog. The actions never change; a component that only opens search (the
// sidebar's button, Home's) must not render again each time `open` flips.
const SearchActionsContext = createContext<SearchActions | null>(null)
const SearchOpenContext = createContext<boolean | null>(null)

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const openSearch = useCallback(() => setOpen(true), [])
  const closeSearch = useCallback(() => setOpen(false), [])
  const actions = useMemo(() => ({ openSearch, closeSearch }), [openSearch, closeSearch])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // The dialog itself renders from RootLayout (inside the router) so it can use
  // the useNavigate hook; this provider just owns the open state + the
  // cmd/ctrl-K shortcut.
  return (
    <SearchActionsContext.Provider value={actions}>
      <SearchOpenContext.Provider value={open}>
        {children}
      </SearchOpenContext.Provider>
    </SearchActionsContext.Provider>
  )
}

/** Open or close search. The returned object is the same for the provider's whole life. */
export function useSearch(): SearchActions {
  const ctx = useContext(SearchActionsContext)
  if (!ctx) throw new Error('useSearch must be used within a SearchProvider')
  return ctx
}

/**
 * Whether search is open. Whoever calls this renders on every open and close,
 * so it belongs in the dialog and its mount point, not in a layout or a page.
 */
export function useSearchOpen(): boolean {
  const open = useContext(SearchOpenContext)
  if (open === null) throw new Error('useSearchOpen must be used within a SearchProvider')
  return open
}
