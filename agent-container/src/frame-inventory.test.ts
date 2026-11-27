import { describe, it, expect } from 'vitest'
import { treeFrameRefs, frameInventory, formatFrameInventory, parseFrameInfo, formatFrameLine, frameUrlShown, FRAME_INFO_SCRIPT } from './frame-inventory'
import { withoutCliAdvice } from './browser-output'

// Iframe lines agent-browser 0.45.0 printed for stripe-payments-demo.appspot.com.
const TREE = [
  '- heading "Payment Information" [level=2, ref=e40]',
  '- Iframe "Secure payment button frame" [ref=e1876]',
  '- Iframe "Secure card payment input frame" [ref=e1885]',
  '  - textbox "Credit or debit card number" [required, ref=e1890]',
  '- Iframe [ref=e1900]',
].join('\n')

describe('treeFrameRefs', () => {
  it('reads each Iframe line\'s ref and name', () => {
    expect(treeFrameRefs(TREE)).toEqual([
      { ref: 'e1876', title: 'Secure payment button frame' },
      { ref: 'e1885', title: 'Secure card payment input frame' },
      { ref: 'e1900', title: '' },
    ])
    expect(treeFrameRefs('- Iframe "Say \\"hi\\"" [ref=e5]')).toEqual([{ ref: 'e5', title: 'Say "hi"' }])
  })
})

describe('frameInventory', () => {
  it('gives each visible frame the ref of the tree line with its name', () => {
    const entries = frameInventory([
      { title: 'Secure card payment input frame', host: 'js.stripe.com', sameOrigin: false },
      { title: 'Secure payment button frame', host: 'js.stripe.com', sameOrigin: false },
      { title: '', host: 'ads.example.net', sameOrigin: false },
    ], TREE)
    expect(entries).toEqual([
      { ref: 'e1885', title: 'Secure card payment input frame', host: 'js.stripe.com', sameOrigin: false },
      { ref: 'e1876', title: 'Secure payment button frame', host: 'js.stripe.com', sameOrigin: false },
      { ref: null, title: '', host: 'ads.example.net', sameOrigin: false },
    ])
  })

  it('gives no ref when two frames share a name: which line is which is not known', () => {
    const tree = '- Iframe "Chat" [ref=e1]\n- Iframe "Chat" [ref=e2]'
    const entries = frameInventory([{ title: 'Chat', host: 'a.test', sameOrigin: false }, { title: 'Chat', host: 'b.test', sameOrigin: false }], tree)
    expect(entries.map(e => e.ref)).toEqual([null, null])
  })
})

describe('formatFrameInventory', () => {
  it('lists the frames with their origin and what selects them', () => {
    const text = formatFrameInventory([
      { ref: 'e1885', title: 'Secure card payment input frame', host: 'js.stripe.com', sameOrigin: false },
      { ref: null, title: 'Help', host: 'shop.test', sameOrigin: true },
    ], null)
    expect(text).toBe('Frames on the page (2):\n- "Secure card payment input frame" (js.stripe.com, cross-origin) — browser_frame("@e1885")\n- "Help" (shop.test)')
    expect(formatFrameInventory([], null)).toBe('The page shows no frames.')
    expect(formatFrameInventory([], '#pay')).toBe('Frame #pay is selected. The page shows no other frames.')
    expect(formatFrameInventory([{ ref: 'e2', title: 'Pay', host: 'p.test', sameOrigin: false }], '@e2')).toMatch(/^Frame @e2 is selected; the page's frames:/)
  })
})

describe('the selected frame', () => {
  it('reads the frame\'s address and title as the CLI prints the script\'s answer', () => {
    const printed = JSON.stringify(JSON.stringify({ u: 'https://js.stripe.com/v3/elements-inner-card.html', t: '' }))
    expect(parseFrameInfo(printed, '@e1885')).toEqual({ target: '@e1885', url: 'https://js.stripe.com/v3/elements-inner-card.html', title: '' })
    expect(parseFrameInfo('null', '@e1885')).toBeNull()
    expect(parseFrameInfo('✗ boom', '@e1885')).toBeNull()
  })

  it('answers null on the top frame and the frame\'s address inside one', () => {
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('window', 'location', 'document', `return ${FRAME_INFO_SCRIPT}`)
    const page: { top?: unknown } = {}
    page.top = page
    expect(evaluate(page, { href: 'https://shop.test/' }, { title: 'Shop' })).toBeNull()
    expect(evaluate({ top: page }, { href: 'https://js.stripe.com/x' }, { title: 'Card' })).toBe('{"u":"https://js.stripe.com/x","t":"Card"}')
  })

  it('says on the status line where the tree is from and how to go back', () => {
    expect(formatFrameLine({ target: '@e1885', url: 'https://js.stripe.com/x', title: '' }, 3))
      .toBe('[frame] https://js.stripe.com/x · untitled · 3 refs — selected with browser_frame (@e1885); browser_frame("main") returns to the page')
    expect(formatFrameLine({ target: '#pay', url: 'https://p.test/', title: 'Pay' }, null))
      .toBe('[frame] https://p.test/ · "Pay" — selected with browser_frame (#pay); browser_frame("main") returns to the page')
  })
})

describe('frameUrlShown', () => {
  it('shows a frame\'s origin and path, not the parent state in its query', () => {
    // As Stripe's card frame reported itself on stripe-payments-demo.appspot.com.
    expect(frameUrlShown('https://js.stripe.com/v3/elements-inner-card-c9060da879ecf88d43c1f4c667ddeb5d.html#__shared_params__[version]=v3&__shared_params__[light_experiment_assignments]=%7B%22token%22'))
      .toBe('https://js.stripe.com/v3/elements-inner-card-c9060da879ecf88d43c1f4c667ddeb5d.html?…')
    expect(frameUrlShown('http://127.0.0.1:8766/inner.html')).toBe('http://127.0.0.1:8766/inner.html')
    expect(frameUrlShown('about:srcdoc')).toBe('about:srcdoc')
  })
})

describe('withoutCliAdvice', () => {
  it('keeps the CLI\'s observation and drops its advice to open the frame\'s URL', () => {
    // click_point.rs (0.44+)
    expect(withoutCliAdvice("✗ Element '@e12' cannot be clicked safely: a click at (40, 300) would land outside its frame, so the input could reach a different element. Open the frame's own URL to interact with it."))
      .toBe("✗ Element '@e12' cannot be clicked safely: a click at (40, 300) would land outside its frame, so the input could reach a different element.")
    expect(withoutCliAdvice("✗ … that the element does not embed, so the input could reach a different element. Open that frame's own URL to interact with it."))
      .toBe('✗ … that the element does not embed, so the input could reach a different element.')
    expect(withoutCliAdvice('✗ Unknown ref: e3')).toBe('✗ Unknown ref: e3')
  })
})
