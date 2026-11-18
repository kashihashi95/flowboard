import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { lineHeight, textBox } from './geometry'
import { defaultAlign, paragraphsOf, paragraphsToHtml } from './richtext'
import { textColorOf } from './render'
import { TEXT_COLORS, type NodeEl, type View } from './types'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

/** A toolbar floating above a point on the canvas, kept fully on screen. */
export function FloatingBar({
  x,
  y,
  className,
  children,
  style,
}: {
  x: number
  y: number
  className: string
  children: ReactNode
  style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(x)
  // The bar's width can depend on where it sits (it wraps near an edge), so
  // settle after a couple of passes instead of chasing it forever.
  const passes = useRef({ x, n: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (passes.current.x !== x) passes.current = { x, n: 0 }
    if (passes.current.n >= 3) return
    passes.current.n++
    const next = !el || !parent ? x : Math.max(Math.min(x, parent.clientWidth - el.offsetWidth / 2 - 8), el.offsetWidth / 2 + 8)
    if (Math.abs(next - left) >= 0.5) setLeft(next)
  })
  return (
    <div ref={ref} className={className} style={{ ...style, left, top: Math.max(64, y) }} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

export const FONT_PRESETS = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 128, 200]

/** A font size box you can type any number into, with common sizes suggested. */
export function FontSizeInput({ value, onChange, onDone }: { value: number; onChange: (v: number) => void; onDone?: () => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const apply = () => {
    const v = Math.round(Number(draft) * 10) / 10
    if (Number.isFinite(v) && v >= 1 && v <= 1000) {
      if (v !== value) onChange(v)
    } else {
      setDraft(String(value))
    }
  }
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? FONT_PRESETS.find((p) => p > value) ?? value + 50 : [...FONT_PRESETS].reverse().find((p) => p < value) ?? Math.max(1, value - 1)
    onChange(next)
  }
  return (
    <div className="fontsize" title="Text size">
      <button className="mini" aria-label="Smaller text" onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)}>
        −
      </button>
      <input
        id="font-size"
        aria-label="Text size"
        inputMode="decimal"
        list="font-size-presets"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          // Picking from the suggestion list applies straight away.
          const v = Number(e.target.value)
          if (FONT_PRESETS.includes(v) && v !== value) onChange(v)
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            apply()
            onDone?.()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            onChange(Math.min(1000, value + 1))
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            onChange(Math.max(1, value - 1))
          }
        }}
      />
      <datalist id="font-size-presets">
        {FONT_PRESETS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <button className="mini" aria-label="Larger text" onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)}>
        +
      </button>
    </div>
  )
}

/** The text box shown while editing a shape's text. Its content is plain DOM
 *  managed by the browser's editing commands; it is read back on finish. */
