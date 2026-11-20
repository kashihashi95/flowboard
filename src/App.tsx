import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { buildSvg, copyBlob, detailScale, download, rasterize, safeName } from './exporter'
import { ExportPanel, type ExportScope } from './ExportPanel'
import { historyBlock, readHistory } from './history'
import { buildMarkdown, parseMarkdown } from './markdown'
import { linkGroups } from './mdformat'
import { diffDocs, withAffected } from './diff'
import { currentTrackKey, loadTrack, rememberTrackKey, saveTrack, type TrackPoint } from './tracks'
import { TimelinePanel } from './TimelinePanel'
import { newSim, reheat, step as physicsStep } from './physics'
import { tidyUp } from './layout'
import { buildIndex, groupHits, hitFocus, hitRects, search, snippet, uniteRects, type Hit } from './search'
import { crossingColors } from './crossing'
import { exists, fileIn, forgetRecent, hasAccess, listBoards, pickWorkspace, recentWorkspaces, requestAccess, savedWorkspace, useWorkspace as makeCurrentWorkspace, workspaceSupported, writeFile, type WorkspaceFile } from './workspace'
import { WorkspacePanel } from './WorkspacePanel'
import { isImageFile, loadImage } from './images'
import {
  anchor,
  nearestOnOutline,
  bundleTrunks,
  setTrunks,
  center,
  contains,
  DIR,
  dist,
  docBounds,
  edgeGeometry,
  moveSegment,
  resolveEnds,
  routePoints,
  intersects,
  lineHeight,
  measure,
  OPPOSITE,
  rectFromPoints,
  insideRect,
  sectionTitleRect,
  SECTION_TITLE_SIZE,
  SIDES,
  unionRects,
  type LinkRect,
} from './geometry'
import { Icons, ShapeIcon } from './icons'
import { EdgeView, HeadIcon, LABEL_FONT, ShapeView, strokeOf, SvgDefs } from './render'
import { alignAll, allRuns, autoSize, listAll, fitToText, htmlToParagraphs, linkRects, paragraphsOf, styleAllRuns, withParagraphs } from './richtext'
import { AlignIcon, FloatingBar, FontSizeInput, ListIcon, RichEditor, RichToolbar } from './TextEditing'
import {
  cloneDoc,
  DEFAULT_SIZE,
  deleteIds,
  extract,
  isDoc,
  normalizeDoc,
  drawOrder,
  withSectionContents,
  htmlWithBoard,
  boardFromHtml,
  embeddedBoard,
  embeddedFirstRun,
  type BoardExtras,
  loadSaved,
  makeEdge,
  makeNode,
  nextSectionName,
  sampleDoc,
  save,
  translate,
  useHistory,
} from './store'
import {
  FLOW_SHAPES,
  INK,
  PALETTE,
  SHAPE_LABELS,
  ARROW_HEADS,
  type ArrowHead,
  type ColorKey,
  type Doc,
  type EdgeEl,
  type EdgeEnd,
  type NodeEl,
  type Pt,
  type Rect,
  type Route,
  type ShapeKind,
  type Side,
  type View,
} from './types'
import MARKDOWN_GUIDE from '../FLOWBOARD-MARKDOWN.md?raw'
import './App.css'

type Tool = 'select' | 'hand' | 'connector' | ShapeKind

/** Where a dragged connector end would attach: a shape side, or a link point inside it. */
interface DropTarget {
  nodeId: string
  side?: Side
  /** Where along the side, 0–1, when not at its middle. */
  at?: number
  textId?: string
}

interface Guide {
  x1: number
  y1: number
  x2: number
  y2: number
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; view: View }
  | { kind: 'move'; start: Pt; before: Doc; base: Doc; ids: Set<string>; moved: boolean; narrowTo?: string; editId?: string; guides: Guide[] }
  | { kind: 'resize'; id: string; dir: string; start: Pt; before: Doc; rect: Rect }
  | { kind: 'marquee'; start: Pt; cur: Pt; base: string[] }
  | { kind: 'create'; shape: ShapeKind; start: Pt; cur: Pt }
  | { kind: 'connect'; from: EdgeEnd; sourceId?: string; quickSide?: Side; cur: Pt; target?: DropTarget; moved: boolean; start?: Pt }
  | { kind: 'edgeEnd'; id: string; end: 'from' | 'to'; before: Doc; target?: DropTarget }
  | { kind: 'segment'; id: string; index: number; start: Pt; before: Doc; base: Pt[]; d1: Pt; d2: Pt; moved: boolean }

interface Editing {
  kind: 'node' | 'edge'
  id: string
  text: string
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 16
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const OUTLINE_WIDTHS = [1, 2, 4, 6]
const WIDTHS = [
  { label: 'Thin', value: 1.5 },
  { label: 'Regular', value: 2 },
  { label: 'Thick', value: 4 },
]
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

function snapMove(r: Rect, others: Rect[], th: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [r.x, r.x + r.w / 2, r.x + r.w]
  const ys = [r.y, r.y + r.h / 2, r.y + r.h]
  let bx = { d: Infinity, at: 0 }
  let by = { d: Infinity, at: 0 }
  for (const o of others) {
    for (const b of [o.x, o.x + o.w / 2, o.x + o.w])
      for (const a of xs) if (Math.abs(b - a) < Math.abs(bx.d) && Math.abs(b - a) <= th) bx = { d: b - a, at: b }
    for (const b of [o.y, o.y + o.h / 2, o.y + o.h])
      for (const a of ys) if (Math.abs(b - a) < Math.abs(by.d) && Math.abs(b - a) <= th) by = { d: b - a, at: b }
  }
  const dx = Number.isFinite(bx.d) ? bx.d : 0
  const dy = Number.isFinite(by.d) ? by.d : 0
  const moved = { ...r, x: r.x + dx, y: r.y + dy }
  const guides: Guide[] = []
  const near = (v: number, list: number[]) => list.some((l) => Math.abs(l - v) < 0.5)
  if (dx || Number.isFinite(bx.d)) {
    const hits = others.filter((o) => near(bx.at, [o.x, o.x + o.w / 2, o.x + o.w]))
    if (hits.length) {
      const all = [moved, ...hits]
      guides.push({ x1: bx.at, x2: bx.at, y1: Math.min(...all.map((o) => o.y)), y2: Math.max(...all.map((o) => o.y + o.h)) })
    }
  }
  if (dy || Number.isFinite(by.d)) {
    const hits = others.filter((o) => near(by.at, [o.y, o.y + o.h / 2, o.y + o.h]))
    if (hits.length) {
      const all = [moved, ...hits]
      guides.push({ y1: by.at, y2: by.at, x1: Math.min(...all.map((o) => o.x)), x2: Math.max(...all.map((o) => o.x + o.w)) })
    }
  }
  return { dx, dy, guides }
}

/** While shapes move, nudge them so a connector to a shape that stays put
 *  runs dead straight when it's nearly straight already. */
function snapConnectors(base: Doc, ids: Set<string>, dx: number, dy: number, th: number): { cx?: number; cy?: number; guides: Guide[] } {
  const nm = new Map(base.nodes.map((n) => [n.id, ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n]))
  let bx: { d: number; g: Guide } | undefined
  let by: { d: number; g: Guide } | undefined
  for (const e of base.edges) {
    const aIn = !!e.from.nodeId && ids.has(e.from.nodeId)
    const bIn = !!e.to.nodeId && ids.has(e.to.nodeId)
    if (aIn === bIn || e.points?.length) continue
    const { p1, d1, p2, d2 } = resolveEnds(e, nm)
    const [pm, dm, pf, df] = aIn ? [p1, d1, p2, d2] : [p2, d2, p1, d1]
    if (dm.x === 0 && df.x === 0) {
      const d = pf.x - pm.x
      if (Math.abs(d) <= th && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, g: { x1: pf.x, x2: pf.x, y1: Math.min(pf.y, pm.y), y2: Math.max(pf.y, pm.y) } }
    } else if (dm.y === 0 && df.y === 0) {
      const d = pf.y - pm.y
      if (Math.abs(d) <= th && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, g: { y1: pf.y, y2: pf.y, x1: Math.min(pf.x, pm.x), x2: Math.max(pf.x, pm.x) } }
    }
  }
  return { cx: bx?.d, cy: by?.d, guides: [bx?.g, by?.g].filter((g): g is Guide => !!g) }
}

/** Corners of an elbow route minus repeats and corners on a straight run. */
const phraseKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Every link phrase on the board, with the shape it sits in. */
function boardLinks(nodes: NodeEl[]): { nodeId: string; id: string; phrase: string }[] {
  return nodes.flatMap((n) => (n.rich ? linkGroups(paragraphsOf(n)).map((g) => ({ nodeId: n.id, id: g.id, phrase: g.phrase.trim() })) : []))
}

/** Connectors from every other place a link appears to the copies of it just
 *  inserted in `n` (ids in `picked`), skipping pairs already joined. */
function joinLinks(d: Doc, n: NodeEl, picked: Set<string>): EdgeEl[] {
  if (!picked.size) return []
  const others = boardLinks(d.nodes.filter((x) => x.id !== n.id))
  const out: EdgeEl[] = []
  for (const g of linkGroups(paragraphsOf(n))) {
    if (!picked.has(g.id)) continue
    for (const o of others) {
      if (phraseKey(o.phrase) !== phraseKey(g.phrase)) continue
      const joined = d.edges.some(
        (e) =>
          (e.from.nodeId === o.nodeId && e.from.textId === o.id && e.to.nodeId === n.id && e.to.textId === g.id) ||
          (e.to.nodeId === o.nodeId && e.to.textId === o.id && e.from.nodeId === n.id && e.from.textId === g.id),
      )
      if (!joined) out.push(makeEdge({ nodeId: o.nodeId, textId: o.id, x: 0, y: 0 }, { nodeId: n.id, textId: g.id, x: 0, y: 0 }, { dashed: true, endHead: 'none' }))
    }
  }
  return out
}

function cleanRoute(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const q of pts) {
    const a = out[out.length - 1]
    if (a && Math.abs(a.x - q.x) < 0.5 && Math.abs(a.y - q.y) < 0.5) continue
    const b = out[out.length - 2]
    if (a && b && ((Math.abs(b.x - a.x) < 0.5 && Math.abs(a.x - q.x) < 0.5) || (Math.abs(b.y - a.y) < 0.5 && Math.abs(a.y - q.y) < 0.5))) out.pop()
    out.push(q)
  }
  return out
}

/** Follows a CSS media query, e.g. a touch screen or a narrow window. */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const change = () => setOn(m.matches)
    change()
    m.addEventListener('change', change)
    return () => m.removeEventListener('change', change)
  }, [query])
  return on
}