export function RichEditor({
  n,
  view,
  editorRef,
  onDone,
  onInput,
  links = [],
  onLinkPicked,
}: {
  n: NodeEl
  view: View
  editorRef: RefObject<HTMLDivElement | null>
  onDone: () => void
  /** Called as the text changes, so the shape can resize to fit. */
  onInput?: () => void
  /** Link phrases on the board, offered when "/" is typed. */
  links?: string[]
  /** A suggested link was inserted as a new link point with this id. */
  onLinkPicked?: (id: string) => void
}) {
  // Typing "/" opens a list of the board's links, narrowed by what follows it.
  const [slash, setSlash] = useState<{ node: Text; at: number; query: string; index: number; x: number; y: number } | null>(null)
  const matches = slash ? matchLinks(links, slash.query) : []

  // Resting the pointer on words that are a link elsewhere on the board offers
  // a small "Link" chip above them; it never takes focus or moves the caret.
  const [suggest, setSuggest] = useState<{ node: Text; start: number; end: number; phrase: string; x: number; y: number } | null>(null)
  const hoverTimer = useRef(0)
  const hideTimer = useRef(0)
  const hideSoon = () => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setSuggest(null), 450)
  }
  const keep = () => window.clearTimeout(hideTimer.current)
  useEffect(() => () => {
    window.clearTimeout(hoverTimer.current)
    window.clearTimeout(hideTimer.current)
  }, [])
  const lookAt = (x: number, y: number) => {
    const hit = linkWordAt(editorRef.current, links, x, y)
    if (!hit) return hideSoon()
    keep()
    if (suggest && suggest.node === hit.node && suggest.start === hit.start) return
    const r = document.createRange()
    r.setStart(hit.node, hit.start)
    r.setEnd(hit.node, hit.end)
    const box = r.getBoundingClientRect()
    setSuggest({ ...hit, x: box.left + box.width / 2, y: box.top })
  }
  const linkSuggested = () => {
    const sg = suggest
    setSuggest(null)
    if (!sg || !sg.node.isConnected || sg.node.data.slice(sg.start, sg.end).toLowerCase() !== sg.phrase.toLowerCase()) return
    const word = sg.end < sg.node.length ? (sg.node.splitText(sg.end), sg.node) : sg.node
    const piece = sg.start > 0 ? word.splitText(sg.start) : word
    const id = Math.random().toString(36).slice(2, 8)
    const span = document.createElement('span')
    span.className = 'linkmark'
    span.dataset.link = id
    piece.replaceWith(span)
    span.appendChild(piece)
    onLinkPicked?.(id)
    onInput?.()
  }

  const trackSlash = () => {
    const sel = window.getSelection()
    const caret = sel?.rangeCount && sel.isCollapsed ? sel.getRangeAt(0) : null
    const node = caret?.startContainer
    if (!caret || !(node instanceof Text) || !editorRef.current?.contains(node)) return setSlash(null)
    const off = caret.startOffset
    let at = slash && slash.node === node ? slash.at : -1
    if (at < 0) {
      // Only a "/" just typed at the start of a word opens the list.
      const prev = node.data[off - 2]
      if (node.data[off - 1] === '/' && (off === 1 || /[\s([{"']/.test(prev ?? ''))) at = off - 1
    }
    if (at < 0 || off <= at || node.data[at] !== '/') return setSlash(null)
    const query = node.data.slice(at + 1, off)
    if (query.length > 60 || /^\s/.test(query) || query.includes('/')) return setSlash(null)
    const r = caret.getBoundingClientRect()
    const box = r.height ? r : (node.parentElement ?? editorRef.current).getBoundingClientRect()
    setSlash({ node, at, query, index: query === slash?.query ? slash.index : 0, x: box.left, y: box.bottom })
  }

  const pickLink = (phrase: string) => {
    const sel = window.getSelection()
    if (!slash || !sel?.rangeCount) return
    const caret = sel.getRangeAt(0)
    const range = document.createRange()
    range.setStart(slash.node, slash.at)
    range.setEnd(caret.endContainer, caret.endOffset)
    range.deleteContents()
    const id = Math.random().toString(36).slice(2, 8)
    const span = document.createElement('span')
    span.className = 'linkmark'
    span.dataset.link = id
    span.textContent = phrase
    // A space outside the link, so typing on doesn't extend it.
    const after = document.createTextNode(' ')
    range.insertNode(after)
    range.insertNode(span)
    const r = document.createRange()
    r.setStart(after, 1)
    sel.removeAllRanges()
    sel.addRange(r)
    setSlash(null)
    onLinkPicked?.(id)
    onInput?.()
  }

  useLayoutEffect(() => {
    const el = editorRef.current!
    el.innerHTML = paragraphsToHtml(paragraphsOf(n))
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    try {
      document.execCommand('styleWithCSS', false, 'true')
    } catch {
      /* older browsers: falls back to <b>/<i> tags, which are read back the same way */
    }
    // Only when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.id])

  const z = view.zoom
  const box = textBox(n)
  const lh = lineHeight(n.fontSize)
  const top = n.kind === 'sticky'
  return (
    <div
      className="rich-wrap"
      style={{
        left: (n.x + box.x) * z + view.x,
        top: (n.y + box.y) * z + view.y,
        width: box.w * z,
        minHeight: box.h * z,
        alignItems: top ? 'flex-start' : 'center',
      }}
    >
      <div
        ref={editorRef}
        id="node-text"
        className="rich-editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Shape text"
        style={{
          fontSize: n.fontSize * z,
          lineHeight: `${lh * z}px`,
          color: textColorOf(n),
          textAlign: defaultAlign(n),
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null
          if (next?.closest('.richbar')) return
          onDone()
        }}
        onInput={() => {
          trackSlash()
          onInput?.()
        }}
        onKeyUp={(e) => {
          if (slash && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) trackSlash()
        }}
        onMouseUp={() => slash && trackSlash()}
        onMouseMove={(e) => {
          if (!links.length || e.buttons) return
          const { clientX: x, clientY: y } = e
          window.clearTimeout(hoverTimer.current)
          hoverTimer.current = window.setTimeout(() => lookAt(x, y), suggest ? 60 : 350)
        }}
        onMouseLeave={() => {
          window.clearTimeout(hoverTimer.current)
          if (suggest) hideSoon()
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain')
          if (!text) return
          e.preventDefault()
          document.execCommand('insertText', false, text)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (suggest) setSuggest(null)
          const mod = e.metaKey || e.ctrlKey
          if (slash && e.key === 'Escape') {
            e.preventDefault()
            return setSlash(null)
          }
          if (slash && matches.length && !mod) {
            const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
            if (move) {
              e.preventDefault()
              return setSlash({ ...slash, index: (slash.index + move + matches.length) % matches.length })
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              return pickLink(matches[Math.min(slash.index, matches.length - 1)])
            }
          }
          if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
            e.preventDefault()
            return onDone()
          }
          if (mod && e.shiftKey && e.code === 'KeyK') {
            e.preventDefault()
            toggleLinkPoint(editorRef.current)
            return
          }
          if (mod && e.shiftKey) {
            const k = e.key.toLowerCase()
            const cmd = k === 'x' ? 'strikeThrough' : e.code === 'Digit7' ? 'insertOrderedList' : e.code === 'Digit8' ? 'insertUnorderedList' : null
            if (cmd) {
              e.preventDefault()
              document.execCommand(cmd)
            }
          }
        }}
      />
      {suggest && !slash && (
        <button
          className="link-suggest"
          style={{ left: suggest.x, top: suggest.y }}
          title={`Make "${suggest.phrase}" a link point and connect it to its other copies`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={keep}
          onMouseLeave={hideSoon}
          onClick={linkSuggested}
        >
          Link
        </button>
      )}
      {slash && (
        <div className="slash-menu" style={{ left: Math.max(8, Math.min(slash.x, window.innerWidth - 330)), top: slash.y + 270 > window.innerHeight ? undefined : slash.y + 4, bottom: slash.y + 270 > window.innerHeight ? window.innerHeight - slash.y + 28 : undefined }} onMouseDown={(e) => e.preventDefault()}>
          {matches.length ? (
            matches.map((m, i) => (
              <button key={m} ref={(el) => void (i === slash.index && el?.scrollIntoView({ block: 'nearest' }))} className={i === slash.index ? 'on' : ''} onMouseEnter={() => setSlash({ ...slash, index: i })} onClick={() => pickLink(m)}>
                <span className="linkmark">{m}</span>
              </button>
            ))
          ) : (
            <div className="slash-empty">{links.length ? 'No links match' : 'No links on the board yet. Select words and press ' + MOD + '+Shift+K to make one.'}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** Links whose phrase contains the query, those starting with it first. */
/** The board link under the pointer in the editor that isn't a link point here
 *  yet: whole words matching one of `links`, within one run of text. */
function linkWordAt(editor: HTMLElement | null, links: string[], x: number, y: number): { node: Text; start: number; end: number; phrase: string } | null {
  if (!editor) return null
  let node: Node | null = null
  let off = 0
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y)
    node = pos?.offsetNode ?? null
    off = pos?.offset ?? 0
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y)
    node = r?.startContainer ?? null
    off = r?.startOffset ?? 0
  }
  if (!(node instanceof Text) || !editor.contains(node) || node.parentElement?.closest('[data-link]')) return null
  const text = node.data.toLowerCase()
  const word = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c)
  let best: { start: number; end: number; phrase: string } | null = null
  for (const phrase of links) {
    const p = phrase.trim().toLowerCase()
    if (!p) continue
    for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
      const end = i + p.length
      if (off < i || off > end || word(text[i - 1]) || word(text[end])) continue
      if (!best || p.length > best.end - best.start) best = { start: i, end, phrase: phrase.trim() }
    }
  }
  if (!best) return null
  // Only when the pointer is really over the words, not just level with them at a line end.
  const r = document.createRange()
  r.setStart(node, best.start)
  r.setEnd(node, best.end)
  const over = [...r.getClientRects()].some((b) => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2)
  return over ? { node, ...best } : null
}

function matchLinks(links: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const hits = links.filter((l) => l.toLowerCase().includes(q))
  return hits.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b)).slice(0, 30)
}

const exec = (cmd: string, value?: string) => {
  try {
    document.execCommand('styleWithCSS', false, 'true')
  } catch {
    /* ignore */
  }
  document.execCommand(cmd, false, value)
}

/** The link-point span the editor's selection sits in, if any. */
function linkAtSelection(editor: HTMLElement | null): HTMLElement | null {
  const sel = window.getSelection()
  if (!editor || !sel?.rangeCount) return null
  const node = sel.getRangeAt(0).commonAncestorContainer
  const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-link]')
  return el && editor.contains(el) ? el : null
}

/** Turn the selected words into a link point connectors can attach to, or
 *  turn an existing one back into plain text. Returns false when nothing was selected. */
export function toggleLinkPoint(editor: HTMLElement | null): boolean {
  const sel = window.getSelection()
  if (!editor || !sel?.rangeCount) return false
  const existing = linkAtSelection(editor)
  if (existing) {
    for (const span of editor.querySelectorAll<HTMLElement>(`[data-link="${existing.dataset.link}"]`)) span.replaceWith(...span.childNodes)
    editor.normalize()
    return true
  }
  const range = sel.getRangeAt(0)
  if (range.collapsed || !editor.contains(range.commonAncestorContainer) || !range.toString().trim()) return false
  const id = Math.random().toString(36).slice(2, 8)
  // Wrap each selected text node on its own so a phrase spanning paragraphs or
  // styled pieces keeps its structure.
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) texts.push(range.commonAncestorContainer as Text)
  while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) texts.push(walker.currentNode as Text)
  let first: Node | null = null
  let last: Node | null = null
  for (let t of texts) {
    const start = t === range.startContainer ? range.startOffset : 0
    const end = t === range.endContainer ? range.endOffset : t.length
    if (end <= start) continue
    if (end < t.length) t.splitText(end)
    if (start > 0) t = t.splitText(start)
    const span = document.createElement('span')
    span.className = 'linkmark'
    span.dataset.link = id
    t.replaceWith(span)
    span.appendChild(t)
    first ??= span
    last = span
  }
  if (first && last) {
    const r = document.createRange()
    r.setStartBefore(first)
    r.setEndAfter(last)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  return !!first
}

const STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'insertUnorderedList', 'insertOrderedList'] as const

/** Formatting toolbar shown above a shape while its text is being edited. */
export function RichToolbar({
  n,
  view,
  editorRef,
  onFontSize,
}: {
  n: NodeEl
  view: View
  editorRef: RefObject<HTMLDivElement | null>
  onFontSize: (v: number) => void
}) {
  const [active, setActive] = useState<Record<string, boolean>>({})
  const [colors, setColors] = useState(false)
  const [hint, setHint] = useState(false)
  useEffect(() => {
    const update = () => {
      const next: Record<string, boolean> = { link: !!linkAtSelection(editorRef.current) }
      for (const c of STATE_CMDS) {
        try {
          next[c] = document.queryCommandState(c)
        } catch {
          next[c] = false
        }
      }
      setActive(next)
    }
    update()
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [editorRef])

  const z = view.zoom
  const btn = (cmd: (typeof STATE_CMDS)[number] | 'removeFormat', label: string, icon: ReactNode) => (
    <button
      className={`iconbtn${active[cmd] ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={cmd === 'removeFormat' ? undefined : !!active[cmd]}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        exec(cmd)
        editorRef.current?.focus()
      }}
    >
      {icon}
    </button>
  )
  return (
    <FloatingBar className="chrome stylebar richbar" x={(n.x + n.w / 2) * z + view.x} y={n.y * z + view.y - 16}>
      <FontSizeInput value={n.fontSize} onChange={onFontSize} onDone={() => editorRef.current?.focus()} />
      <span className="sep" />
      {btn('bold', `Bold (${MOD}+B)`, <b className="glyph">B</b>)}
      {btn('italic', `Italic (${MOD}+I)`, <i className="glyph serif">I</i>)}
      {btn('underline', `Underline (${MOD}+U)`, <u className="glyph">U</u>)}
      {btn('strikeThrough', `Strikethrough (${MOD}+Shift+X)`, <s className="glyph">S</s>)}
      <div className="popwrap">
        <button
          className="iconbtn"
          title="Text color"
          aria-label="Text color"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setColors((c) => !c)}
        >
          <span className="glyph color-a">A</span>
        </button>
        {colors && (
          <div className="pop colors">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.label}
                className="swatchbtn"
                title={c.label}
                aria-label={c.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const base = editorRef.current ? getComputedStyle(editorRef.current).color : '#1e1e1e'
                  exec('foreColor', c.value || base)
                  setColors(false)
                }}
              >
                <span className="swatch" style={{ background: c.value || 'var(--ink)', borderColor: c.value === '#ffffff' ? 'var(--line)' : 'transparent' }} />
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="sep" />
      {btn('justifyLeft', 'Align left', <AlignIcon kind="left" />)}
      {btn('justifyCenter', 'Align center', <AlignIcon kind="center" />)}
      {btn('justifyRight', 'Align right', <AlignIcon kind="right" />)}
      <span className="sep" />
      {btn('insertUnorderedList', `Bulleted list (${MOD}+Shift+8)`, <ListIcon numbered={false} />)}
      {btn('insertOrderedList', `Numbered list (${MOD}+Shift+7)`, <ListIcon numbered />)}
      {btn('removeFormat', 'Clear formatting', <ClearIcon />)}
      <span className="sep" />
      <div className="popwrap">
        <button
          className={`iconbtn${active.link ? ' on' : ''}`}
          title={active.link ? 'Remove link point' : `Link point: lets a connector attach to the selected words (${MOD}+Shift+K)`}
          aria-label={active.link ? 'Remove link point' : 'Make the selected words a link point'}
          aria-pressed={!!active.link}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const ok = toggleLinkPoint(editorRef.current)
            setHint(!ok)
            if (!ok) setTimeout(() => setHint(false), 1800)
            setActive((a) => ({ ...a, link: !!linkAtSelection(editorRef.current) }))
            editorRef.current?.focus()
          }}
        >
          <LinkIcon />
        </button>
        {hint && <div className="pop hint">Select some words first</div>}
      </div>
    </FloatingBar>
  )
}

export function AlignIcon({ kind }: { kind: 'left' | 'center' | 'right' }) {
  const rows = [16, 10, 16, 10]
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      {rows.map((w, i) => {
        const x1 = kind === 'left' ? 4 : kind === 'right' ? 20 - w : 12 - w / 2
        return <line key={i} x1={x1} x2={x1 + w} y1={6 + i * 4} y2={6 + i * 4} />
      })}
    </svg>
  )
}

export function ListIcon({ numbered }: { numbered: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" fill="none" aria-hidden="true">
      {[7, 12, 17].map((y, i) => (
        <g key={y}>
          {numbered ? (
            <text x="3" y={y + 2.5} fontSize="7" fill="currentColor" stroke="none" fontFamily="system-ui">
              {i + 1}
            </text>
          ) : (
            <circle cx="5" cy={y} r="1.3" fill="currentColor" stroke="none" />
          )}
          <line x1="10" x2="20" y1={y} y2={y} />
        </g>
      ))}
    </svg>
  )
}

export function LinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" fill="none" aria-hidden="true">
      <path d="M6 5h12M12 5l-3 14M4 20 20 4" />
    </svg>
  )
}