export default function App() {
  const saved = useMemo(loadSaved, [])
  const { doc, docRef, commit, live, record, undo, redo, reset, canUndo, canRedo } = useHistory(saved?.doc ?? sampleDoc())
  const [view, setViewState] = useState<View>(saved?.view ?? { x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view)
  const setView = useCallback((v: View) => {
    viewRef.current = v
    setViewState(v)
  }, [])
  const [title, setTitle] = useState(saved?.title ?? 'Untitled flowchart')
  const [tool, setTool] = useState<Tool>('select')
  const [lastShape, setLastShape] = useState<ShapeKind>('rect')
  const [shapeTray, setShapeTray] = useState(false)
  const [selection, setSelectionState] = useState<string[]>([])
  const selectionRef = useRef(selection)
  const setSelection = useCallback((s: string[]) => {
    selectionRef.current = s
    setSelectionState(s)
  }, [])
  const [hover, setHover] = useState<string | null>(null)
  const [editing, setEditingState] = useState<Editing | null>(null)
  const editingRef = useRef(editing)
  const setEditing = useCallback((e: Editing | null) => {
    editingRef.current = e
    setEditingState(e)
  }, [])
  const dragRef = useRef<Drag | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [physics, setPhysics] = useState(false)
  const physicsRef = useRef(false)
  const simRef = useRef(newSim())
  const [spaceDown, setSpaceDown] = useState(false)
  const spaceRef = useRef(false)
  const [popover, setPopover] = useState<'color' | 'outline' | 'shape' | 'align' | 'startHead' | 'endHead' | 'menu' | 'help' | 'endShape' | 'workspace' | 'diff' | 'timeline' | null>(null)
  const [exportScope, setExportScope] = useState<ExportScope | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const clipboard = useRef<{ doc: Doc; pastes: number } | null>(null)
  // Touch screens get bigger handles; narrow ones (a folded phone) a compact layout.
  const coarse = useMedia('(pointer: coarse)')
  const compact = useMedia('(max-width: 600px)')
  const T = coarse ? 1.6 : 1
  /** The long-press menu: where it was opened, in screen and board coordinates. */
  const [sheet, setSheet] = useState<{ x: number; y: number; p: Pt; onEmpty: boolean } | null>(null)
  // Touch "select more" mode: taps add to the selection, like Ctrl-click.
  const [multi, setMultiState] = useState(false)
  const multiRef = useRef(false)
  const setMulti = useCallback((on: boolean) => {
    multiRef.current = on
    setMultiState(on)
  }, [])
  // Touch "select area" mode: the next drag on empty canvas draws a selection box instead of panning.
  const areaRef = useRef(false)
  const [barOpen, setBarOpen] = useState(false)

  const svgRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<SVGGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  const nodeMap = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes])
  // Connectors sharing an end share their trunk; routes read this while drawing.
  const trunkMap = useMemo(() => bundleTrunks(doc.edges, nodeMap), [doc.edges, nodeMap])
  setTrunks(trunkMap)
  const selSet = useMemo(() => new Set(selection), [selection])
  const selNodes = useMemo(() => doc.nodes.filter((n) => selSet.has(n.id)), [doc.nodes, selSet])
  const selEdges = useMemo(() => doc.edges.filter((e) => selSet.has(e.id)), [doc.edges, selSet])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600)
  }, [])

  // ---------- viewport ----------

  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }, [])

  /** Zoom immediately, keeping screen point (px, py) fixed. */
  const applyZoom = useCallback(
    (zoom: number, px: number, py: number) => {
      const v = viewRef.current
      const k = zoom / v.zoom
      setView({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
    },
    [setView],
  )

  // Smooth zoom: steps set a target and each frame eases toward it in log
  // space, so repeated wheel notches or key presses glide instead of jumping.
  const smooth = useRef<{ zoom: number; ax: number; ay: number; raf: number } | null>(null)
  const tween = useRef<number | null>(null)

  const stopViewAnimation = useCallback(() => {
    if (smooth.current) cancelAnimationFrame(smooth.current.raf)
    if (tween.current) cancelAnimationFrame(tween.current)
    smooth.current = null
    tween.current = null
  }, [])

  const zoomAt = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      if (tween.current) {
        cancelAnimationFrame(tween.current)
        tween.current = null
      }
      const r = svgRef.current!.getBoundingClientRect()
      const ax = sx ?? r.width / 2
      const ay = sy ?? r.height / 2
      const target = clampZoom((smooth.current?.zoom ?? viewRef.current.zoom) * factor)
      if (reducedMotion()) return applyZoom(target, ax, ay)
      const step = () => {
        const s = smooth.current
        if (!s) return
        const cur = viewRef.current.zoom
        const ratio = Math.log(s.zoom / cur)
        const done = Math.abs(ratio) < 0.003
        applyZoom(done ? s.zoom : cur * Math.exp(ratio * 0.28), s.ax, s.ay)
        if (done) smooth.current = null
        else s.raf = requestAnimationFrame(step)
      }
      if (smooth.current) Object.assign(smooth.current, { zoom: target, ax, ay })
      else smooth.current = { zoom: target, ax, ay, raf: requestAnimationFrame(step) }
    },
    [applyZoom],
  )

  /** Glide to a view (used by zoom to fit). */
  const animateTo = useCallback(
    (to: View) => {
      stopViewAnimation()
      const svg = svgRef.current
      if (!svg || reducedMotion()) return setView(to)
      const r = svg.getBoundingClientRect()
      const from = viewRef.current
      const cx = r.width / 2
      const cy = r.height / 2
      const c0 = { x: (cx - from.x) / from.zoom, y: (cy - from.y) / from.zoom }
      const c1 = { x: (cx - to.x) / to.zoom, y: (cy - to.y) / to.zoom }
      const t0 = performance.now()
      const ms = 320
      const frame = (now: number) => {
        const t = Math.min(1, (now - t0) / ms)
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        const zoom = from.zoom * Math.pow(to.zoom / from.zoom, e)
        const c = { x: c0.x + (c1.x - c0.x) * e, y: c0.y + (c1.y - c0.y) * e }
        setView(t === 1 ? to : { zoom, x: cx - c.x * zoom, y: cy - c.y * zoom })
        tween.current = t < 1 ? requestAnimationFrame(frame) : null
      }
      tween.current = requestAnimationFrame(frame)
    },
    [setView, stopViewAnimation],
  )

  const fitView = useCallback(
    (d: Doc = docRef.current, animate = true) => {
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      const b = docBounds(d)
      const go = animate ? animateTo : setView
      if (!b) return go({ x: r.width / 2, y: r.height / 2, zoom: 1 })
      const zoom = clampZoom(Math.min(r.width / (b.w + 160), (r.height - 120) / (b.h + 160), 1.5))
      go({ zoom, x: r.width / 2 - (b.x + b.w / 2) * zoom, y: r.height / 2 - (b.y + b.h / 2) * zoom })
    },
    [animateTo, docRef, setView],
  )

  /** Shapes glowing after a jump, cleared after a few seconds. */
  const [overLink, setOverLink] = useState(false)
  // Give crossing connectors their own colors (remembered in this browser).
  const [crossColors, setCrossColors] = useState(() => {
    if (embeddedFirstRun && typeof embeddedBoard?.extra?.settings?.crossColors === 'boolean') return embeddedBoard.extra.settings.crossColors
    try {
      return localStorage.getItem('flowboard.crossColors') !== 'off'
    } catch {
      return true
    }
  })
  const toggleCrossColors = useCallback(() => {
    setCrossColors((on) => {
      try {
        localStorage.setItem('flowboard.crossColors', on ? 'off' : 'on')
      } catch {
        /* not saved; still toggles */
      }
      return !on
    })
  }, [])
  const [halo, setHalo] = useState<{ ids: string[]; key: number } | null>(null)
  const haloTimer = useRef<number | undefined>(undefined)

  // ---------- search the board ----------
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(-1)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchListRef = useRef<HTMLDivElement>(null)
  const searchPanelRef = useRef<HTMLDivElement>(null)
  const searchIndex = useMemo(() => (searchOpen ? buildIndex(doc) : []), [doc, searchOpen])
  const shownQuery = query
  const hitGroups = useMemo(() => groupHits(searchIndex, search(searchIndex, shownQuery), doc), [searchIndex, shownQuery, doc])
  const flatHits = useMemo(() => hitGroups.flatMap((g) => g.hits), [hitGroups])
  // The list answers each keypress first; the marks on the board follow when there's time.
  const markHits = useDeferredValue(flatHits)
  const hitMarks = useMemo(() => (searchOpen ? markHits.map((h) => hitRects(h, doc)) : []), [markHits, doc, searchOpen])
  // A one-letter search can match most of the board: list the first rows, the rest on request.
  const LIST_ROWS = 50
  const [showAllHits, setShowAllHits] = useState(false)
  useEffect(() => {
    setHitIndex(-1)
    setShowAllHits(false)
  }, [shownQuery])
  useEffect(() => {
    if (hitIndex >= flatHits.length) setHitIndex(flatHits.length - 1)
  }, [flatHits.length, hitIndex])
  const openSearch = useCallback(() => {
    setSearchOpen(true)
    setPopover(null)
    requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setHitIndex(-1)
  }, [])

  /** Bring a match into view: its whole shape if that fits at a size you can
   *  read, else the matched words; the zoom stays put when it's already fine. */
  const goToHit = useCallback(
    (h: Hit) => {
      const svg = svgRef.current
      const f = hitFocus(h, docRef.current)
      if (!svg || !f) return
      const r = svg.getBoundingClientRect()
      // Keep clear of the search panel and the bars: beside the panel when
      // there's room, else above it (phones).
      const pr = searchPanelRef.current?.getBoundingClientRect()
      const area = { x: 16, y: 72, w: r.width - 32, h: r.height - 72 - 90 }
      if (pr && pr.width < r.width * 0.6) area.w = pr.left - r.left - 32
      else if (pr) area.h = pr.top - r.top - 72 - 12
      const readable = 15 / f.font
      const lowest = 10 / f.font
      const fits = (z: number, b = f.box) => b.w * z <= area.w - 40 && b.h * z <= area.h - 40
      const now = viewRef.current.zoom
      let zoom = now
      if (now < lowest || now > readable * 3 || !fits(now)) {
        const fit = Math.min((area.w - 40) / f.box.w, (area.h - 40) / f.box.h)
        zoom = Math.max(Math.min(readable, fit), lowest)
      }
      zoom = clampZoom(zoom)
      const target = fits(zoom) || !f.words.length ? f.box : uniteRects(f.words)
      const cx = area.x + area.w / 2
      const cy = area.y + area.h / 2
      animateTo({ zoom, x: cx - (target.x + target.w / 2) * zoom, y: cy - (target.y + target.h / 2) * zoom })
    },
    [animateTo, docRef],
  )
  const stepHit = useCallback(
    (by: number) => {
      if (!flatHits.length) return
      const i = hitIndex < 0 ? (by > 0 ? 0 : flatHits.length - 1) : (hitIndex + by + flatHits.length) % flatHits.length
      setHitIndex(i)
      goToHit(flatHits[i])
      requestAnimationFrame(() => searchListRef.current?.querySelector(`[data-hit="${i}"]`)?.scrollIntoView({ block: 'nearest' }))
    },
    [flatHits, goToHit, hitIndex],
  )

  /** Where the selected connectors lead: for each one, whichever end is
   *  farther from the middle of the screen (so pressing again jumps back).
   *  With a single shape selected, every shape it's connected to. */
  const jumpTargets = useCallback((): { rects: Rect[]; ids: string[] } => {
    const d = docRef.current
    const svg = svgRef.current
    const nm = new Map(d.nodes.map((n) => [n.id, n]))
    const sel = new Set(selectionRef.current)
    const v = viewRef.current
    const r = svg?.getBoundingClientRect()
    const mid = r ? { x: (r.width / 2 - v.x) / v.zoom, y: (r.height / 2 - v.y) / v.zoom } : { x: 0, y: 0 }
    const rects: Rect[] = []
    const ids: string[] = []
    const add = (nodeId: string | undefined, p: Pt) => {
      const n = nodeId ? nm.get(nodeId) : undefined
      if (n) {
        if (ids.includes(n.id)) return
        ids.push(n.id)
        rects.push({ x: n.x, y: n.y, w: n.w, h: n.h })
      } else rects.push({ x: p.x, y: p.y, w: 0, h: 0 })
    }
    const edges = d.edges.filter((e) => sel.has(e.id))
    if (edges.length) {
      for (const e of edges) {
        const g = edgeGeometry(e, nm)
        const far = dist(g.start, mid) > dist(g.end, mid) ? 'from' : 'to'
        add(e[far].nodeId, far === 'from' ? g.start : g.end)
      }
    } else if (sel.size === 1) {
      const id = [...sel][0]
      for (const e of d.edges) {
        const g = edgeGeometry(e, nm)
        if (e.from.nodeId === id && e.to.nodeId !== id) add(e.to.nodeId, g.end)
        else if (e.to.nodeId === id && e.from.nodeId !== id) add(e.from.nodeId, g.start)
      }
    }
    return { rects, ids }
  }, [docRef])

  /** Jump to the other end of the selected connector(s): pan at the current
   *  zoom for one place, or zoom out to fit several, and make them glow. */
  const jumpToOtherEnd = useCallback(() => {
    const svg = svgRef.current
    const { rects, ids } = jumpTargets()
    const b = unionRects(rects)
    if (!svg || !b) return
    const r = svg.getBoundingClientRect()
    const v = viewRef.current
    let zoom = v.zoom
    if (rects.length > 1) zoom = clampZoom(Math.min(v.zoom, r.width / (b.w + 160), (r.height - 120) / (b.h + 160)))
    animateTo({ zoom, x: r.width / 2 - (b.x + b.w / 2) * zoom, y: r.height / 2 - (b.y + b.h / 2) * zoom })
    window.clearTimeout(haloTimer.current)
    if (ids.length) {
      setHalo({ ids, key: Date.now() })
      haloTimer.current = window.setTimeout(() => setHalo(null), 5000)
    } else setHalo(null)
  }, [animateTo, jumpTargets])

  useLayoutEffect(() => {
    if (!saved || saved.fit) fitView(undefined, false)
    // Only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = containerRef.current!
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.chrome')) return
      e.preventDefault()
      const r = svgRef.current!.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY * (e.deltaMode === 1 ? 33 : 1)
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        if (e.deltaMode === 0 && Math.abs(delta) < 40) {
          // Trackpad pinch sends many small deltas; follow the fingers directly.
          stopViewAnimation()
          applyZoom(clampZoom(viewRef.current.zoom * Math.exp(-delta * 0.01)), sx, sy)
        } else {
          // A mouse wheel notch: one smooth step of about 25%.
          zoomAt(Math.exp(-Math.sign(delta) * Math.min(Math.abs(delta), 200) * 0.0022), sx, sy)
        }
      } else {
        const v = viewRef.current
        const k = e.deltaMode === 1 ? 20 : 1
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        setView({ ...v, x: v.x - dx * k, y: v.y - dy * k })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, applyZoom, stopViewAnimation, setView])

  // Folding or unfolding a phone (or resizing the window) keeps the middle of the view in the middle.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = { w: el.clientWidth, h: el.clientHeight }
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === last.w && h === last.h) return
      const v = viewRef.current
      setView({ ...v, x: v.x + (w - last.w) / 2, y: v.y + (h - last.h) / 2 })
      last = { w, h }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [setView])

  // ---------- autosave ----------

  const saveWarned = useRef(false)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const ok = save({ doc, view, title })
      if (!ok && !saveWarned.current) {
        saveWarned.current = true
        flash('This board is too big for the browser to autosave (large images use the most space). Use Export → HTML or Markdown to keep it.')
      }
      if (ok) saveWarned.current = false
    }, 400)
    return () => window.clearTimeout(t)
  }, [doc, view, title, flash])

  // ---------- hit testing ----------

  const hitNode = useCallback(
    (p: Pt, margin = 0, exclude?: string): NodeEl | undefined => {
      // Sections sit behind everything, so anything else under the point wins.
      const nodes = drawOrder(docRef.current.nodes)
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n.id === exclude) continue
        if (contains(n, p, n.kind === 'section' ? 0 : margin)) return n
        if (n.kind === 'section' && contains(sectionTitleRect(n), p)) return n
      }
      return undefined
    },
    [docRef],
  )

  const snapSide = (n: NodeEl, p: Pt): Side | undefined => {
    const th = 22 / viewRef.current.zoom
    return SIDES.find((s) => dist(anchor(n, s), p) < th)
  }

  /** The link point under the pointer, if any. */
  const linkAt = (n: NodeEl, p: Pt, margin: number): string | undefined => {
    for (const [textId, rects] of linkRects(n)) if (rects.some((r) => contains(r, p, margin))) return textId
  }

  /** Attach to a link point when the pointer is over one, otherwise to the shape. */
  const dropAt = (n: NodeEl, p: Pt): DropTarget => {
    const textId = linkAt(n, p, 8 / viewRef.current.zoom)
    if (textId) return { nodeId: n.id, textId }
    // The four middle anchors pull hardest; elsewhere on the outline the end
    // stays where it's dropped; deeper inside, the best side is picked.
    const side = snapSide(n, p)
    if (side) return { nodeId: n.id, side }
    const near = nearestOnOutline(n, p)
    if (near.d < 14 / viewRef.current.zoom) return { nodeId: n.id, side: near.side, at: Math.round(near.at * 1000) / 1000 }
    return { nodeId: n.id }
  }

  // ---------- editing ----------

  const startEditing = useCallback(
    (id: string) => {
      const d = docRef.current
      const n = d.nodes.find((x) => x.id === id)
      if (n) return n.kind === 'image' ? undefined : setEditing({ kind: 'node', id, text: n.text })
      const e = d.edges.find((x) => x.id === id)
      if (e) setEditing({ kind: 'edge', id, text: e.label })
    },
    [docRef, setEditing],
  )

  // The board as it was when editing began, so undo takes back the live resizing too.
  const editBefore = useRef<Doc | null>(null)
  useEffect(() => {
    editBefore.current = editing ? docRef.current : null
    // A shape whose size doesn't match its text was sized by hand (before this
    // was tracked): keep its size rather than snapping it to the text.
    const n = editing?.kind === 'node' ? docRef.current.nodes.find((x) => x.id === editing.id) : undefined
    if (n && n.fixedSize === undefined && n.text.trim() && n.kind !== 'text') {
      const a = autoSize(n, DEFAULT_SIZE[n.kind])
      if (Math.abs(a.w - n.w) > 2 && Math.abs(DEFAULT_SIZE[n.kind].w - n.w) > 2) {
        const marked = { ...n, fixedSize: true }
        live((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === n.id ? marked : x)) }))
        editBefore.current = docRef.current
      }
    }
    // Only when a different element starts editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id])

  /** Resize the shape being edited to fit what's typed so far. */
  const onEditInput = useCallback(() => {
    const ed = editingRef.current
    if (ed?.kind !== 'node' || !editorRef.current) return
    const paras = htmlToParagraphs(editorRef.current)
    live((d) => ({
      ...d,
      nodes: d.nodes.map((x) => (x.id === ed.id && x.kind !== 'section' ? autoSize(withParagraphs(x, paras), DEFAULT_SIZE[x.kind]) : x)),
    }))
  }, [live, editingRef])

  /** Links inserted from the "/" list during this edit; they get connected to their namesakes. */
  const pickedLinks = useRef(new Set<string>())

  const finishEditing = useCallback(() => {
    const ed = editingRef.current
    if (!ed) return
    // Read the formatted text before the editor unmounts.
    const paras = ed.kind === 'node' && editorRef.current ? htmlToParagraphs(editorRef.current) : null
    setEditing(null)
    const picked = pickedLinks.current
    pickedLinks.current = new Set()
    const before = editBefore.current ?? docRef.current
    editBefore.current = null
    const update = (fn: (d: Doc) => Doc) => {
      live(fn)
      record(before)
    }
    update((d) => {
      if (ed.kind === 'node') {
        const n = d.nodes.find((x) => x.id === ed.id)
        if (n?.kind === 'section') {
          const name = ed.text.trim() || n.text || 'Section'
          return name === n.text ? d : { ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, text: name } : x)) }
        }
        if (!n || !paras) return d
        const next = autoSize(withParagraphs(n, paras), DEFAULT_SIZE[n.kind])
        if (n.kind === 'text' && !next.text.trim()) return deleteIds(d, new Set([n.id]))
        const joins = joinLinks(d, next, picked)
        if (!joins.length && JSON.stringify(paragraphsOf(n)) === JSON.stringify(paragraphsOf(next)) && n.h === next.h && n.w === next.w) return d
        return { nodes: d.nodes.map((x) => (x.id === n.id ? next : x)), edges: [...d.edges, ...joins] }
      }
      const e = d.edges.find((x) => x.id === ed.id)
      if (!e || e.label === ed.text.trim()) return d
      return { ...d, edges: d.edges.map((x) => (x.id === e.id ? { ...x, label: ed.text.trim() } : x)) }
    })
  }, [live, record, setEditing, docRef])

  // ---------- document actions ----------

  const updateSelected = useCallback(
    (nodeFn: ((n: NodeEl) => NodeEl) | null, edgeFn: ((e: EdgeEl) => EdgeEl) | null) => {
      const ids = new Set(selectionRef.current)
      commit((d) => ({
        nodes: nodeFn ? d.nodes.map((n) => (ids.has(n.id) ? nodeFn(n) : n)) : d.nodes,
        edges: edgeFn ? d.edges.map((e) => (ids.has(e.id) ? edgeFn(e) : e)) : d.edges,
      }))
    },
    [commit],
  )

  const deleteSelection = useCallback(() => {
    const ids = new Set(selectionRef.current)
    if (!ids.size) return
    commit((d) => deleteIds(d, ids))
    setSelection([])
  }, [commit, setSelection])

  const copySelection = useCallback(() => {
    const part = extract(docRef.current, withSectionContents(docRef.current, new Set(selectionRef.current)))
    if (!part.nodes.length && !part.edges.length) return false
    clipboard.current = { doc: part, pastes: 0 }
    return true
  }, [docRef])

  const paste = useCallback(() => {
    const clip = clipboard.current
    if (!clip) return
    clip.pastes += 1
    const off = 24 * clip.pastes
    const part = cloneDoc(clip.doc, off, off)
    commit((d) => ({ nodes: [...d.nodes, ...part.nodes], edges: [...d.edges, ...part.edges] }))
    setSelection([...part.nodes.map((n) => n.id), ...part.edges.map((e) => e.id)])
  }, [commit, setSelection])

  const reorder = useCallback(
    (toFront: boolean) => {
      const ids = new Set(selectionRef.current)
      commit((d) => {
        const picked = d.nodes.filter((n) => ids.has(n.id))
        if (!picked.length) return d
        const rest = d.nodes.filter((n) => !ids.has(n.id))
        return { ...d, nodes: toFront ? [...rest, ...picked] : [...picked, ...rest] }
      })
    },
    [commit],
  )

  const quickAdd = useCallback(
    (src: NodeEl, side: Side) => {
      const plain = src.kind === 'text' || src.kind === 'image'
      const kind: ShapeKind = plain ? 'rect' : src.kind
      const w = plain ? DEFAULT_SIZE.rect.w : src.w
      const h = plain ? DEFAULT_SIZE.rect.h : src.h
      const gap = 80
      const c = center(src)
      let x = side === 'right' ? src.x + src.w + gap : side === 'left' ? src.x - gap - w : c.x - w / 2
      let y = side === 'bottom' ? src.y + src.h + gap : side === 'top' ? src.y - gap - h : c.y - h / 2
      const nodes = docRef.current.nodes
      for (let i = 0; i < 8; i++) {
        const r = { x: x - 10, y: y - 10, w: w + 20, h: h + 20 }
        if (!nodes.some((o) => intersects(r, o))) break
        if (side === 'left' || side === 'right') y += h + 40
        else x += w + 40
      }
      const node = makeNode(kind, x, y, w, h, { color: src.color, fontSize: src.fontSize })
      const edge = makeEdge(
        { nodeId: src.id, side, x: 0, y: 0 },
        { nodeId: node.id, side: OPPOSITE[side], x: 0, y: 0 },
      )
      commit((d) => ({ nodes: [...d.nodes, node], edges: [...d.edges, edge] }))
      setSelection([node.id])
      setEditing({ kind: 'node', id: node.id, text: '' })
    },
    [commit, docRef, setEditing, setSelection],
  )

  /** Put a new shape on a connector's loose end and attach the end to it. */
  const shapeAtEnd = useCallback(
    (edgeId: string, kind: ShapeKind) => {
      const d = docRef.current
      const edge = d.edges.find((x) => x.id === edgeId)
      if (!edge) return
      const end: 'from' | 'to' = !edge.to.nodeId ? 'to' : 'from'
      if (edge[end].nodeId) return
      const nm = new Map(d.nodes.map((n) => [n.id, n]))
      const pts = routePoints(edge, nm)
      const [p, prev] = end === 'to' ? [pts[pts.length - 1], pts[pts.length - 2]] : [pts[0], pts[1]]
      // The shape sits beyond the end, facing the way the line arrives.
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      const side: Side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : dy > 0 ? 'top' : 'bottom'
      const { w, h } = DEFAULT_SIZE[kind]
      const x = side === 'left' ? p.x : side === 'right' ? p.x - w : p.x - w / 2
      const y = side === 'top' ? p.y : side === 'bottom' ? p.y - h : p.y - h / 2
      const node = makeNode(kind, x, y, w, h)
      commit((doc) => ({
        nodes: [...doc.nodes, node],
        edges: doc.edges.map((x) => (x.id === edgeId ? { ...x, points: undefined, [end]: { nodeId: node.id, side, x: 0, y: 0 } } : x)),
      }))
      setPopover(null)
      setSelection([node.id])
      setEditing({ kind: 'node', id: node.id, text: '' })
    },
    [commit, docRef, setEditing, setSelection],
  )

  // Workspace folder state (see the workspace section below).
  const [wsDir, setWsDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [wsAccess, setWsAccess] = useState(false)
  const [wsFiles, setWsFiles] = useState<WorkspaceFile[] | null>(null)
  /** The workspace file the board was opened from or last saved to. */
  const [currentFile, setCurrentFile] = useState<{ handle: FileSystemFileHandle; path: string } | null>(null)

  // Track points: snapshots of the board the user marks with "Start track".
  // The latest one is the ghost copy that Diff compares against.
  const [trackKey, setTrackKey] = useState(currentTrackKey)
  const [points, setPoints] = useState<TrackPoint[]>([])
  const firstLabel = useRef('Started tracking')
  useEffect(() => {
    let live = true
    void loadTrack(trackKey).then((loaded) => {
      if (!live) return
      if (loaded.length) return setPoints(loaded)
      // An exported board brings its timeline with it.
      const carried = embeddedBoard?.extra?.tracks
      if (embeddedFirstRun && carried?.length) {
        setPoints(carried)
        void saveTrack(trackKey, carried)
        return
      }
      // A history starts with the board as it is when first opened.
      const first = [{ id: Math.random().toString(36).slice(2, 10), at: Date.now(), label: firstLabel.current, doc: docRef.current }]
      setPoints(first)
      void saveTrack(trackKey, first)
    })
    return () => {
      live = false
    }
  }, [trackKey, docRef])
  /** Start (or rejoin) the history of a file the board now shows. */
  const switchTrack = useCallback((key: string, label: string) => {
    firstLabel.current = label
    rememberTrackKey(key)
    setTrackKey(key)
  }, [])
  const startTrack = useCallback(() => {
    const n = points.length
    const p: TrackPoint = { id: Math.random().toString(36).slice(2, 10), at: Date.now(), label: `Track ${n}`, doc: docRef.current }
    const next = [...points, p]
    setPoints(next)
    void saveTrack(trackKey, next).then((ok) => flash(ok ? `Track ${n} saved. Diff now shows changes from here.` : 'Your browser wouldn\'t store the track point.'))
  }, [points, trackKey, docRef, flash])
  const deletePoint = useCallback(
    (id: string) => {
      const next = points.filter((p) => p.id !== id)
      setPoints(next)
      void saveTrack(trackKey, next)
    },
    [points, trackKey],
  )
  const renamePoint = useCallback(
    (id: string, label: string) => {
      const next = points.map((p) => (p.id === id ? { ...p, label } : p))
      setPoints(next)
      void saveTrack(trackKey, next)
    },
    [points, trackKey],
  )
  const reference = points[points.length - 1] ?? null
  const refName = reference ? `${reference.label} (${new Date(reference.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})` : 'tracking started'
  // Flow view: dots running along every connector the way its arrow points.
  const [showFlow, setShowFlow] = useState(() => {
    if (embeddedFirstRun && typeof embeddedBoard?.extra?.settings?.flow === 'boolean') return embeddedBoard.extra.settings.flow
    try {
      return localStorage.getItem('flowboard.flow') === 'on'
    } catch {
      return false
    }
  })
  const toggleFlow = useCallback(() => {
    setShowFlow((on) => {
      try {
        localStorage.setItem('flowboard.flow', on ? 'off' : 'on')
      } catch {
        /* not remembered */
      }
      return !on
    })
  }, [])

  // Diff view: highlight what's new or edited since the latest track point.
  const [showDiff, setShowDiff] = useState(() => (embeddedFirstRun && embeddedBoard?.extra?.settings?.diff) || false)
  const diffView = useMemo(() => {
    if (!showDiff || !reference) return null
    const { changed, removed } = diffDocs(reference.doc, doc)
    return { changed, all: withAffected(doc, changed), removed: removed.nodes.length + removed.edges.length }
  }, [showDiff, doc, reference])
  // A new connector brings the existing shapes it joins, for context.
  const diffIds = useCallback(
    () => (reference ? withAffected(docRef.current, diffDocs(reference.doc, docRef.current).changed) : new Set<string>()),
    [docRef, reference],
  )

  const newBoard = useCallback(() => {
    commit(() => ({ nodes: [], edges: [] }))
    switchTrack(`new-${Date.now()}`, 'Created')
    setCurrentFile(null)
    setSelection([])
    setTitle('Untitled flowchart')
    setPopover(null)
    flash(`Started a new board. Press ${MOD}+Z to bring the old one back.`)
  }, [commit, flash, setSelection, switchTrack])

  /** Kept with the board beyond its shapes: the timeline, view and toggles. */
  const boardExtras = useCallback(
    (): BoardExtras => ({ view: viewRef.current, tracks: points, settings: { flow: showFlow, crossColors, diff: showDiff } }),
    [viewRef, points, showFlow, crossColors, showDiff],
  )
  const boardJson = useCallback(
    () => JSON.stringify({ app: 'flowboard', version: 1, title, doc: docRef.current, ...boardExtras() }, null, 2),
    [title, docRef, boardExtras],
  )

  const openFile = useCallback(
    async (file: File, source?: { handle: FileSystemFileHandle; path: string }) => {
      try {
        const text = await file.text()
        let d: Doc
        let fileTitle: string | undefined
        let warning = ''
        let extra: BoardExtras = {}
        if (/\.html?$/i.test(file.name)) {
          const e = boardFromHtml(text)
          if (!e) throw new Error('not a board')
          d = e.doc
          fileTitle = e.title
          extra = e.extra ?? {}
        } else if (/\.(md|markdown)$/i.test(file.name)) {
          const split = readHistory(text)
          const parsed = parseMarkdown(split.md)
          if (!parsed) throw new Error('not a board')
          extra = split.extra
          d = parsed.doc
          fileTitle = parsed.title
          warning = parsed.warnings.length
            ? ` (${parsed.warnings.length} line${parsed.warnings.length === 1 ? '' : 's'} skipped: ${parsed.warnings[0]}${parsed.warnings.length > 1 ? ', …' : ''})`
            : ''
        } else {
          const data = JSON.parse(text)
          const raw = isDoc(data) ? data : isDoc(data?.doc) ? data.doc : null
          if (!raw) throw new Error('not a board')
          d = normalizeDoc(raw)
          if (typeof data.title === 'string') fileTitle = data.title
          if (data && typeof data === 'object') extra = data
        }
        reset(d)
        const key = source?.path ?? file.name
        // A file that carries its own timeline: it replaces the one kept in the browser.
        if (Array.isArray(extra.tracks) && extra.tracks.length) {
          await saveTrack(key, extra.tracks)
          if (key === trackKey) setPoints(extra.tracks)
        }
        switchTrack(key, `Opened ${key}`)
        const st = extra.settings
        if (st) {
          if (typeof st.flow === 'boolean' && st.flow !== showFlow) toggleFlow()
          if (typeof st.crossColors === 'boolean' && st.crossColors !== crossColors) toggleCrossColors()
          if (typeof st.diff === 'boolean') setShowDiff(st.diff)
        }
        setSelection([])
        setTitle(fileTitle ?? file.name.replace(/\.(json|md|markdown|html?)$/i, ''))
        setCurrentFile(source ?? null)
        const v = extra.view
        if (v && [v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) && v.zoom > 0) setView(v)
        else requestAnimationFrame(() => fitView(d))
        flash(`Opened ${source?.path ?? file.name}${warning}`)
      } catch {
        flash(`${file.name} isn't a Flowboard file. Choose a .md or .html file saved from Flowboard (the Flowboard app itself has no board in it).`)
      }
    },
    [fitView, flash, reset, setSelection, switchTrack, trackKey, showFlow, toggleFlow, crossColors, toggleCrossColors],
  )

  // A diff picked in the Timeline: the newer version of the board, drawn off screen
  // so it can be exported even when it isn't what's on the canvas now.
  const [diffSource, setDiffSource] = useState<{ doc: Doc; ids: Set<string>; label: string } | null>(null)
  const sourceRef = useRef<SVGGElement>(null)
  const exportDiff = useCallback((older: Doc, newer: Doc, label: string) => {
    const ids = withAffected(newer, diffDocs(older, newer).changed)
    if (!ids.size) return flash(`Nothing is new or edited in ${label}.`)
    setDiffSource({ doc: newer, ids, label })
    setPopover(null)
    setExportScope('diff')
  }, [flash])
  const sourceDoc = (scope: ExportScope) => (scope === 'diff' && diffSource ? diffSource.doc : docRef.current)

  /** What an export covers: everything (null), the selection, or the Timeline's diff. */
  const scopeIds = useCallback(
    (scope: ExportScope): Set<string> | null => (scope === 'board' ? null : scope === 'diff' ? (diffSource?.ids ?? diffIds()) : new Set(selectionRef.current)),
    [diffIds, diffSource],
  )

  // The whole board's .md also carries the timeline, view and toggles; a part of it doesn't.
  const boardMd = useCallback(() => {
    const md = buildMarkdown(docRef.current, title, null)
    return md && md + historyBlock(boardExtras(), md)
  }, [docRef, title, boardExtras])
  const buildMd = useCallback(
    (scope: ExportScope) => (scope === 'board' ? boardMd() : buildMarkdown(sourceDoc(scope), title, scopeIds(scope))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardMd, docRef, title, scopeIds, diffSource],
  )

  const buildHtml = useCallback(
    (scope: ExportScope) => {
      const d = sourceDoc(scope)
      const sel = scopeIds(scope)
      if (!sel) return d.nodes.length || d.edges.length ? htmlWithBoard(d, title, boardExtras()) : null
      const part = extract(d, withSectionContents(d, sel))
      return part.nodes.length || part.edges.length ? htmlWithBoard(part, title) : null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docRef, title, scopeIds, boardExtras, diffSource],
  )

  const buildExport = useCallback(
    (scope: ExportScope, background: string | null) =>
      scope === 'diff' && diffSource
        ? sourceRef.current && buildSvg(sourceRef.current, diffSource.doc, diffSource.ids, background)
        : contentRef.current
          ? buildSvg(contentRef.current, docRef.current, scopeIds(scope), background)
          : null,
    [docRef, scopeIds, diffSource],
  )

  const openExport = useCallback((scope: ExportScope) => {
    setPopover(null)
    setExportScope(scope)
  }, [])

  /** The Markdown format guide, so it never has to be kept as a separate file. */
  const downloadGuide = useCallback(() => {
    setPopover(null)
    download(new Blob([MARKDOWN_GUIDE], { type: 'text/markdown' }), 'FLOWBOARD-MARKDOWN.md').catch((err: { code?: string }) => {
      if (err?.code !== 'declined') flash('This view blocked the download.')
    })
  }, [flash])

  // ---------- workspace folder ----------

  const [wsRecent, setWsRecent] = useState<{ dir: FileSystemDirectoryHandle; current: boolean }[]>([])
  const refreshRecent = useCallback(async (cur: FileSystemDirectoryHandle | null) => {
    const all = await recentWorkspaces()
    const rows = await Promise.all(all.map(async (dir) => ({ dir, current: !!cur && (await dir.isSameEntry(cur)) })))
    // A folder chosen before the list existed still belongs on it.
    if (cur && !rows.some((r) => r.current)) rows.unshift({ dir: cur, current: true })
    setWsRecent(rows)
  }, [])
  useEffect(() => {
    if (workspaceSupported()) void refreshRecent(wsDir)
  }, [refreshRecent, wsDir])

  const switchWorkspace = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      const ok = await requestAccess(dir).catch(() => false)
      if (!ok) return flash(`Flowboard wasn't allowed to use ${dir.name}.`)
      await makeCurrentWorkspace(dir)
      setWsDir(dir)
      setWsAccess(true)
      setCurrentFile(null)
      refreshFiles(dir)
      flash(`Workspace set to ${dir.name}`)
    },
    // refreshFiles is declared just below; it never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flash],
  )

  const refreshFiles = useCallback(async (dir: FileSystemDirectoryHandle) => {
    setWsFiles(null)
    try {
      setWsFiles(await listBoards(dir))
    } catch {
      setWsFiles([])
    }
  }, [])

  useEffect(() => {
    if (!workspaceSupported()) return
    savedWorkspace().then(async (dir) => {
      if (!dir) return
      setWsDir(dir)
      if (await hasAccess(dir)) {
        setWsAccess(true)
        refreshFiles(dir)
      }
    })
  }, [refreshFiles])

  const chooseWorkspace = useCallback(async () => {
    let dir: FileSystemDirectoryHandle | null
    try {
      dir = await pickWorkspace()
    } catch {
      return flash('This page isn’t allowed to use folders. Open flowboard.html from your computer in Chrome or Edge.')
    }
    if (!dir) return
    setWsDir(dir)
    setWsAccess(true)
    setCurrentFile(null)
    refreshFiles(dir)
    flash(`Workspace set to ${dir.name}`)
  }, [flash, refreshFiles])

  const allowWorkspace = useCallback(async () => {
    if (!wsDir) return false
    flash(`Asking your browser to let Flowboard use ${wsDir.name}. Look for the prompt near the address bar.`)
    const ok = await requestAccess(wsDir).catch(() => false)
    if (!ok) flash(`Flowboard wasn't allowed to use ${wsDir.name}.`)
    setWsAccess(ok)
    if (ok) refreshFiles(wsDir)
    return ok
  }, [refreshFiles, wsDir])

  const boardText = useCallback(
    (path: string) =>
      /\.json$/i.test(path)
        ? boardJson()
        : /\.html?$/i.test(path)
          ? htmlWithBoard(docRef.current, title, boardExtras())
          : (boardMd() ?? `---\ntitle: ${title}\n---\n`),
    [docRef, title, boardJson, boardExtras, boardMd],
  )

  const saveTo = useCallback(
    async (target: { handle: FileSystemFileHandle; path: string }) => {
      try {
        await writeFile(target.handle, boardText(target.path))
        setCurrentFile(target)
        save({ doc: docRef.current, view: viewRef.current, title })
        flash(`Saved to ${wsDir?.name ?? ''}/${target.path}`)
        if (wsDir) refreshFiles(wsDir)
      } catch {
        flash(`Couldn't save ${target.path}. Check the folder still exists and Flowboard may use it.`)
      }
    },
    [boardText, docRef, flash, refreshFiles, title, wsDir],
  )

  const saveAs = useCallback(async () => {
    if (!wsDir) return setPopover('workspace')
    if (!wsAccess && !(await allowWorkspace())) return
    const typed = window.prompt('Save as (in your workspace folder):', currentFile?.path.split('/').pop() ?? `${safeName(title)}.md`)
    if (!typed?.trim()) return
    const name = /\.(md|markdown|json)$/i.test(typed.trim()) ? typed.trim() : `${typed.trim()}.md`
    if (/[\\/]/.test(name)) return flash('Use a plain file name; it is saved in the workspace folder.')
    if (name !== currentFile?.path && (await exists(wsDir, name)) && !window.confirm(`${name} already exists. Replace it?`)) return
    await saveTo({ handle: await fileIn(wsDir, name), path: name })
  }, [allowWorkspace, currentFile, flash, saveTo, title, wsAccess, wsDir])

  /** Ctrl+S with a workspace: back to the open file, or a new one named after the board. */
  const saveWorkspace = useCallback(async () => {
    if (!wsDir) return false
    if (!wsAccess && !(await allowWorkspace())) return true
    if (currentFile) await saveTo(currentFile)
    else {
      const name = `${safeName(title)}.md`
      if ((await exists(wsDir, name)) && !window.confirm(`${name} already exists in your workspace. Replace it?`)) return true
      await saveTo({ handle: await fileIn(wsDir, name), path: name })
    }
    return true
  }, [allowWorkspace, currentFile, saveTo, title, wsAccess, wsDir])

  /** Put an exported file in the workspace folder; false when there isn't one to use. */
  const exportToWorkspace = useCallback(
    async (blob: Blob, name: string) => {
      if (!wsDir) return false
      if (!wsAccess && !(await allowWorkspace())) return false
      try {
        if ((await exists(wsDir, name)) && !window.confirm(`${name} already exists in ${wsDir.name}. Replace it?`)) return true
        await writeFile(await fileIn(wsDir, name), blob)
        flash(`Saved to ${wsDir.name}/${name}`)
        refreshFiles(wsDir)
      } catch {
        flash(`Couldn't save ${name} to ${wsDir.name}.`)
      }
      return true
    },
    [allowWorkspace, flash, refreshFiles, wsAccess, wsDir],
  )

  const openFromWorkspace = useCallback(
    async (f: WorkspaceFile) => {
      setPopover(null)
      try {
        await openFile(await f.handle.getFile(), { handle: f.handle, path: f.path })
      } catch {
        flash(`Couldn't open ${f.path}.`)
      }
    },
    [flash, openFile],
  )

  /** Copy the selection (or the whole board) to the clipboard as a 2x PNG. */
  const copyAsPng = useCallback(async () => {
    setPopover(null)
    const scope: ExportScope = selectionRef.current.length ? 'selection' : 'board'
    const built = buildExport(scope, '#ffffff')
    if (!built) return flash('The board is empty. Add a shape before copying.')
    try {
      await copyBlob(await rasterize(built, 'png', detailScale(built.w, built.h), '#ffffff'))
      flash(scope === 'selection' ? 'Copied selection as PNG' : 'Copied board as PNG')
    } catch {
      flash('Your browser blocked the clipboard. Use Export instead.')
    }
  }, [buildExport, flash])

  // ---------- images and the system clipboard ----------

  const lastPointer = useRef<Pt | null>(null)

  /** Where pasted things go: under the pointer if it's on screen, else the middle of the view. */
  const dropPoint = useCallback((): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const v = viewRef.current
    const p = lastPointer.current
    const sx = p ? p.x * v.zoom + v.x : -1
    const sy = p ? p.y * v.zoom + v.y : -1
    if (p && sx >= 0 && sy >= 0 && sx <= r.width && sy <= r.height) return p
    return { x: (r.width / 2 - v.x) / v.zoom, y: (r.height / 2 - v.y) / v.zoom }
  }, [])

  const addImages = useCallback(
    async (files: File[], at?: Pt) => {
      const images = files.filter(isImageFile)
      if (!images.length) return flash('Only image files can be added (PNG, JPG, GIF, WebP or SVG).')
      const origin = at ?? dropPoint()
      const r = svgRef.current!.getBoundingClientRect()
      const limit = Math.min(800, (Math.min(r.width, r.height) * 0.6) / viewRef.current.zoom)
      const nodes: NodeEl[] = []
      for (const [i, f] of images.entries()) {
        try {
          const img = await loadImage(f)
          const k = Math.min(1, limit / Math.max(img.width, img.height))
          const w = Math.max(20, img.width * k)
          const h = Math.max(20, img.height * k)
          nodes.push(makeNode('image', origin.x - w / 2 + i * 24, origin.y - h / 2 + i * 24, w, h, { src: img.src }))
        } catch {
          flash(`${f.name || 'That image'} couldn't be read.`)
        }
      }
      if (!nodes.length) return
      commit((d) => ({ ...d, nodes: [...d.nodes, ...nodes] }))
      setSelection(nodes.map((n) => n.id))
      setTool('select')
    },
    [commit, dropPoint, flash, setSelection],
  )

  useEffect(() => {
    const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (inField(e.target) || editingRef.current || !selectionRef.current.length) return
      const part = extract(docRef.current, withSectionContents(docRef.current, new Set(selectionRef.current)))
      if (!part.nodes.length && !part.edges.length) return
      e.preventDefault()
      clipboard.current = { doc: part, pastes: 0 }
      const json = encodeURIComponent(JSON.stringify(part))
      e.clipboardData?.setData('text/html', `<span data-flowboard="${json}"></span>`)
      e.clipboardData?.setData('text/plain', part.nodes.map((n) => n.text).filter(Boolean).join('\n'))
      if (cut) deleteSelection()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target) || editingRef.current) return
      const data = e.clipboardData
      if (!data) return paste()
      const files = [...data.files].filter(isImageFile)
      if (files.length) {
        e.preventDefault()
        return void addImages(files)
      }
      const marker = /data-flowboard="([^"]+)"/.exec(data.getData('text/html'))
      if (marker) {
        e.preventDefault()
        try {
          const part = JSON.parse(decodeURIComponent(marker[1]))
          if (isDoc(part)) {
            const same = clipboard.current && JSON.stringify(clipboard.current.doc) === JSON.stringify(part)
            if (!same) clipboard.current = { doc: normalizeDoc(part), pastes: 0 }
          }
        } catch {
          /* fall through to the in-app clipboard */
        }
        return paste()
      }
      const text = data.getData('text/plain').trim()
      if (text) {
        e.preventDefault()
        const at = dropPoint()
        const node = fitToText(makeNode('text', at.x - 150, at.y - 15, 300, 30, { text }))
        commit((d) => ({ ...d, nodes: [...d.nodes, node] }))
        setSelection([node.id])
        return
      }
      paste()
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', onPaste)
    }
  }, [addImages, commit, deleteSelection, docRef, dropPoint, paste, setSelection])

  const [dropping, setDropping] = useState(false)
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: React.DragEvent) => {
    setDropping(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    e.preventDefault()
    const json = files.find((f) => /\.(json|md|markdown)$/i.test(f.name) || f.type === 'application/json')
    if (json && !files.some(isImageFile)) return void openFile(json)
    void addImages(files, toWorld(e.clientX, e.clientY))
  }

  /** FigJam's "Wrap in new section": a section around the selection. */
  const wrapInSection = useCallback(() => {
    const d = docRef.current
    const ids = withSectionContents(d, new Set(selectionRef.current))
    const map = new Map(d.nodes.map((n) => [n.id, n]))
    const rects: Rect[] = d.nodes.filter((n) => ids.has(n.id))
    for (const n of d.nodes) if (ids.has(n.id) && n.kind === 'section') rects.push(sectionTitleRect(n))
    for (const e of d.edges) if (ids.has(e.id)) rects.push(edgeGeometry(e, map).bounds)
    const box = unionRects(rects)
    if (!box) return flash('Select some shapes first, then wrap them in a section.')
    const pad = 40
    const section = makeNode('section', box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2, { text: nextSectionName(d) })
    // New sections go to the back so existing ones (and everything else) stay visible.
    commit((doc) => ({ ...doc, nodes: [section, ...doc.nodes] }))
    setSelection([section.id])
    setEditing({ kind: 'node', id: section.id, text: section.text })
  }, [commit, docRef, flash, setEditing, setSelection])

  // ---------- keyboard ----------

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {})
  onKey.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !target.isContentEditable) {
      e.preventDefault()
      return openSearch()
    }
    if (target.closest('input, textarea, select')) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (e.key === ' ') {
      e.preventDefault()
      spaceRef.current = true
      setSpaceDown(true)
      return
    }
    if (mod) {
      if (e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        return wrapInSection()
      }
      if (e.shiftKey && k === 'e') {
        e.preventDefault()
        return openExport(selectionRef.current.length ? 'selection' : 'board')
      }
      if (e.shiftKey && k === 'c') {
        e.preventDefault()
        return void copyAsPng()
      }
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (k === 'y') {
        e.preventDefault()
        redo()
      } else if (k === 'a') {
        e.preventDefault()
        setSelection([...docRef.current.nodes.map((n) => n.id), ...docRef.current.edges.map((x) => x.id)])
      } else if (k === 'd') {
        e.preventDefault()
        if (copySelection()) {
          clipboard.current!.pastes = 0
          paste()
        }
      } else if (k === '=' || k === '+') {
        e.preventDefault()
        zoomAt(1.25)
      } else if (k === '-') {
        e.preventDefault()
        zoomAt(0.8)
      } else if (k === '0') {
        e.preventDefault()
        zoomAt(1 / viewRef.current.zoom)
      } else if (k === 's') {
        e.preventDefault()
        if (e.shiftKey) return void saveAs()
        if (wsDir) return void saveWorkspace()
        save({ doc: docRef.current, view: viewRef.current, title })
        flash('Saved in this browser. Set a workspace folder (Menu → Workspace) to save files there.')
      }
      return
    }
    if (e.shiftKey && (e.code === 'Digit1' || k === '!')) return fitView()
    if (e.shiftKey && (e.code === 'Digit0' || k === ')')) return zoomAt(1 / viewRef.current.zoom)
    if (e.key === 'Delete' || e.key === 'Backspace') return deleteSelection()
    if (e.key === 'Escape') {
      setSelection([])
      setTool('select')
      setPopover(null)
      setShapeTray(false)
      return
    }
    if (e.key === 'Enter' && selectionRef.current.length === 1) {
      e.preventDefault()
      return startEditing(selectionRef.current[0])
    }
    if (e.key.startsWith('Arrow') && selectionRef.current.length) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      return commit((d) => translate(d, new Set(selectionRef.current), dx, dy))
    }
    if (e.key === ']') return reorder(true)
    if (e.key === '[') return reorder(false)
    if (e.key === 'I' && e.shiftKey) return imageInputRef.current?.click()
    if (e.key === 'S' && e.shiftKey) return setTool('section')
    if (e.key === 'P' && e.shiftKey) return togglePhysics()
    if (e.key === 'T' && e.shiftKey) return tidy()
    if (e.key === 'J' && e.shiftKey) return jumpToOtherEnd()
    if (e.key === 'D' && e.shiftKey) return setShowDiff((v) => !v)
    if (e.key === 'F' && e.shiftKey) return toggleFlow()
    if (e.key === '?') return setPopover((p) => (p === 'help' ? null : 'help'))
    const tools: Record<string, Tool> = {
      v: 'select',
      h: 'hand',
      r: 'rect',
      o: 'ellipse',
      d: 'diamond',
      s: 'sticky',
      t: 'text',
      x: 'connector',
      l: 'connector',
    }
    if (tools[k]) {
      const t = tools[k]
      setTool(t)
      if (FLOW_SHAPES.includes(t as ShapeKind)) setLastShape(t as ShapeKind)
    }
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKey.current(e)
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        spaceRef.current = false
        setSpaceDown(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ---------- pointer ----------

  // ---------- physics ----------

  const physicsBefore = useRef<Doc | null>(null)
  const togglePhysics = useCallback(() => {
    const on = !physicsRef.current
    physicsRef.current = on
    setPhysics(on)
    if (on) {
      simRef.current = newSim()
      physicsBefore.current = docRef.current
    } else if (physicsBefore.current) {
      // The whole physics session becomes one undo step.
      record(physicsBefore.current)
      physicsBefore.current = null
    }
  }, [docRef, record])

  useEffect(() => {
    if (!physics) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const d = dragRef.current
      const pinned = new Set<string>()
      if (d?.kind === 'move') for (const id of d.ids) pinned.add(id)
      if (d?.kind === 'resize') pinned.add(d.id)
      const ed = editingRef.current
      if (ed?.kind === 'node') pinned.add(ed.id)
      const moved = physicsStep(docRef.current, simRef.current, pinned)
      if (moved) {
        live((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (moved.has(n.id) ? { ...n, ...moved.get(n.id)! } : n)) }))
      } else if (!d && physicsBefore.current && physicsBefore.current !== docRef.current) {
        record(physicsBefore.current)
        physicsBefore.current = docRef.current
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [physics, docRef, live, record])

  // Adding or removing shapes or connectors stirs the layout again.
  useEffect(() => {
    if (physicsRef.current) reheat(simRef.current, 0.7)
  }, [doc.nodes.length, doc.edges.length])

  const tidy = useCallback(() => {
    if (physicsRef.current) togglePhysics()
    const next = tidyUp(docRef.current)
    commit(() => next)
    requestAnimationFrame(() => fitView(next))
  }, [commit, docRef, fitView, togglePhysics])

  const beginDrag = (d: Drag) => {
    dragRef.current = d
    setDrag(d)
  }

  // ---------- touch ----------
  // Fingers on the canvas (screen coordinates). Two fingers pinch to zoom and
  // drag to pan; after a pinch the last finger does nothing until it lifts.
  const touches = useRef(new Map<number, Pt>())
  const pinch = useRef<{ dist: number; mid: Pt; view: View } | null>(null)
  const touchIdle = useRef(false)
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const lastTouch = useRef(0)

  const cancelLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current.timer)
    longPress.current = null
  }
  /** Drop whatever a finger started, putting the board back as it was. */
  const abortDrag = () => {
    const d = dragRef.current
    if (d && 'before' in d && d.before !== docRef.current) live(() => d.before)
    dragRef.current = null
    setDrag(null)
  }
  const pinchState = () => {
    const [a, b] = [...touches.current.values()]
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }
  const openSheet = (x: number, y: number, onEmpty: boolean) => {
    abortDrag()
    navigator.vibrate?.(12)
    setSheet({ x, y, p: toWorld(x, y), onEmpty })
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const touch = e.pointerType === 'touch'
    if (touch) {
      lastTouch.current = Date.now()
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      svgRef.current!.setPointerCapture(e.pointerId)
      if (touches.current.size >= 2) {
        cancelLongPress()
        abortDrag()
        lastTap.current = null
        if (touches.current.size === 2) pinch.current = { ...pinchState(), view: viewRef.current }
        return
      }
      if (touchIdle.current) return
    }
    setSheet(null)
    if (editingRef.current) finishEditing()
    setPopover((p) => (p === 'help' ? p : null))
    setShapeTray(false)
    const p = toWorld(e.clientX, e.clientY)
    const svg = svgRef.current!
    svg.setPointerCapture(e.pointerId)
    // Holding a finger still opens the long-press menu.
    if (touch && tool === 'select') {
      const { clientX: x, clientY: y } = e
      const target = e.target as Element
      const onShape = !!target.closest('[data-edge]') || !!hitNode(p)
      const onHandle = !!target.closest('[data-handle]')
      if (!onHandle) longPress.current = { x, y, timer: window.setTimeout(() => { longPress.current = null; openSheet(x, y, !onShape) }, 500) }
    }
    // Ctrl/⌘-click (or "select several" on touch) adds to the selection; Shift-click edits text.
    const addSel = e.ctrlKey || e.metaKey || multiRef.current
    const shift = e.shiftKey || addSel
    if (e.button === 1 || tool === 'hand' || spaceRef.current) {
      e.preventDefault()
      return beginDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, view: viewRef.current })
    }
    if (e.button !== 0) return
    const target = e.target as Element
    if (tool !== 'select' && tool !== 'connector') {
      return beginDrag({ kind: 'create', shape: tool, start: p, cur: p })
    }
    if (tool === 'connector') {
      const n = hitNode(p)
      return beginDrag({
        kind: 'connect',
        from: n ? { ...dropAt(n, p), x: p.x, y: p.y } : { x: p.x, y: p.y },
        sourceId: n?.id,
        cur: p,
        moved: false,
      })
    }
    const handle = target.closest<SVGElement>('[data-handle]')
    if (handle) {
      const { handle: type, id = '', dir = '', side, end, text } = handle.dataset
      const d = docRef.current
      if (type === 'resize') {
        const n = d.nodes.find((x) => x.id === id)!
        return beginDrag({ kind: 'resize', id, dir, start: p, before: d, rect: { x: n.x, y: n.y, w: n.w, h: n.h } })
      }
      if (type === 'connect' && text) {
        return beginDrag({ kind: 'connect', from: { nodeId: id, textId: text, x: 0, y: 0 }, sourceId: id, cur: p, moved: false })
      }
      if (type === 'connect') {
        return beginDrag({ kind: 'connect', from: { nodeId: id, x: 0, y: 0 }, sourceId: id, quickSide: side as Side, cur: p, moved: false })
      }
      if (type === 'segment') {
        const edge = d.edges.find((x) => x.id === id)!
        const nm = new Map(d.nodes.map((n) => [n.id, n]))
        const { d1, d2 } = resolveEnds(edge, nm)
        return beginDrag({ kind: 'segment', id, index: Number(handle.dataset.index), start: p, before: d, base: routePoints(edge, nm), d1, d2, moved: false })
      }
      if (type === 'edge-end') {
        return beginDrag({ kind: 'edgeEnd', id, end: end as 'from' | 'to', before: d })
      }
    }
    const edgeEl = target.closest<SVGElement>('[data-edge]')
    const n = edgeEl ? undefined : hitNode(p)
    // Dragging a highlighted link phrase draws a connector out of it.
    const phrase = n && !shift && !e.altKey ? linkAt(n, p, 2 / viewRef.current.zoom) : undefined
    if (n && phrase) {
      return beginDrag({ kind: 'connect', from: { nodeId: n.id, textId: phrase, x: 0, y: 0 }, sourceId: n.id, cur: p, start: p, moved: false })
    }
    const hitId = edgeEl?.dataset.edge ?? n?.id
    if (hitId) {
      let sel = selectionRef.current
      const narrowTo = !shift && sel.length > 1 && sel.includes(hitId) ? hitId : undefined
      const editId = e.shiftKey && !addSel ? hitId : undefined
      if (editId) {
        sel = [hitId]
      } else if (addSel) {
        if (sel.includes(hitId)) return setSelection(sel.filter((x) => x !== hitId))
        sel = [...sel, hitId]
      } else if (!sel.includes(hitId)) {
        sel = [hitId]
      }
      setSelection(sel)
      const before = docRef.current
      let base = before
      let ids = withSectionContents(before, new Set(sel))
      if (e.altKey) {
        const part = cloneDoc(extract(before, ids), 0, 0)
        base = { nodes: [...before.nodes, ...part.nodes], edges: [...before.edges, ...part.edges] }
        ids = new Set([...part.nodes.map((x) => x.id), ...part.edges.map((x) => x.id)])
        setSelection([...ids])
        live(() => base)
      }
      return beginDrag({ kind: 'move', start: p, before, base, ids, moved: false, narrowTo, editId, guides: [] })
    }
    if (!shift) setSelection([])
    // A finger on empty canvas pans, unless "Select area" was picked from the long-press menu.
    if (touch && !areaRef.current) return beginDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, view: viewRef.current })
    areaRef.current = false
    beginDrag({ kind: 'marquee', start: p, cur: p, base: shift ? selectionRef.current : [] })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const lp = longPress.current
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress()
      const pc = pinch.current
      if (pc && touches.current.size >= 2) {
        // Keep the board point that was between the fingers under them.
        const { dist: dd, mid } = pinchState()
        const r = svgRef.current!.getBoundingClientRect()
        const z = clampZoom(pc.view.zoom * (dd / pc.dist))
        const wx = (pc.mid.x - r.left - pc.view.x) / pc.view.zoom
        const wy = (pc.mid.y - r.top - pc.view.y) / pc.view.zoom
        stopViewAnimation()
        setView({ zoom: z, x: mid.x - r.left - wx * z, y: mid.y - r.top - wy * z })
        return
      }
      if (touchIdle.current) return
    }
    const d = dragRef.current
    const p = toWorld(e.clientX, e.clientY)
    lastPointer.current = p
    const zoom = viewRef.current.zoom
    if (!d) {
      if (tool === 'select') {
        const n = hitNode(p, 26 / zoom)
        setHover(n?.id ?? null)
        setOverLink(!!n && !!linkAt(n, p, 2 / zoom))
      } else if (tool === 'connector') {
        setHover(hitNode(p)?.id ?? null)
      } else if (hover) {
        setHover(null)
      }
      return
    }
    let next: Drag = d
    switch (d.kind) {
      case 'pan':
        stopViewAnimation()
        setView({ ...d.view, x: d.view.x + e.clientX - d.sx, y: d.view.y + e.clientY - d.sy })
        return
      case 'move': {
        let dx = p.x - d.start.x
        let dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx, dy) * zoom < 3) return
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        if (physicsRef.current) {
          // Other shapes are being moved by the simulation, so only place the dragged ones.
          const start = new Map(d.base.nodes.filter((n) => d.ids.has(n.id)).map((n) => [n.id, n]))
          live((doc) => ({
            ...doc,
            nodes: doc.nodes.map((n) => {
              const s = start.get(n.id)
              return s ? { ...n, x: s.x + dx, y: s.y + dy } : n
            }),
          }))
          reheat(simRef.current, 0.5)
          next = { ...d, moved: true, guides: [] }
          break
        }
        const movingNodes = d.base.nodes.filter((n) => d.ids.has(n.id))
        let guides: Guide[] = []
        const box = unionRects(movingNodes)
        if (box && !e.altKey) {
          // Straightening a connector wins over lining up with other shapes.
          const c = snapConnectors(d.base, d.ids, dx, dy, 10 / zoom)
          const others = d.base.nodes.filter((n) => !d.ids.has(n.id))
          const s = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, others, 6 / zoom)
          const sx = c.cx ?? s.dx
          const sy = c.cy ?? s.dy
          dx += e.shiftKey && dx === 0 ? 0 : sx
          dy += e.shiftKey && dy === 0 ? 0 : sy
          guides = [...c.guides, ...s.guides.filter((g) => (g.x1 === g.x2 ? c.cx === undefined : c.cy === undefined))]
        }
        live(() => translate(d.base, d.ids, dx, dy))
        next = { ...d, moved: true, guides }
        break
      }
      case 'resize': {
        const r = d.rect
        const dx = p.x - d.start.x
        const dy = p.y - d.start.y
        let w = d.dir.includes('e') ? r.w + dx : d.dir.includes('w') ? r.w - dx : r.w
        let h = d.dir.includes('s') ? r.h + dy : d.dir.includes('n') ? r.h - dy : r.h
        const kind = d.before.nodes.find((n) => n.id === d.id)?.kind
        // Images keep their proportions unless Shift is held; other shapes the reverse.
        if ((kind === 'image' ? !e.shiftKey : e.shiftKey) && d.dir.length === 2) {
          const aspect = r.w / r.h
          if (w / h > aspect) h = w / aspect
          else w = h * aspect
        }
        w = Math.max(20, w)
        h = Math.max(20, h)
        const x = d.dir.includes('w') ? r.x + r.w - w : r.x
        const y = d.dir.includes('n') ? r.y + r.h - h : r.y
        live((doc) => ({
          ...doc,
          nodes: doc.nodes.map((n) => {
            if (n.id !== d.id) return n
            const resized = { ...n, x, y, w, h, fixedSize: true }
            return n.kind === 'text' ? fitToText(resized) : resized
          }),
        }))
        break
      }
      case 'marquee': {
        const r = rectFromPoints(d.start, p)
        const cur = docRef.current
        // A section is picked up only when the box covers all of it.
        const hits = cur.nodes.filter((n) => (n.kind === 'section' ? insideRect(r, n) : intersects(r, n))).map((n) => n.id)
        const nm = new Map(cur.nodes.map((n) => [n.id, n]))
        const edgeHits = cur.edges
          .filter((x) => {
            const b = edgeGeometry(x, nm).bounds
            return contains(r, { x: b.x, y: b.y }) && contains(r, { x: b.x + b.w, y: b.y + b.h })
          })
          .map((x) => x.id)
        setSelection([...new Set([...d.base, ...hits, ...edgeHits])])
        next = { ...d, cur: p }
        break
      }
      case 'create':
        next = { ...d, cur: p }
        break
      case 'connect': {
        const target = hitNode(p, 6 / zoom, d.sourceId)
        next = {
          ...d,
          cur: p,
          moved: d.moved || dist(p, d.start ?? d.cur) * zoom > 4 || (!d.quickSide && !d.start),
          target: target ? dropAt(target, p) : undefined,
        }
        break
      }
      case 'segment': {
        const delta = { x: p.x - d.start.x, y: p.y - d.start.y }
        // Snap the segment into line with the ends or another segment, so a jog straightens out.
        const route = d.base
        const horizontal = Math.abs(route[d.index].y - route[d.index + 1].y) < 0.5
        const at = horizontal ? route[d.index].y + delta.y : route[d.index].x + delta.x
        let best: number | undefined
        const th = 10 / zoom
        const consider = (v: number) => {
          if (Math.abs(v - at) <= th && (best === undefined || Math.abs(v - at) < Math.abs(best - at))) best = v
        }
        route.forEach((q, i) => {
          if (i === d.index || i === d.index + 1) return
          consider(horizontal ? q.y : q.x)
        })
        // Or onto a parallel stretch of another connector beside it, so the two overlap exactly.
        const a = route[d.index], b = route[d.index + 1]
        const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
        const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
        const nm = new Map(docRef.current.nodes.map((n) => [n.id, n]))
        for (const other of docRef.current.edges) {
          if (other.id === d.id || other.route === 'curved') continue
          const pts = routePoints(other, nm)
          for (let i = 0; i + 1 < pts.length; i++) {
            const q = pts[i], r = pts[i + 1]
            const flat = Math.abs(q.y - r.y) < 0.5
            const upright = Math.abs(q.x - r.x) < 0.5
            if (horizontal ? !flat : !upright) continue
            const qlo = horizontal ? Math.min(q.x, r.x) : Math.min(q.y, r.y)
            const qhi = horizontal ? Math.max(q.x, r.x) : Math.max(q.y, r.y)
            if (qhi < lo || qlo > hi) continue
            consider(horizontal ? q.y : q.x)
          }
        }
        if (best !== undefined) {
          if (horizontal) delta.y += best - at
          else delta.x += best - at
        }
        const moved = moveSegment(d.base, d.index, delta, d.d1, d.d2)
        const ends = [route[0], route[route.length - 1]]
        const clean = cleanRoute([ends[0], ...moved, ends[1]]).slice(1, -1)
        const points = clean.length ? clean : undefined
        live((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === d.id ? { ...x, route: 'elbow', points } : x)) }))
        next = { ...d, moved: true }
        break
      }
      case 'edgeEnd': {
        const edge = d.before.edges.find((x) => x.id === d.id)!
        const otherId = (d.end === 'from' ? edge.to : edge.from).nodeId
        const target = hitNode(p, 6 / zoom, otherId)
        const at = target ? dropAt(target, p) : undefined
        const endVal: EdgeEnd = at ? { ...at, x: p.x, y: p.y } : { x: p.x, y: p.y }
        // Re-attaching an end starts the route afresh.
        live((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === d.id ? { ...x, [d.end]: endVal, points: undefined } : x)) }))
        next = { ...d, target: at }
        break
      }
    }
    dragRef.current = next
    setDrag(next)
  }

  const onPointerUp = (e?: React.PointerEvent<SVGSVGElement>) => {
    cancelLongPress()
    if (e?.pointerType === 'touch') {
      touches.current.delete(e.pointerId)
      if (pinch.current || touchIdle.current) {
        pinch.current = null
        touchIdle.current = touches.current.size > 0
        return
      }
      // Two quick taps in the same place act like a double-click.
      const d = dragRef.current
      const still = !d || (d.kind === 'pan' && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 10) || (d.kind === 'move' && !d.moved)
      if (still && e.type === 'pointerup') {
        const t = lastTap.current
        const now = Date.now()
        if (t && now - t.t < 350 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
          lastTap.current = null
          dragRef.current = null
          setDrag(null)
          const target = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element)
          return openAt(target, e.clientX, e.clientY)
        }
        lastTap.current = { t: now, x: e.clientX, y: e.clientY }
      } else lastTap.current = null
    }
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d) return
    switch (d.kind) {
      case 'move':
        // With physics on, the layout is recorded once it settles instead.
        if (d.moved) {
          if (!physicsRef.current) record(d.before)
        }
        else {
          if (d.base !== d.before) live(() => d.before)
          // A plain click inside a multi-selection narrows it to that item.
          if (d.narrowTo) setSelection([d.narrowTo])
          // Shift-click goes straight into editing its text.
          if (d.editId) startEditing(d.editId)
        }
        break
      case 'resize':
      case 'edgeEnd':
        record(d.before)
        break
      case 'segment':
        if (d.moved) record(d.before)
        break
      case 'create': {
        const zoom = viewRef.current.zoom
        const r = rectFromPoints(d.start, d.cur)
        const size = DEFAULT_SIZE[d.shape]
        const clicked = r.w * zoom < 8 && r.h * zoom < 8
        const extra = d.shape === 'section' ? { text: nextSectionName(docRef.current) } : {}
        const node = clicked
          ? makeNode(d.shape, d.start.x - size.w / 2, d.start.y - size.h / 2, undefined, undefined, extra)
          : makeNode(d.shape, r.x, r.y, Math.max(r.w, 20), d.shape === 'text' ? size.h : Math.max(r.h, 20), extra)
        commit((doc) => ({ ...doc, nodes: [...doc.nodes, node] }))
        setSelection([node.id])
        setTool('select')
        setEditing({ kind: 'node', id: node.id, text: node.text })
        break
      }
      case 'connect': {
        const src = d.sourceId ? docRef.current.nodes.find((n) => n.id === d.sourceId) : undefined
        if (!d.moved) {
          if (src && d.quickSide) quickAdd(src, d.quickSide)
          // A click on a link phrase just selects its shape.
          else if (src && d.start) setSelection([src.id])
          break
        }
        if (!src && !d.target && dist(d.from, d.cur) * viewRef.current.zoom < 8) break
        // Dragged out of a shape into empty space: put a new shape there, facing back the way the line came.
        if (src && !d.target) {
          const c = center(src)
          const dx = d.cur.x - c.x
          const dy = d.cur.y - c.y
          const side: Side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : dy > 0 ? 'top' : 'bottom'
          const plain = src.kind === 'text' || src.kind === 'image' || src.kind === 'section'
          const kind: ShapeKind = plain ? 'rect' : src.kind
          const w = plain ? DEFAULT_SIZE.rect.w : src.w
          const h = plain ? DEFAULT_SIZE.rect.h : src.h
          const x = side === 'left' ? d.cur.x : side === 'right' ? d.cur.x - w : d.cur.x - w / 2
          const y = side === 'top' ? d.cur.y : side === 'bottom' ? d.cur.y - h : d.cur.y - h / 2
          const node = makeNode(kind, x, y, w, h, plain ? {} : { color: src.color, fontSize: src.fontSize })
          const edge = makeEdge(d.from, { nodeId: node.id, side, x: 0, y: 0 })
          commit((doc) => ({ nodes: [...doc.nodes, node], edges: [...doc.edges, edge] }))
          setSelection([node.id])
          setTool('select')
          setEditing({ kind: 'node', id: node.id, text: '' })
          break
        }
        const to: EdgeEnd = d.target ? { ...d.target, x: d.cur.x, y: d.cur.y } : { x: d.cur.x, y: d.cur.y }
        const edge = makeEdge(d.from, to)
        commit((doc) => ({ ...doc, edges: [...doc.edges, edge] }))
        setSelection([edge.id])
        setTool('select')
        break
      }
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double-taps are handled on pointer up.
    if (Date.now() - lastTouch.current < 800) return
    openAt(e.target as Element, e.clientX, e.clientY)
  }

  /** Double-click or double-tap: edit what's there, or add text on empty canvas. */
  const openAt = (target: Element, clientX: number, clientY: number) => {
    if (tool !== 'select') return
    const p = toWorld(clientX, clientY)
    const edgeId = target.closest<SVGElement>('[data-edge]')?.dataset.edge
    if (edgeId) {
      setSelection([edgeId])
      return startEditing(edgeId)
    }
    const n = hitNode(p)
    // Inside a section's empty area, double-click adds text like the open canvas;
    // on its name tab it renames the section.
    if (n && (n.kind !== 'section' || contains(sectionTitleRect(n), p))) {
      setSelection([n.id])
      return startEditing(n.id)
    }
    const node = makeNode('text', p.x - DEFAULT_SIZE.text.w / 2, p.y - DEFAULT_SIZE.text.h / 2)
    commit((doc) => ({ ...doc, nodes: [...doc.nodes, node] }))
    setSelection([node.id])
    setEditing({ kind: 'node', id: node.id, text: '' })
  }

  // ---------- derived UI ----------

  const zoom = view.zoom
  // Dot grid every 24 units, thinned out by 4x steps when zoomed far out.
  let gridSize = 24 * zoom
  while (gridSize < 12) gridSize *= 4
  const px = (n: number) => n / zoom
  const busy = !!drag && drag.kind !== 'marquee'
  const singleNode = selNodes.length === 1 && selEdges.length === 0 ? selNodes[0] : undefined
  const hoverNode = hover && !busy ? nodeMap.get(hover) : undefined
  const linkDotAt = (rects: LinkRect[]) => {
    const r = rects[rects.length - 1]
    return { x: (r.outRight ?? r.x + r.w) + 9 / zoom, y: r.y + r.h / 2 }
  }
  const linkDots = (n: NodeEl) =>
    [...linkRects(n)].map(([id, rects]) => {
      const c = linkDotAt(rects)
      return (
        <g key={`t${id}`} className="dot link-dot" data-handle="connect" data-id={n.id} data-text={id}>
          <circle cx={c.x} cy={c.y} r={px(9 * T * 1.4)} fill="transparent" />
          <circle cx={c.x} cy={c.y} r={px(4.5 * T)} className="dot-mark" strokeWidth={px(1.5)} />
        </g>
      )
    })
  const connectDots = (n: NodeEl) => [
    ...linkDots(n),
    ...(n.kind === 'text' || n.kind === 'section'
      ? []
      : SIDES.map((s) => {
          const a = anchor(n, s)
          const off = (16 * T) / zoom
          const c = { x: a.x + DIR[s].x * off, y: a.y + DIR[s].y * off }
          // A side dot right beside a link dot is easy to grab by mistake.
          if ([...linkRects(n).values()].some((rs) => dist(linkDotAt(rs), c) * zoom < 30)) return null
          return (
            <g key={s} className="dot" data-handle="connect" data-id={n.id} data-side={s}>
              <circle cx={c.x} cy={c.y} r={px(11 * T * 1.4)} fill="transparent" />
              <circle cx={c.x} cy={c.y} r={px(5 * T)} className="dot-mark" strokeWidth={px(1.5)} />
            </g>
          )
        })),
  ]

  // Handles in the middle of each straight piece of an elbow connector.
  const segmentHandles = (e: EdgeEl) => {
    const pts = routePoints(e, nodeMap)
    return pts.slice(0, -1).map((a, i) => {
      const b = pts[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len * zoom < 28) return null
      const horizontal = Math.abs(a.y - b.y) < 0.5
      const w = px((horizontal ? 18 : 8) * T)
      const h = px((horizontal ? 8 : 18) * T)
      // In the middle of the part that's on screen, so a long line's knob is always in reach.
      const m = 56 / zoom
      const lo = horizontal ? (-view.x / zoom) + m : (-view.y / zoom) + m
      const hi = horizontal ? (window.innerWidth - view.x) / zoom - m : (window.innerHeight - view.y) / zoom - m
      const [s0, s1] = horizontal ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)]
      const v0 = Math.max(s0, lo)
      const v1 = Math.min(s1, hi)
      const along = v1 - v0 > 0 ? (v0 + v1) / 2 : (s0 + s1) / 2
      const c = horizontal ? { x: along, y: a.y } : { x: a.x, y: along }
      return (
        <g key={`s${i}`} data-handle="segment" data-id={e.id} data-index={i} className={`seg-handle ${horizontal ? 'h' : 'v'}`}>
          <rect x={c.x - w / 2 - px(5 * T * T)} y={c.y - h / 2 - px(5 * T * T)} width={w + px(10 * T * T)} height={h + px(10 * T * T)} fill="transparent" />
          <rect x={c.x - w / 2} y={c.y - h / 2} width={w} height={h} rx={px(4)} className="handle-mark" strokeWidth={px(1.5)} />
        </g>
      )
    })
  }

  const previewEdge: EdgeEl | null =
    drag?.kind === 'connect' && drag.moved
      ? makeEdge(
          drag.from,
          drag.target ? { ...drag.target, x: 0, y: 0 } : { x: drag.cur.x, y: drag.cur.y },
        )
      : null
  const dropTarget = drag?.kind === 'connect' || drag?.kind === 'edgeEnd' ? drag.target : undefined
  const dropNode = dropTarget ? nodeMap.get(dropTarget.nodeId) : undefined

  const selBox = useMemo(() => {
    const rects: Rect[] = [...selNodes]
    for (const e of selEdges) rects.push(edgeGeometry(e, nodeMap).bounds)
    return unionRects(rects)
  }, [selNodes, selEdges, nodeMap])

  const editingNode = editing?.kind === 'node' ? nodeMap.get(editing.id) : undefined
  const editingId = editingNode?.id
  // The board's link phrases, for the "/" list (worked out once per edit).
  const boardPhrases = useMemo(() => {
    if (!editingId) return []
    const seen = new Map<string, string>()
    for (const l of boardLinks(docRef.current.nodes)) if (!seen.has(phraseKey(l.phrase))) seen.set(phraseKey(l.phrase), l.phrase)
    return [...seen.values()]
  }, [editingId, docRef])
  const editingEdge = editing?.kind === 'edge' ? doc.edges.find((x) => x.id === editing.id) : undefined

  // Dashed lines joining copies of the same link only show while one of their shapes (or the line) is selected.
  const hiddenJoins = useMemo(() => {
    const phrase = (end: EdgeEl['from']) => {
      const n = end.nodeId && end.textId ? nodeMap.get(end.nodeId) : undefined
      const g = n?.rich ? linkGroups(paragraphsOf(n)).find((x) => x.id === end.textId) : undefined
      return g ? phraseKey(g.phrase) : null
    }
    const out = new Set<string>()
    for (const e of doc.edges) {
      if (!e.dashed || e.startHead !== 'none' || e.endHead !== 'none') continue
      const a = phrase(e.from)
      if (!a || a !== phrase(e.to)) continue
      if (selSet.has(e.id) || selSet.has(e.from.nodeId!) || selSet.has(e.to.nodeId!)) continue
      out.add(e.id)
    }
    return out
  }, [doc.edges, nodeMap, selSet])

  const shownColors = useMemo(() => (crossColors ? crossingColors(doc, nodeMap) : new Map<string, string>()), [crossColors, doc, nodeMap])

  const cursor =
    drag?.kind === 'pan'
      ? 'grabbing'
      : tool === 'hand' || spaceDown
        ? 'grab'
        : tool === 'select'
          ? overLink
            ? 'crosshair'
            : 'default'
          : 'crosshair'

  const textNodes = selNodes.filter((n) => n.kind !== 'image' && n.kind !== 'section')
  const outlineKey = selNodes[0]?.outline
  // Keep the toolbar off the shapes a jump just landed on.
  const barBelow =
    !!halo &&
    !!selBox &&
    halo.ids.some((id) => {
      const n = nodeMap.get(id)
      const top = selBox.y * zoom + view.y - 80
      const bottom = selBox.y * zoom + view.y
      return !!n && n.y * zoom + view.y < bottom && (n.y + n.h) * zoom + view.y > top
    })
  const firstColor: ColorKey | undefined = selNodes[0]?.color ?? selEdges[0]?.color
  const allFlow = selNodes.length > 0 && selNodes.every((n) => FLOW_SHAPES.includes(n.kind))
  const sameKind = allFlow && selNodes.every((n) => n.kind === selNodes[0].kind) ? selNodes[0].kind : undefined

  /** What the long-press menu offers for what's under the finger. */
  const sheetItems = (): ({ label: string; run: () => void; disabled?: boolean } | '-')[] => {
    const sel = selectionRef.current
    const at = sheet?.p
    const items: ({ label: string; run: () => void; disabled?: boolean } | '-')[] = []
    if (sel.length && !sheet?.onEmpty) {
      if (sel.length === 1) items.push({ label: 'Edit text', run: () => startEditing(sel[0]) })
      items.push(
        { label: 'Duplicate', run: () => copySelection() && ((clipboard.current!.pastes = 0), paste()) },
        { label: 'Copy', run: () => void copySelection() },
        { label: 'Delete', run: deleteSelection },
        '-',
        { label: 'Bring to front', run: () => reorder(true) },
        { label: 'Send to back', run: () => reorder(false) },
        { label: 'Wrap in new section', run: wrapInSection },
      )
      if (sel.length === 1 && docRef.current.edges.some((x) => x.id === sel[0])) items.push({ label: 'Go to the other end', run: jumpToOtherEnd })
      items.push('-', { label: multi ? 'Stop selecting several' : 'Select several…', run: () => setMulti(!multi) })
    } else {
      items.push(
        {
          label: 'Add text here',
          run: () => {
            if (!at) return
            const node = makeNode('text', at.x - DEFAULT_SIZE.text.w / 2, at.y - DEFAULT_SIZE.text.h / 2)
            commit((d) => ({ ...d, nodes: [...d.nodes, node] }))
            setSelection([node.id])
            setEditing({ kind: 'node', id: node.id, text: '' })
          },
        },
        { label: 'Paste', run: paste, disabled: !clipboard.current },
        '-',
        { label: 'Select area (drag next)', run: () => { areaRef.current = true; flash('Drag to draw a selection box') } },
        { label: 'Select several…', run: () => setMulti(true) },
        { label: 'Select all', run: () => setSelection([...docRef.current.nodes.map((n) => n.id), ...docRef.current.edges.map((x) => x.id)]) },
      )
    }
    return items
  }

  // ---------- render ----------

  return (
    <div className={`app${compact ? " compact" : ""}${coarse ? " touch" : ""}`}>
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
        }}
        onDrop={onDrop}
        className={`stage${dropping ? ' dropping' : ''}`}
        style={{
          cursor,
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <svg
          ref={svgRef}
          className="canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => !dragRef.current && setHover(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        >
          <g ref={contentRef} transform={`translate(${view.x} ${view.y}) scale(${zoom})`}>
            <SvgDefs />
            {drawOrder(doc.nodes).map((n) => (
              <ShapeView key={n.id} n={n} hideText={editing?.kind === 'node' && editing.id === n.id} />
            ))}
            {doc.edges.filter((e) => !hiddenJoins.has(e.id)).map((e) => (
              <EdgeView key={e.id} e={e} nodes={nodeMap} color={shownColors.get(e.id)} trunk={trunkMap.get(e.id)} hideLabel={editing?.kind === 'edge' && editing.id === e.id} />
            ))}
          </g>

          {diffView && (
            <style>{`.canvas [data-node], .canvas [data-edge] { opacity: 0.22 }\n${[...diffView.all].map((id) => `.canvas [data-node="${CSS.escape(id)}"], .canvas [data-edge="${CSS.escape(id)}"]`).join(',\n') || '.none'} { opacity: 1 }`}</style>
          )}
          <g transform={`translate(${view.x} ${view.y}) scale(${zoom})`} className="overlay">
            {showFlow && (
              <g className="flow-marks">
                {doc.edges.map((e) => {
                  // Arrow only at the start: the flow runs backwards along the line.
                  const back = e.startHead !== 'none' && e.endHead === 'none'
                  // Arrows at both ends: dots run both ways.
                  const both = e.startHead !== 'none' && e.endHead !== 'none'
                  const w = Math.max(e.width * 2 + 4, px(7))
                  const d = edgeGeometry(e, nodeMap).d
                  const stroke = shownColors.get(e.id) ?? strokeOf(e.color)
                  const gap = w * (both ? 6 : 4)
                  const run = (cls: string, k: string, late = false) => (
                    <path
                      key={k}
                      className={cls}
                      d={d}
                      stroke={stroke}
                      strokeWidth={w}
                      strokeDasharray={`0.01 ${gap}`}
                      style={{ '--flow-step': `${gap}px`, animationDelay: late ? '-0.45s' : undefined } as React.CSSProperties}
                    />
                  )
                  return both ? [run('flow', `${e.id}a`), run('flow back', `${e.id}b`, true)] : run(back ? 'flow back' : 'flow', e.id)
                })}
              </g>
            )}
            {diffView && (
              <g className="diff-marks">
                {doc.edges
                  .filter((e) => diffView.changed.has(e.id))
                  .map((e) => (
                    <path key={e.id} className="diff-edge" d={edgeGeometry(e, nodeMap).d} strokeWidth={Math.max(px(8), e.width + 6)} />
                  ))}
                {[...diffView.all].map((id) => {
                  const n = nodeMap.get(id)
                  if (!n) return null
                  const pad = px(6)
                  const changed = diffView.changed.has(id)
                  return (
                    <rect
                      key={id}
                      className={changed ? 'diff-node' : 'diff-node ctx'}
                      x={n.x - pad}
                      y={n.y - pad}
                      width={n.w + pad * 2}
                      height={n.h + pad * 2}
                      rx={px(8)}
                      strokeWidth={px(3)}
                      strokeDasharray={changed ? undefined : `${px(6)} ${px(4)}`}
                    />
                  )
                })}
              </g>
            )}
            {halo &&
              halo.ids.map((id) => {
                const n = nodeMap.get(id)
                if (!n) return null
                const pad = px(8)
                return (
                  <rect key={`${halo.key}-${id}`} className="halo" x={n.x - pad} y={n.y - pad} width={n.w + pad * 2} height={n.h + pad * 2} rx={px(10)} strokeWidth={px(4)} />
                )
              })}
            {searchOpen && hitMarks.length > 0 && (
              <g className="search-marks">
                {hitMarks.map((rects, i) =>
                  rects.map((r, j) => (
                    <rect
                      key={`${markHits[i]?.id}-${j}`}
                      className={markHits[i]?.id === flatHits[hitIndex]?.id ? 'mark current' : 'mark'}
                      x={r.x - px(2)}
                      y={r.y}
                      width={r.w + px(4)}
                      height={r.h}
                      rx={Math.min(4, r.h / 5)}
                      strokeWidth={px(2)}
                    />
                  )),
                )}
                {hitIndex >= 0 &&
                  (() => {
                    const f = flatHits[hitIndex] && hitFocus(flatHits[hitIndex], doc)
                    if (!f || flatHits[hitIndex].kind === 'label') return null
                    const pad = px(6)
                    return <rect className="focus" x={f.box.x - pad} y={f.box.y - pad} width={f.box.w + pad * 2} height={f.box.h + pad * 2} rx={px(8)} strokeWidth={px(2.5)} />
                  })()}
              </g>
            )}
            {hoverNode && !selSet.has(hoverNode.id) && (
              <rect className="outline" x={hoverNode.x} y={hoverNode.y} width={hoverNode.w} height={hoverNode.h} strokeWidth={px(1.5)} />
            )}
            {selNodes.map((n) => (
              <rect key={n.id} className="outline" x={n.x} y={n.y} width={n.w} height={n.h} strokeWidth={px(1.5)} />
            ))}
            {selNodes.length + selEdges.length > 1 && selBox && (
              <rect className="outline group" x={selBox.x - px(6)} y={selBox.y - px(6)} width={selBox.w + px(12)} height={selBox.h + px(12)} strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(4)}`} />
            )}
            {selEdges.map((e) => {
              const g = edgeGeometry(e, nodeMap)
              return (
                <g key={e.id}>
                  <path d={g.d} className="edge-sel" strokeWidth={px(1.5)} />
                  {selEdges.length === 1 && !busy && e.route === 'elbow' && segmentHandles(e)}
                  {(['from', 'to'] as const).map((end) => {
                    const pt = end === 'from' ? g.start : g.end
                    return (
                      <g key={end} data-handle="edge-end" data-id={e.id} data-end={end} className="end-handle">
                        <circle cx={pt.x} cy={pt.y} r={px(10 * T * 1.4)} fill="transparent" />
                        <circle cx={pt.x} cy={pt.y} r={px(5 * T)} className="handle-mark" strokeWidth={px(1.5)} />
                      </g>
                    )
                  })}
                </g>
              )
            })}
            {hoverNode && tool === 'select' && !editing && (selection.length <= 1 || !selSet.has(hoverNode.id)) && connectDots(hoverNode)}
            {singleNode && !busy && !editing && hoverNode?.id !== singleNode.id && connectDots(singleNode)}
            {singleNode &&
              !busy &&
              (singleNode.kind === 'text' ? ['e', 'w'] : ['nw', 'ne', 'sw', 'se']).map((dir) => {
                const x = dir.includes('w') ? singleNode.x : singleNode.x + singleNode.w
                const y =
                  dir === 'e' || dir === 'w' ? singleNode.y + singleNode.h / 2 : dir.includes('n') ? singleNode.y : singleNode.y + singleNode.h
                const s = px(9 * T)
                const hit = px(9 * T * 2.6)
                return (
                  <g key={dir}>
                    {coarse && <rect data-handle="resize" data-id={singleNode.id} data-dir={dir} x={x - hit / 2} y={y - hit / 2} width={hit} height={hit} fill="transparent" />}
                    <rect
                      data-handle="resize"
                      data-id={singleNode.id}
                      data-dir={dir}
                      className={`handle-mark resize-${dir}`}
                      x={x - s / 2}
                      y={y - s / 2}
                      width={s}
                      height={s}
                      rx={px(2)}
                      strokeWidth={px(1.5)}
                    />
                  </g>
                )
              })}
            {dropNode && (
              <g>
                <rect className="outline drop" x={dropNode.x} y={dropNode.y} width={dropNode.w} height={dropNode.h} strokeWidth={px(2)} />
                {[...linkRects(dropNode)].flatMap(([id, rects]) =>
                  rects.map((r, i) => (
                    <rect
                      key={`${id}${i}`}
                      className={dropTarget?.textId === id ? 'link-drop on' : 'link-drop'}
                      x={r.x - px(3)}
                      y={r.y}
                      width={r.w + px(6)}
                      height={r.h}
                      rx={px(4)}
                      strokeWidth={px(dropTarget?.textId === id ? 2 : 1)}
                    />
                  )),
                )}
                {dropTarget?.side && dropTarget.at !== undefined && (() => {
                  const a = anchor(dropNode, dropTarget.side, dropTarget.at)
                  return <circle cx={a.x} cy={a.y} r={px(5)} className="anchor on" strokeWidth={px(1.5)} />
                })()}
                {!dropTarget?.textId && SIDES.map((s) => {
                  const a = anchor(dropNode, s)
                  return (
                    <circle
                      key={s}
                      cx={a.x}
                      cy={a.y}
                      r={px(dropTarget?.side === s && dropTarget.at === undefined ? 6 : 4)}
                      className={dropTarget?.side === s && dropTarget.at === undefined ? 'anchor on' : 'anchor'}
                      strokeWidth={px(1.5)}
                    />
                  )
                })}
              </g>
            )}
            {previewEdge && <EdgeView e={previewEdge} nodes={nodeMap} />}
            {drag?.kind === 'marquee' && (() => {
              const r = rectFromPoints(drag.start, drag.cur)
              return <rect className="marquee" x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={px(1)} />
            })()}
            {drag?.kind === 'create' && (() => {
              const r = rectFromPoints(drag.start, drag.cur)
              return r.w * zoom > 8 || r.h * zoom > 8 ? (
                <rect className="marquee" x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={px(1)} />
              ) : null
            })()}
            {drag?.kind === 'move' &&
              drag.guides.map((g, i) => <line key={i} className="guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} strokeWidth={px(1)} />)}
          </g>
        </svg>

        {editingNode?.kind === 'section' && (
          <SectionTitleEditor
            n={editingNode}
            view={view}
            text={editing!.text}
            onChange={(text) => setEditing({ ...editing!, text })}
            onDone={finishEditing}
          />
        )}
        {editingNode && editingNode.kind !== 'section' && (
          <>
            <RichEditor
              n={editingNode}
              view={view}
              editorRef={editorRef}
              onDone={finishEditing}
              onInput={onEditInput}
              links={boardPhrases}
              onLinkPicked={(id) => pickedLinks.current.add(id)}
            />
            <RichToolbar
              n={editingNode}
              view={view}
              editorRef={editorRef}
              onFontSize={(v) => commit((d) => ({ ...d, nodes: d.nodes.map((x) => (x.id === editingNode.id ? { ...x, fontSize: v } : x)) }))}
            />
          </>
        )}
        {editingEdge && (
          <EdgeLabelEditor
            e={editingEdge}
            nodes={nodeMap}
            view={view}
            text={editing!.text}
            onChange={(text) => setEditing({ ...editing!, text })}
            onDone={finishEditing}
          />
        )}

        {selBox && !busy && !editing && (selNodes.length > 0 || selEdges.length > 0) && (
          <FloatingBar className="chrome stylebar" x={(selBox.x + selBox.w / 2) * zoom + view.x} y={barBelow ? (selBox.y + selBox.h) * zoom + view.y + 64 : selBox.y * zoom + view.y - 16 - (selNodes.some((n) => n.kind === 'section') ? 34 * zoom : 0)}>
            <div className="popwrap">
              <button
                className="iconbtn"
                title="Color"
                aria-label="Color"
                onClick={() => setPopover(popover === 'color' ? null : 'color')}
              >
                <span
                  className="swatch"
                  style={{
                    background: firstColor === 'ink' ? 'var(--panel)' : firstColor ? PALETTE[firstColor].fill : undefined,
                    borderColor: firstColor === 'ink' ? INK : firstColor ? PALETTE[firstColor].stroke : undefined,
                  }}
                />
              </button>
              {popover === 'color' && (
                <div className="pop colors">
                  {(Object.keys(PALETTE) as ColorKey[]).map((c) => (
                    <button
                      key={c}
                      className={`swatchbtn${c === firstColor ? ' on' : ''}`}
                      title={PALETTE[c].label}
                      aria-label={PALETTE[c].label}
                      onClick={() => {
                        updateSelected((n) => ({ ...n, color: c }), (e) => ({ ...e, color: c }))
                        setPopover(null)
                      }}
                    >
                      <span
                        className="swatch"
                        style={{
                          background: c === 'ink' ? 'var(--panel)' : selNodes.some((n) => n.kind === 'sticky') ? PALETTE[c].sticky : PALETTE[c].fill,
                          borderColor: c === 'ink' ? INK : PALETTE[c].stroke,
                        }}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selNodes.length > 0 && (
              <div className="popwrap">
                <button className="iconbtn" title="Outline" aria-label="Outline" onClick={() => setPopover(popover === 'outline' ? null : 'outline')}>
                  <span
                    className="swatch ring"
                    style={{
                      borderColor: outlineKey === 'none' ? 'var(--line)' : outlineKey ? strokeOf(outlineKey) : 'var(--muted)',
                      borderStyle: outlineKey === 'none' || selNodes[0].outlineDashed ? 'dashed' : 'solid',
                    }}
                  />
                </button>
                {popover === 'outline' && (
                  <div className="pop outline-pop">
                    <div className="pop-label">Outline color</div>
                    <div className="colors">
                      <button
                        className={`swatchbtn${outlineKey === 'none' ? ' on' : ''}`}
                        title="No outline"
                        aria-label="No outline"
                        onClick={() => updateSelected((n) => ({ ...n, outline: 'none' }), null)}
                      >
                        <span className="swatch none" />
                      </button>
                      {(Object.keys(PALETTE) as ColorKey[]).map((c) => (
                        <button
                          key={c}
                          className={`swatchbtn${c === outlineKey ? ' on' : ''}`}
                          title={PALETTE[c].label}
                          aria-label={`${PALETTE[c].label} outline`}
                          onClick={() => updateSelected((n) => ({ ...n, outline: c }), null)}
                        >
                          <span className="swatch ring" style={{ borderColor: strokeOf(c) }} />
                        </button>
                      ))}
                    </div>
                    <div className="pop-label">Thickness</div>
                    <div className="seg">
                      {OUTLINE_WIDTHS.map((w) => (
                        <button
                          key={w}
                          className={(selNodes[0].outlineWidth ?? 2) === w ? 'on' : ''}
                          onClick={() => updateSelected((n) => ({ ...n, outlineWidth: w }), null)}
                        >
                          {w}px
                        </button>
                      ))}
                    </div>
                    <div className="seg">
                      <button className={!selNodes[0].outlineDashed ? 'on' : ''} onClick={() => updateSelected((n) => ({ ...n, outlineDashed: false }), null)}>
                        Solid
                      </button>
                      <button className={selNodes[0].outlineDashed ? 'on' : ''} onClick={() => updateSelected((n) => ({ ...n, outlineDashed: true }), null)}>
                        Dashed
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {allFlow && (
              <div className="popwrap">
                <button className="iconbtn" title="Shape" aria-label="Change shape" onClick={() => setPopover(popover === 'shape' ? null : 'shape')}>
                  <ShapeIcon kind={sameKind ?? 'rect'} size={18} />
                </button>
                {popover === 'shape' && (
                  <div className="pop shapes">
                    {FLOW_SHAPES.map((k) => (
                      <button
                        key={k}
                        className={`iconbtn${k === sameKind ? ' on' : ''}`}
                        title={SHAPE_LABELS[k]}
                        aria-label={SHAPE_LABELS[k]}
                        onClick={() => {
                          updateSelected((n) => fitToText({ ...n, kind: k }), null)
                          setPopover(null)
                        }}
                      >
                        <ShapeIcon kind={k} size={18} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {textNodes.length > 0 && (
              <>
                <FontSizeInput value={textNodes[0].fontSize} onChange={(v) => updateSelected((n) => (n.kind === 'image' ? n : fitToText({ ...n, fontSize: v })), null)} />
                {(['bold', 'italic', 'underline', 'strike'] as const).map((key) => {
                  const on = textNodes.every((n) => allRuns(n, key))
                  const label = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough' }[key]
                  const glyph = { bold: <b className="glyph">B</b>, italic: <i className="glyph serif">I</i>, underline: <u className="glyph">U</u>, strike: <s className="glyph">S</s> }[key]
                  return (
                    <button
                      key={key}
                      className={`iconbtn${on ? ' on' : ''}`}
                      title={`${label} (whole text)`}
                      aria-label={label}
                      aria-pressed={on}
                      onClick={() => updateSelected((n) => (n.kind === 'image' ? n : fitToText(styleAllRuns(n, { [key]: !on }))), null)}
                    >
                      {glyph}
                    </button>
                  )
                })}
                <div className="popwrap">
                  <button className="iconbtn" title="Text alignment" aria-label="Text alignment" onClick={() => setPopover(popover === 'align' ? null : 'align')}>
                    <AlignIcon kind={paragraphsOf(textNodes[0])[0]?.align ?? (textNodes[0].kind === 'sticky' ? 'left' : 'center')} />
                  </button>
                  {popover === 'align' && (
                    <div className="pop row">
                      {(['left', 'center', 'right'] as const).map((a) => (
                        <button
                          key={a}
                          className="iconbtn"
                          title={`Align ${a}`}
                          aria-label={`Align ${a}`}
                          onClick={() => {
                            updateSelected((n) => (n.kind === 'image' ? n : alignAll(n, a)), null)
                            setPopover(null)
                          }}
                        >
                          <AlignIcon kind={a} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {(['bullet', 'number'] as const).map((kind) => {
                  const on = textNodes.every((n) => paragraphsOf(n).every((p) => p.list === kind))
                  const label = kind === 'bullet' ? 'Bulleted list' : 'Numbered list'
                  return (
                    <button
                      key={kind}
                      className={`iconbtn${on ? ' on' : ''}`}
                      title={`${label} (whole text)`}
                      aria-label={label}
                      aria-pressed={on}
                      onClick={() => updateSelected((n) => (n.kind === 'image' ? n : fitToText(listAll(n, on ? undefined : kind))), null)}
                    >
                      <ListIcon numbered={kind === 'number'} />
                    </button>
                  )
                })}
              </>
            )}
            {selEdges.length > 0 && (
              <>
                {selNodes.length > 0 && <span className="sep" />}
                {(['elbow', 'curved', 'straight'] as Route[]).map((r) => {
                  const Icon = Icons[r]
                  return (
                    <button
                      key={r}
                      className={`iconbtn${selEdges[0].route === r ? ' on' : ''}`}
                      title={r === 'elbow' && selEdges[0].points ? 'Elbow line (click to reset the route)' : `${r[0].toUpperCase()}${r.slice(1)} line`}
                      aria-label={`${r} line`}
                      onClick={() => updateSelected(null, (e) => ({ ...e, route: r, points: undefined }))}
                    >
                      <Icon />
                    </button>
                  )
                })}
                <span className="sep" />
                {(['startHead', 'endHead'] as const).map((end) => (
                  <div className="popwrap" key={end}>
                    <button
                      className="iconbtn wide"
                      title={end === 'startHead' ? 'Start of line' : 'End of line'}
                      aria-label={end === 'startHead' ? 'Arrowhead at start' : 'Arrowhead at end'}
                      onClick={() => setPopover(popover === end ? null : end)}
                    >
                      <HeadIcon head={selEdges[0][end]} flip={end === 'startHead'} />
                    </button>
                    {popover === end && (
                      <div className="pop heads">
                        {ARROW_HEADS.map((h) => (
                          <button
                            key={h.value}
                            className={`headbtn${selEdges[0][end] === h.value ? ' on' : ''}`}
                            title={h.label}
                            aria-label={h.label}
                            onClick={() => {
                              updateSelected(null, (e) => ({ ...e, [end]: h.value as ArrowHead }))
                              setPopover(null)
                            }}
                          >
                            <HeadIcon head={h.value} flip={end === 'startHead'} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <button
                  className={`iconbtn${selEdges[0].dashed ? ' on' : ''}`}
                  title="Dashed line"
                  aria-label="Dashed line"
                  onClick={() => {
                    const v = !selEdges[0].dashed
                    updateSelected(null, (e) => ({ ...e, dashed: v }))
                  }}
                >
                  <Icons.dashed />
                </button>
                <select
                  id="line-width"
                  aria-label="Line thickness"
                  title="Line thickness"
                  value={selEdges[0].width}
                  onChange={(e) => updateSelected(null, (x) => ({ ...x, width: Number(e.target.value) }))}
                >
                  {WIDTHS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
                {selEdges.length === 1 && selNodes.length === 0 && (!selEdges[0].to.nodeId || !selEdges[0].from.nodeId) && (
                  <div className="popwrap">
                    <button className="iconbtn" title="Add a shape at the loose end" aria-label="Add a shape at the loose end" onClick={() => setPopover(popover === 'endShape' ? null : 'endShape')}>
                      <ShapeIcon kind="rect" size={18} />
                    </button>
                    {popover === 'endShape' && (
                      <div className="pop shapes">
                        {FLOW_SHAPES.map((k) => (
                          <button key={k} className="iconbtn" title={SHAPE_LABELS[k]} aria-label={`Add ${SHAPE_LABELS[k]}`} onClick={() => shapeAtEnd(selEdges[0].id, k)}>
                            <ShapeIcon kind={k} size={18} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {selEdges.length === 1 && selNodes.length === 0 && (
                  <button className="textbtn" onClick={() => startEditing(selEdges[0].id)}>
                    {selEdges[0].label ? 'Edit label' : 'Add label'}
                  </button>
                )}
              </>
            )}
            {selNodes.length === 1 && selNodes[0].kind === 'section' && (
              <button className="textbtn" onClick={() => startEditing(selNodes[0].id)}>
                Rename
              </button>
            )}
            {selNodes.length > 0 && (
              <button className="iconbtn" title={`Wrap in new section (${MOD}+Alt+G)`} aria-label="Wrap in new section" onClick={wrapInSection}>
                <Icons.section />
              </button>
            )}
            {(selEdges.length > 0 || (selNodes.length === 1 && doc.edges.some((e) => e.from.nodeId === selNodes[0].id || e.to.nodeId === selNodes[0].id))) && (
              <button
                className="iconbtn"
                title={selEdges.length ? 'Go to the other end (Shift+J)' : 'Show connected shapes (Shift+J)'}
                aria-label={selEdges.length ? 'Go to the other end' : 'Show connected shapes'}
                onClick={jumpToOtherEnd}
              >
                <Icons.jump />
              </button>
            )}
            <span className="sep" />
            <button className="iconbtn" title="Delete (Del)" aria-label="Delete" onClick={deleteSelection}>
              <Icons.trash />
            </button>
          </FloatingBar>
        )}
      </div>

      {/* Top left: menu and title */}
      <div className="chrome topleft">
        <div className="popwrap">
          <button className="iconbtn" aria-label="Menu" title="Menu" onClick={() => setPopover(popover === 'menu' ? null : 'menu')}>
            <Icons.menu />
          </button>
          {popover === 'menu' && (
            <div className="pop menu" role="menu">
              <button role="menuitem" onClick={newBoard}>New board</button>
              <button role="menuitem" onClick={() => { setPopover(null); fileRef.current?.click() }}>Open file (.md or .html)…</button>
              <button role="menuitem" onClick={() => { setPopover(null); imageInputRef.current?.click() }}>
                Upload image… <kbd>Shift+I</kbd>
              </button>
              <hr />
              <button role="menuitem" onClick={() => setPopover('workspace')}>
                Workspace… <kbd>{MOD}+S</kbd>
              </button>
              {wsDir && (
                <button role="menuitem" onClick={() => { setPopover(null); void saveWorkspace() }}>
                  Save to workspace
                </button>
              )}
              <hr />
              <button role="menuitem" onClick={() => openExport('board')}>
                Export board… <kbd>{MOD}+Shift+E</kbd>
              </button>
              <button role="menuitem" disabled={!selection.length} onClick={() => openExport('selection')}>
                Export selection…
              </button>
              <button
                role="menuitem"
                title={`Select shapes and connectors that are new or edited since ${refName}`}
                onClick={() => {
                  setPopover(null)
                  const ids = diffIds()
                  setSelection([...ids])
                  flash(ids.size ? `Selected ${ids.size} new or edited since ${refName}` : `Nothing new since ${refName}`)
                }}
              >
                Select what's new
              </button>
              <button role="menuitem" title="The guide to writing boards as Markdown, for you or an AI assistant" onClick={downloadGuide}>
                Download Markdown guide (.md)
              </button>
              <button role="menuitem" onClick={copyAsPng}>
                Copy as PNG <kbd>{MOD}+Shift+C</kbd>
              </button>
              <button role="menuitemcheckbox" aria-checked={crossColors} onClick={toggleCrossColors}>
                {crossColors ? '✓ ' : ''}Color crossing connectors
              </button>
            </div>
          )}
        </div>
        <span className="brand">Flowboard</span>
        <span className="slash">/</span>
        {currentFile && (
          <span className="filepath" title={`Saved in ${wsDir?.name ?? 'workspace'}/${currentFile.path}`}>
            {currentFile.path}
          </span>
        )}
        <input id="board-title" className="title" value={title} aria-label="Board name" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <input
          ref={imageInputRef}
          id="upload-image"
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            if (files.length) void addImages(files)
            e.target.value = ''
          }}
        />
        <input
          ref={fileRef}
          id="open-file"
          type="file"
          accept=".md,.markdown,.html,.htm,.json,application/json,text/markdown,text/html"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) openFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {/* Top right: history */}
      <div className="chrome topright">
        <button className="iconbtn" title={`Undo (${MOD}+Z)`} aria-label="Undo" disabled={!canUndo} onClick={undo}>
          <Icons.undo />
        </button>
        <button className="iconbtn" title={`Redo (${MOD}+Shift+Z)`} aria-label="Redo" disabled={!canRedo} onClick={redo}>
          <Icons.redo />
        </button>
      </div>

      {/* Bottom: tools */}
      <div className="chrome toolbar" role="toolbar" aria-label="Tools">
        <ToolButton label="Select" hint="V" on={tool === 'select'} onClick={() => setTool('select')}>
          <Icons.select />
        </ToolButton>
        <ToolButton label="Hand" hint="H" on={tool === 'hand'} onClick={() => setTool('hand')}>
          <Icons.hand />
        </ToolButton>
        <span className="sep" />
        <div className="popwrap">
          <ToolButton
            label={SHAPE_LABELS[lastShape]}
            hint="R"
            on={FLOW_SHAPES.includes(tool as ShapeKind)}
            onClick={() => {
              setTool(lastShape)
              setShapeTray((s) => !s)
            }}
          >
            <ShapeIcon kind={lastShape} />
            <span className="caret" />
          </ToolButton>
          {shapeTray && (
            <div className="pop tray">
              {FLOW_SHAPES.map((k) => (
                <button
                  key={k}
                  className={`traybtn${tool === k ? ' on' : ''}`}
                  onClick={() => {
                    setTool(k)
                    setLastShape(k)
                    setShapeTray(false)
                  }}
                >
                  <ShapeIcon kind={k} size={22} />
                  <span>{SHAPE_LABELS[k]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <ToolButton label="Sticky note" hint="S" on={tool === 'sticky'} onClick={() => setTool('sticky')}>
          <Icons.sticky />
        </ToolButton>
        <ToolButton label="Section" hint="Shift+S" on={tool === 'section'} onClick={() => setTool('section')}>
          <Icons.section />
        </ToolButton>
        <ToolButton label="Text" hint="T" on={tool === 'text'} onClick={() => setTool('text')}>
          <Icons.text />
        </ToolButton>
        <ToolButton label="Connector" hint="X" on={tool === 'connector'} onClick={() => setTool('connector')}>
          <Icons.connector />
        </ToolButton>
        <span className="sep" />
        <ToolButton label="Upload image" hint="Shift+I" on={false} onClick={() => imageInputRef.current?.click()}>
          <Icons.image />
        </ToolButton>
      </div>

      {diffView && popover !== 'diff' && (
        <div className="chrome diffchip" role="status">
          <i className="sw changed" /> {diffView.changed.size} new or edited
          <i className="sw ctx" /> {diffView.all.size - diffView.changed.size} affected
          <span className="muted">since {refName}</span>
        </div>
      )}
      {popover === 'diff' && (
        <div className="chrome diffmenu" role="dialog" aria-label="Diff">
          <label className="check">
            <input type="checkbox" checked={showDiff} onChange={() => setShowDiff((v) => !v)} />
            Highlight changes on the board <kbd>Shift+D</kbd>
          </label>
          <p className="muted">
            Compares with <strong>{refName}</strong>. To export a diff, open the Timeline, pick points and press Export diff.
          </p>
          <div className="diffmenu-actions">
            <button className="primary" title="Save the board as it is now as a track point; Diff then shows changes from here" onClick={startTrack}>
              Start track
            </button>
            <button className="textbtn" onClick={() => setPopover('timeline')}>
              Timeline ({points.length})
            </button>
          </div>
        </div>
      )}
      {popover === 'timeline' && (
        <TimelinePanel points={points} now={doc} onClose={() => setPopover(null)} onTrack={startTrack} onDelete={deletePoint} onRename={renamePoint} onExport={exportDiff} />
      )}

      {searchOpen && (
        <div ref={searchPanelRef} className="chrome searchpanel" role="search" data-shown={shownQuery} onPointerDown={(e) => e.stopPropagation()}>
          <div className="searchrow">
            <span className="searchicon" aria-hidden="true">
              <Icons.search />
            </span>
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder="Find on the board"
              aria-label="Find on the board"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  stepHit(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
              }}
            />
            <span className="searchcount" aria-live="polite">
              {!query.trim() ? '' : !flatHits.length ? 'No matches' : hitIndex < 0 ? `${flatHits.length} found` : `${hitIndex + 1} of ${flatHits.length}`}
            </span>
            <button className="iconbtn small" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!flatHits.length} onClick={() => stepHit(-1)}>
              ↑
            </button>
            <button className="iconbtn small" aria-label="Next match" title="Next (Enter)" disabled={!flatHits.length} onClick={() => stepHit(1)}>
              ↓
            </button>
            <button className="iconbtn small" aria-label="Close search" title="Close (Esc)" onClick={closeSearch}>
              ×
            </button>
          </div>
          {flatHits.length > 0 && (
            <div className="searchlist" ref={searchListRef}>
              {(() => {
                let i = 0
                const limit = showAllHits || hitIndex >= LIST_ROWS ? Infinity : LIST_ROWS
                return hitGroups.map((g) => {
                  if (i >= limit) return null
                  return (
                  <div className="searchgroup" key={g.section ?? '-'}>
                    <div className="searchgroup-title">
                      {g.title} <span className="muted">{g.hits.length}</span>
                    </div>
                    {g.hits.map((h) => {
                      if (i >= limit) return null
                      const k = i++
                      const firstLine = h.text.split('\n').find((l) => l.trim())?.trim() ?? ''
                      const inFirst = h.ranges[0][1] <= h.text.indexOf(firstLine) + firstLine.length
                      return (
                        <button
                          key={h.id}
                          data-hit={k}
                          className={`searchhit${k === hitIndex ? ' on' : ''}`}
                          onClick={() => {
                            setHitIndex(k)
                            goToHit(h)
                          }}
                        >
                          <span className="kind">{h.kind === 'section' ? 'Section' : h.kind === 'label' ? 'Label' : ''}</span>
                          {!inFirst && <span className="first">{firstLine.length > 70 ? `${firstLine.slice(0, 68)}…` : firstLine}</span>}
                          <span className="snip">
                            {snippet(h).map((p, j) => (p.hit ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  )
                })
              })()}
              {!showAllHits && hitIndex < LIST_ROWS && flatHits.length > LIST_ROWS && (
                <button className="searchmore textbtn" onClick={() => setShowAllHits(true)}>
                  Show all {flatHits.length}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom right: zoom */}
      <div className={`chrome zoombar${compact && !barOpen ? ' collapsed' : ''}`}>
        <button className="iconbtn zoomstep" aria-label="Zoom out" title={`Zoom out (${MOD}+−)`} onClick={() => zoomAt(0.8)}>
          −
        </button>
        <button className="zoomlabel keep" title="Reset to 100% (Shift+0)" onClick={() => zoomAt(1 / zoom)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="iconbtn zoomstep" aria-label="Zoom in" title={`Zoom in (${MOD}+=)`} onClick={() => zoomAt(1.25)}>
          +
        </button>
        <button
          className={`iconbtn${physics ? ' on' : ''}`}
          aria-label="Physics"
          aria-pressed={physics}
          title={physics ? 'Physics on: shapes pull and push like a graph (Shift+P to stop)' : 'Physics: let shapes pull and push like a graph (Shift+P)'}
          onClick={togglePhysics}
        >
          <Icons.physics />
        </button>
        <button className="iconbtn" aria-label="Tidy up" title="Tidy up: rearrange into a neat flowchart (Shift+T)" onClick={tidy}>
          <Icons.tidy />
        </button>
        <span className="sep" />
        <button
          className={`textbtn barbtn${showDiff || popover === 'diff' ? ' on' : ''}`}
          aria-expanded={popover === 'diff'}
          title="Diff: highlight changes since a track point, start a track, or open the timeline"
          onClick={() => setPopover(popover === 'diff' ? null : 'diff')}
        >
          Diff
        </button>
        <button
          className={`textbtn barbtn${showFlow ? ' on' : ''}`}
          aria-pressed={showFlow}
          title="Flow: moving dots show which way each connector points (Shift+F)"
          onClick={toggleFlow}
        >
          Flow
        </button>
        <span className="sep" />
        <button className={`iconbtn keep${searchOpen ? ' on' : ''}`} aria-label="Find on the board" aria-pressed={searchOpen} title={`Find on the board (${MOD}+F)`} onClick={() => (searchOpen ? closeSearch() : openSearch())}>
          <Icons.search />
        </button>
        <button className="iconbtn keep" aria-label="Zoom to fit" title="Zoom to fit (Shift+1)" onClick={() => fitView()}>
          <Icons.fit />
        </button>
        <button className="iconbtn" aria-label={coarse ? 'Help' : 'Keyboard shortcuts'} title={coarse ? 'Help: touch gestures and shortcuts' : 'Keyboard shortcuts (?)'} onClick={() => setPopover(popover === 'help' ? null : 'help')}>
          <Icons.help />
        </button>
        {compact && (
          <button className={`iconbtn keep more${!barOpen && (showDiff || showFlow || physics) ? ' on' : ''}`} aria-label={barOpen ? 'Fewer tools' : 'More tools'} aria-expanded={barOpen} title={barOpen ? 'Fewer tools' : 'More tools'} onClick={() => setBarOpen(!barOpen)}>
            {barOpen ? '›' : '⋯'}
          </button>
        )}
      </div>
      {multi && (
        <div className="chrome multichip" role="status">
          Tap shapes to add or remove them
          <button className="textbtn" onClick={() => setMulti(false)}>
            Done
          </button>
        </div>
      )}

      {sheet && (
        <>
          <div className="chrome sheet-backdrop" onPointerDown={() => setSheet(null)} />
          <div
            className={`chrome pop menu sheet${compact ? ' bottom' : ''}`}
            role="menu"
            style={compact ? undefined : { left: Math.min(sheet.x, window.innerWidth - 240), top: Math.min(sheet.y, window.innerHeight - 360) }}
          >
            {sheetItems().map((it, i) =>
              it === '-' ? (
                <hr key={i} />
              ) : (
                <button
                  key={it.label}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setSheet(null)
                    it.run()
                  }}
                >
                  {it.label}
                </button>
              ),
            )}
          </div>
        </>
      )}

      {popover === 'help' && <HelpPanel touch={coarse} onClose={() => setPopover(null)} />}
      {popover === 'workspace' && (
        <WorkspacePanel
          supported={workspaceSupported()}
          folder={wsDir?.name ?? null}
          access={wsAccess}
          files={wsFiles}
          current={currentFile?.path ?? null}
          onChoose={chooseWorkspace}
          onAllow={allowWorkspace}
          onOpen={openFromWorkspace}
          onSave={() => void saveWorkspace()}
          onSaveAs={() => void saveAs()}
          onRefresh={() => wsDir && refreshFiles(wsDir)}
          onClose={() => setPopover(null)}
          recent={wsRecent.map((r) => ({ name: r.dir.name, current: r.current }))}
          onSwitch={(i) => void switchWorkspace(wsRecent[i].dir)}
          onForget={(i) => void forgetRecent(wsRecent[i].dir).then(() => refreshRecent(wsDir))}
        />
      )}
      {exportScope && (
        <ExportPanel
          title={title}
          hasSelection={selection.length > 0}
          diffCount={diffSource?.ids.size ?? 0}
          diffFrom={diffSource?.label ?? ''}
          initialScope={exportScope}
          build={buildExport}
          buildMd={buildMd}
          onClose={() => {
            setExportScope(null)
            setDiffSource(null)
          }}
          flash={flash}
          saveFile={exportToWorkspace}
          buildHtml={buildHtml}
          workspace={wsDir?.name ?? null}
        />
      )}
      {diffSource && (
        <svg className="offscreen" aria-hidden="true" width="1" height="1">
          <g ref={sourceRef}>
            <SvgDefs />
            {drawOrder(diffSource.doc.nodes).map((n) => (
              <ShapeView key={n.id} n={n} />
            ))}
            {(() => {
              const nm = new Map(diffSource.doc.nodes.map((n) => [n.id, n]))
              const tr = bundleTrunks(diffSource.doc.edges, nm)
              return diffSource.doc.edges.map((e) => <EdgeView key={e.id} e={e} nodes={nm} trunk={tr.get(e.id)} />)
            })()}
          </g>
        </svg>
      )}
      {toast && <div className="chrome toast" role="status">{toast}</div>}
    </div>
  )
}

function ToolButton({
  label,
  hint,
  on,
  onClick,
  children,
}: {
  label: string
  hint: string
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button className={`toolbtn${on ? ' on' : ''}`} title={`${label} (${hint})`} aria-label={label} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  )
}

function EdgeLabelEditor({
  e,
  nodes,
  view,
  text,
  onChange,
  onDone,
}: {
  e: EdgeEl
  nodes: Map<string, NodeEl>
  view: View
  text: string
  onChange: (t: string) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    el.select()
  }, [])
  const z = view.zoom
  const mid = edgeGeometry(e, nodes).mid
  const lh = lineHeight(LABEL_FONT)
  const lines = text.split('\n')
  const w = Math.max(...lines.map((l) => measure(l, LABEL_FONT)), 60) + 24
  const h = lines.length * lh + 8
  return (
    <textarea
      ref={ref}
      id="edge-label"
      className="editor label"
      value={text}
      placeholder="Label"
      spellCheck={false}
      onChange={(ev) => onChange(ev.target.value)}
      onBlur={onDone}
      onKeyDown={(ev) => {
        ev.stopPropagation()
        if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) {
          ev.preventDefault()
          onDone()
        }
      }}
      style={{
        left: (mid.x - w / 2) * z + view.x,
        top: (mid.y - h / 2) * z + view.y,
        width: w * z,
        height: h * z,
        paddingTop: 4 * z,
        fontSize: LABEL_FONT * z,
        lineHeight: `${lh * z}px`,
      }}
    />
  )
}

const SHORTCUTS: [string, string][] = [
  ['V', 'Select'],
  ['H or hold Space', 'Pan the canvas'],
  ['R / O / D', 'Rectangle, ellipse, diamond'],
  ['S / T / X', 'Sticky note, text, connector'],
  ['Shift + I', 'Upload an image (or paste / drop one)'],
  ['Double-click', 'Edit text, or add text on empty canvas'],
  ['Enter', 'Edit the selected shape or line label'],
  ['Drag a blue dot', 'Draw a connector; let go on empty canvas to add a new shape there'],
  ['Shift+P', 'Physics on/off: connected shapes pull together, others push apart'],
  ['Shift+T', 'Tidy up into a neat flowchart'],
  ['Shift+D', 'Diff view: highlight changes since the file was opened or saved'],
  ['Shift+F', 'Flow view: moving dots show which way each connector points'],
  ['Drag a connector handle', 'Slide one piece of an elbow connector'],
  ['Click a blue dot', 'Add a connected next step'],
  [`${MOD}+Shift+K while editing`, 'Make selected words a link point; drag its dot to connect'],
  ['/ while editing', 'Insert a link already on the board; it connects to every other copy of that link'],
  ['Alt + drag', 'Duplicate while moving'],
  ['Shift + click', 'Edit a shape\'s text (or a connector\'s label) straight away'],
  [`${MOD} + click`, 'Add to or remove from the selection'],
  ['Shift + drag', 'Lock axis, or keep proportions when resizing'],
  [`${MOD} + Z / ${MOD} + Shift + Z`, 'Undo / redo'],
  [`${MOD} + C / X / V / D`, 'Copy, cut, paste, duplicate'],
  [`${MOD} + A`, 'Select all'],
  [`${MOD} + F`, 'Find on the board; Enter / Shift+Enter step through the matches, Esc closes'],
  [`${MOD} + S / ${MOD} + Shift + S`, 'Save to the workspace folder / save as'],
  [`${MOD} + Alt + G`, 'Wrap selection in a new section'],
  ['Shift + S', 'Section tool'],
  [`${MOD} + B / I / U`, 'Bold, italic, underline while editing text'],
  [`${MOD} + Shift + X`, 'Strikethrough while editing text'],
  [`${MOD} + Shift + 7 / 8`, 'Numbered / bulleted list while editing text'],
  [`${MOD} + Shift + E`, 'Export (PNG, JPG, SVG, PDF)'],
  [`${MOD} + Shift + C`, 'Copy selection as PNG'],
  ['Delete', 'Delete selection'],
  ['Arrow keys', 'Nudge (Shift for 10px)'],
  ['] / [', 'Bring to front / send to back'],
  [`Scroll / ${MOD} + scroll`, 'Pan / zoom'],
  ['Shift + 1 / Shift + 0', 'Zoom to fit / 100%'],
  ['Shift + J', 'Go to the other end of the selected connector'],
]

const GESTURES: [string, string][] = [
  ['Drag with one finger', 'Pan the canvas, or move a shape'],
  ['Pinch', 'Zoom (two fingers also pan)'],
  ['Tap', 'Select; tap a blue dot to add a connected step'],
  ['Double-tap', 'Edit text, or add text on empty canvas'],
  ['Hold', 'Menu: edit, duplicate, delete, select several or an area, paste'],
  ['Drag a blue dot', 'Draw a connector'],
]

function HelpPanel({ onClose, touch }: { onClose: () => void; touch: boolean }) {
  return (
    <div className="chrome help" role="dialog" aria-label={touch ? 'Help' : 'Keyboard shortcuts'}>
      {touch && (
        <>
          <div className="help-head">
            <strong>Touch</strong>
            <button className="textbtn" onClick={onClose}>
              Close
            </button>
          </div>
          <dl>
            {GESTURES.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="help-head">
        <strong>{touch ? 'With a keyboard' : 'Shortcuts'}</strong>
        {!touch && (
          <button className="textbtn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <dl>
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="help-credit">
        Flowboard by Kimngoun Peou ·{' '}
        <a href="https://github.com/kashihashi95/flowboard" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>{' '}
        · MIT License
      </p>
    </div>
  )
}

function SectionTitleEditor({ n, view, text, onChange, onDone }: { n: NodeEl; view: View; text: string; onChange: (t: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const z = view.zoom
  const r = sectionTitleRect(n)
  return (
    <input
      ref={ref}
      id="section-name"
      className="section-editor"
      aria-label="Section name"
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' || e.key === 'Escape') onDone()
      }}
      style={{
        left: r.x * z + view.x,
        top: r.y * z + view.y,
        width: Math.max(r.w, 200) * z,
        height: r.h * z,
        fontSize: SECTION_TITLE_SIZE * z,
        paddingLeft: 10 * z,
      }}
    />
  )
}
