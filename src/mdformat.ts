import { autoLayout, containingSections, type Direction } from './layout'
import { routeEdges } from './route'
import { autoSize, paragraphsOf, withParagraphs } from './richtext'
import { DEFAULT_SIZE, makeEdge, makeNode } from './store'
import {
  ARROW_HEADS,
  PALETTE,
  type ArrowHead,
  type ColorKey,
  type Doc,
  type EdgeEl,
  type EdgeEnd,
  type NodeEl,
  type Paragraph,
  type Route,
  type ShapeKind,
  type Side,
  type TextAlign,
  type TextRun,
} from './types'

/** Flowboard Markdown: a plain-text form of a board that people can write by
 *  hand (or have an assistant write) and that Flowboard reads and writes.
 *  The guide in FLOWBOARD-MARKDOWN.md describes it for people. */

// ---------- vocabulary ----------

export const KIND_NAMES: Record<string, ShapeKind> = {
  process: 'rect',
  rect: 'rect',
  rectangle: 'rect',
  box: 'rect',
  terminal: 'rounded',
  rounded: 'rounded',
  pill: 'rounded',
  start: 'rounded',
  end: 'rounded',
  decision: 'diamond',
  diamond: 'diamond',
  ellipse: 'ellipse',
  circle: 'ellipse',
  oval: 'ellipse',
  io: 'parallelogram',
  'input/output': 'parallelogram',
  parallelogram: 'parallelogram',
  data: 'parallelogram',
  database: 'cylinder',
  cylinder: 'cylinder',
  db: 'cylinder',
  preparation: 'hexagon',
  hexagon: 'hexagon',
  sticky: 'sticky',
  note: 'sticky',
  text: 'text',
  label: 'text',
  image: 'image',
  picture: 'image',
}

const KIND_OUT: Record<ShapeKind, string> = {
  rect: 'process',
  rounded: 'terminal',
  diamond: 'decision',
  ellipse: 'ellipse',
  parallelogram: 'io',
  cylinder: 'database',
  hexagon: 'preparation',
  sticky: 'sticky',
  text: 'text',
  image: 'image',
  section: 'section',
}

const COLOR_ALIASES: Record<string, ColorKey> = { default: 'ink', none: 'ink', grey: 'gray', purple: 'violet', white: 'ink' }
const toColor = (v: string | undefined): ColorKey | undefined => {
  if (!v) return undefined
  const k = v.toLowerCase()
  if (k in PALETTE) return k as ColorKey
  return COLOR_ALIASES[k]
}
const HEAD_NAMES = new Set(ARROW_HEADS.map((h) => h.value))
const toHead = (v: string | undefined): ArrowHead | undefined => (v && HEAD_NAMES.has(v as ArrowHead) ? (v as ArrowHead) : undefined)
const SIDES = new Set(['top', 'right', 'bottom', 'left'])
const ROUTES = new Set(['elbow', 'straight', 'curved'])

/** Arrows, longest first so `<-->` wins over `-->`. */
const ARROWS: { token: string; start: boolean; end: boolean; dashed: boolean; thick: boolean }[] = [
  { token: '<-.->', start: true, end: true, dashed: true, thick: false },
  { token: '<-->', start: true, end: true, dashed: false, thick: false },
  { token: '<==>', start: true, end: true, dashed: false, thick: true },
  { token: '<-.-', start: true, end: false, dashed: true, thick: false },
  { token: '-.->', start: false, end: true, dashed: true, thick: false },
  { token: '-.-', start: false, end: false, dashed: true, thick: false },
  { token: '-->', start: false, end: true, dashed: false, thick: false },
  { token: '<--', start: true, end: false, dashed: false, thick: false },
  { token: '---', start: false, end: false, dashed: false, thick: false },
  { token: '==>', start: false, end: true, dashed: false, thick: true },
  { token: '<==', start: true, end: false, dashed: false, thick: true },
  { token: '===', start: false, end: false, dashed: false, thick: true },
]

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** The link points of a shape in reading order: each highlighted phrase, its
 *  id, and which occurrence of that wording it is (1 for the first). */
export function linkGroups(paras: Paragraph[]): { id: string; phrase: string; nth: number }[] {
  const out: { id: string; phrase: string; nth: number }[] = []
  const seen = new Map<string, number>()
  for (const p of paras) {
    for (let i = 0; i < p.runs.length; ) {
      const id = p.runs[i].link
      let j = i
      while (j < p.runs.length && p.runs[j].link === id) j++
      if (id) {
        const phrase = p.runs.slice(i, j).map((r) => r.text).join('')
        const key = slug(phrase)
        const nth = (seen.get(key) ?? 0) + 1
        seen.set(key, nth)
        out.push({ id, phrase, nth })
      }
      i = j
    }
  }
  return out
}

/** Give every highlighted phrase in a shape its own id, so the same wording
 *  highlighted twice makes two link points ("phrase", then "phrase-2"). */
function uniqueLinks(paras: Paragraph[]): Paragraph[] {
  const seen = new Map<string, number>()
  return paras.map((p) => {
    const runs = p.runs.map((r) => ({ ...r }))
    for (let i = 0; i < runs.length; ) {
      const old = runs[i].link
      let j = i
      while (j < runs.length && runs[j].link === old) j++
      if (old) {
        const base = slug(runs.slice(i, j).map((r) => r.text).join('')) || 'link'
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        for (let k = i; k < j; k++) runs[k].link = n === 1 ? base : `${base}-${n}`
      }
      i = j
    }
    return { ...p, runs }
  })
}

/** Highlight the first plain (not yet highlighted) occurrence of a phrase in
 *  a shape, so a connection can name words that weren't marked with ==...==. */
function markPhrase(paras: Paragraph[], phrase: string): Paragraph[] | null {
  const want = phrase.trim().toLowerCase()
  if (!want) return null
  for (let pi = 0; pi < paras.length; pi++) {
    const runs = paras[pi].runs
    const text = runs.map((r) => r.text).join('')
    let from = 0
    for (let at = text.toLowerCase().indexOf(want, from); at >= 0; at = text.toLowerCase().indexOf(want, from)) {
      from = at + 1
      const end = at + want.length
      // Split runs at the phrase's edges, then mark the runs inside it.
      const out: TextRun[] = []
      let pos = 0
      let clash = false
      for (const r of runs) {
        const a = pos
        const b = pos + r.text.length
        pos = b
        const cuts = [a, Math.min(Math.max(at, a), b), Math.min(Math.max(end, a), b), b]
        for (let c = 0; c < 3; c++) {
          if (cuts[c + 1] <= cuts[c]) continue
          const piece: TextRun = { ...r, text: r.text.slice(cuts[c] - a, cuts[c + 1] - a) }
          if (c === 1) {
            if (r.link) clash = true
            piece.link = '?'
          }
          out.push(piece)
        }
      }
      if (clash) continue
      const next = paras.map((p, i) => (i === pi ? { ...p, runs: out } : p))
      return uniqueLinks(next)
    }
  }
  return null
}

// ---------- attributes: {#id key=value flag key="quoted value"} ----------

type Attrs = { id?: string; [k: string]: string | undefined }

function parseAttrs(src: string): Attrs {
  const out: Attrs = {}
  for (const m of src.matchAll(/#([^\s}]+)|([\w-]+)\s*=\s*("([^"]*)"|[^\s}]+)|([\w-]+)/g)) {
    if (m[1]) out.id = m[1]
    else if (m[2]) out[m[2].toLowerCase()] = m[4] ?? m[3]
    else if (m[5]) out[m[5].toLowerCase()] = 'true'
  }
  return out
}

/** Split a trailing `{...}` attribute block off a line. */
function splitAttrs(line: string): { text: string; attrs: Attrs } {
  const m = line.match(/^(.*?)\s*(?<!\\)\{([^{}]*)\}\s*$/)
  if (!m) return { text: line, attrs: {} }
  return { text: m[1], attrs: parseAttrs(m[2]) }
}

const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
const pair = (v: string | undefined, sep: RegExp) => {
  const parts = v?.split(sep).map((s) => Number(s.trim()))
  return parts && parts.length === 2 && parts.every(Number.isFinite) ? (parts as [number, number]) : undefined
}

// ---------- inline text ----------

/** `**bold**`, `*italic*`, `~~strike~~`, `<u>underline</u>`,
 *  `<span style="color:#e03e2d">color</span>`, and `==link point==`. */
export function parseInline(src: string): TextRun[] {
  const runs: TextRun[] = []
  let bold = false
  let italic = false
  let strike = false
  let underline = false
  const colors: string[] = []
  let linkStart: number | null = null
  let buf = ''
  const flush = () => {
    if (!buf) return
    const r: TextRun = { text: buf }
    if (bold) r.bold = true
    if (italic) r.italic = true
    if (strike) r.strike = true
    if (underline) r.underline = true
    if (colors.length) r.color = colors[colors.length - 1]
    if (linkStart !== null) r.link = '?'
    runs.push(r)
    buf = ''
  }
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i)
    if (rest[0] === '\\' && rest.length > 1) {
      buf += rest[1]
      i += 2
      continue
    }
    let m: RegExpMatchArray | null
    if (rest.startsWith('**')) {
      flush()
      bold = !bold
      i += 2
    } else if (rest.startsWith('~~')) {
      flush()
      strike = !strike
      i += 2
    } else if (rest.startsWith('==')) {
      flush()
      if (linkStart === null) linkStart = runs.length
      else {
        const phrase = runs.slice(linkStart).map((r) => r.text).join('')
        for (const r of runs.slice(linkStart)) r.link = slug(phrase) || 'link'
        linkStart = null
      }
      i += 2
    } else if (rest[0] === '*') {
      flush()
      italic = !italic
      i += 1
    } else if ((m = rest.match(/^<u>/i))) {
      flush()
      underline = true
      i += m[0].length
    } else if ((m = rest.match(/^<\/u>/i))) {
      flush()
      underline = false
      i += m[0].length
    } else if ((m = rest.match(/^<span\s+style\s*=\s*["']\s*color\s*:\s*([^"';]+);?\s*["']\s*>/i))) {
      flush()
      colors.push(m[1].trim())
      i += m[0].length
    } else if ((m = rest.match(/^<\/span>/i))) {
      flush()
      colors.pop()
      i += m[0].length
    } else {
      buf += rest[0]
      i += 1
    }
  }
  flush()
  // An unclosed ==: treat as plain text.
  if (linkStart !== null) for (const r of runs.slice(linkStart)) delete r.link
  return runs
}

const escapeText = (s: string) => s.replace(/([\\*~=<{}[\]])/g, '\\$1')

function inlineOut(runs: TextRun[]): string {
  let out = ''
  for (let i = 0; i < runs.length; ) {
    const link = runs[i].link
    let j = i
    while (j < runs.length && runs[j].link === link) j++
    const group = runs.slice(i, j).map((r) => {
      let t = escapeText(r.text)
      if (r.italic) t = `*${t}*`
      if (r.bold) t = `**${t}**`
      if (r.strike) t = `~~${t}~~`
      if (r.underline) t = `<u>${t}</u>`
      if (r.color) t = `<span style="color:${r.color}">${t}</span>`
      return t
    })
    out += link ? `==${group.join('')}==` : group.join('')
    i = j
  }
  return out
}

// ---------- reading ----------

export interface ParseResult {
  doc: Doc
  title?: string
  warnings: string[]
}

interface RawNode {
  node: NodeEl
  lines: string[]
  firstText: string
  attrs: Attrs
  section?: string
}

/** Read a Flowboard Markdown document. Returns null when it holds no shapes or connections. */
export function parseFlowboardMarkdown(text: string): ParseResult | null {
  const warnings: string[] = []
  let src = text.replace(/\r\n?/g, '\n')
  let title: string | undefined
  let direction: Direction = 'down'

  // Front matter.
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/)
      if (!m) continue
      const v = m[2].replace(/^["']|["']$/g, '')
      if (m[1] === 'title') title = v
      if (m[1] === 'layout' || m[1] === 'direction') direction = /^(right|lr|horizontal)$/i.test(v) ? 'right' : 'down'
    }
    src = src.slice(fm[0].length)
  }

  const lines = src.split('\n')
  const raws: RawNode[] = []
  const connections: { line: string; at: number }[] = []
  const sectionStack: { level: number; id: string }[] = []
  const parent = new Map<string, string>()
  let mode: 'shapes' | 'connections' = 'shapes'
  let current: RawNode | null = null
  let fence: string | null = null
  let comment = false

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Code blocks (like the Mermaid preview) and HTML comments are skipped.
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null
      continue
    }
    const f = line.match(/^\s*(```+|~~~+)/)
    if (f) {
      fence = f[1]
      current = null
      continue
    }
    if (comment) {
      if (line.includes('-->')) comment = false
      continue
    }
    if (/^\s*<!--/.test(line) && !/-->\s*$/.test(line)) {
      comment = true
      continue
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      current = null
      const level = h[1].length
      const { text: heading, attrs } = splitAttrs(h[2].trim())
      while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level) sectionStack.pop()
      const sec = heading.match(/^section\s*:\s*(.*)$/i)
      if (/^(connections|connectors|arrows|links)$/i.test(heading)) {
        mode = 'connections'
      } else if (sec) {
        mode = 'shapes'
        const node = makeNode('section', 0, 0, undefined, undefined, { text: sec[1].trim() || 'Section' })
        const raw: RawNode = { node, lines: [], firstText: '', attrs, section: sectionStack[sectionStack.length - 1]?.id }
        raws.push(raw)
        if (raw.section) parent.set(node.id, raw.section)
        sectionStack.push({ level, id: node.id })
      } else {
        mode = 'shapes'
        if (level === 1 && !title) title = heading
      }
      continue
    }

    const item = line.match(/^([-*+])\s+(.*)$/)
    if (mode === 'connections') {
      if (item) connections.push({ line: item[2], at: li + 1 })
      continue
    }
    if (item) {
      let rest = item[2]
      let kind: ShapeKind = 'rect'
      const k = rest.match(/^\[([^\]]+)\]\s*/)
      if (k && KIND_NAMES[k[1].trim().toLowerCase()]) {
        kind = KIND_NAMES[k[1].trim().toLowerCase()]
        rest = rest.slice(k[0].length)
      }
      const { text: firstText, attrs } = splitAttrs(rest)
      const node = makeNode(kind, 0, 0)
      current = { node, lines: [], firstText, attrs, section: sectionStack[sectionStack.length - 1]?.id }
      if (current.section) parent.set(node.id, current.section)
      raws.push(current)
      continue
    }
    if (current && (/^( {2,}|\t)/.test(line) || line.trim() === '')) {
      current.lines.push(line.replace(/^( {2,4}|\t)/, ''))
      continue
    }
    // Anything else (plain paragraphs) is a note for people and is ignored.
    current = null
  }

  // ---- build shapes ----
  const nodes: NodeEl[] = []
  const ids = new Map<string, NodeEl>()
  const auto = new Set<string>()
  for (const raw of raws) {
    let n = raw.node
    const a = raw.attrs
    const color = toColor(a.color)
    if (a.color && !color) warnings.push(`Unknown color "${a.color}"`)
    if (color) n = { ...n, color }
    const font = num(a.font ?? a['font-size'] ?? a.textsize)
    if (font) n = { ...n, fontSize: Math.min(Math.max(font, 1), 1000) }
    else if (n.kind === 'text') n = { ...n, fontSize: 20 }
    const outline = a.outline === 'none' ? 'none' : toColor(a.outline)
    if (outline) n = { ...n, outline }
    const ow = num(a['outline-width'])
    if (ow) n = { ...n, outlineWidth: ow }
    if (a['outline-dashed'] === 'true' || a.dashed === 'true') n = { ...n, outlineDashed: true }
    if (a.fixed === 'true') n = { ...n, fixedSize: true }
    if (n.kind === 'image') {
      const img = raw.firstText.match(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/)
      const src = a.src ?? img?.[1]
      if (src) n = { ...n, src }
      else warnings.push('An image has no picture; use ![](url or data URL)')
    } else if (n.kind !== 'section') {
      n = withParagraphs(n, paragraphsFrom(raw, defaultAlignFor(a.align)))
    }
    const size = pair(a.size, /[x×,]/i)
    const at = pair(a.at ?? a.pos ?? a.position, /,/)
    if (size) n = { ...n, w: Math.max(size[0], 4), h: Math.max(size[1], 4) }
    else if (n.kind !== 'image' && n.kind !== 'section') n = fitWidth(n)
    if (at) n = { ...n, x: at[0], y: at[1] }
    else auto.add(n.id)
    if (a.id) {
      if (ids.has(a.id)) warnings.push(`The id #${a.id} is used twice`)
      ids.set(a.id, n)
    }
    nodes.push(n)
  }

  for (let i = 0; i < nodes.length; i++) {
    const paras = paragraphsOf(nodes[i])
    // In place: the id lookups below hold these same objects.
    if (paras.some((p) => p.runs.some((r) => r.link))) nodes[i].rich = uniqueLinks(paras)
  }

  // ---- connections ----
  const edges: EdgeEl[] = []
  const byText = (ref: string) => {
    const want = ref.trim().toLowerCase()
    return nodes.find((n) => n.kind !== 'section' && n.text.replace(/\s*\n\s*/g, ' ').trim().toLowerCase() === want)
  }
  const endpoint = (src: string, at: number): EdgeEnd | null => {
    const s = src.trim()
    const free = s.match(/^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/)
    if (free) return { x: Number(free[1]), y: Number(free[2]) }
    const m = s.match(/^(.*?)(?:\s*\[([^\]]+)\])?(?::(top|right|bottom|left)(?:\s*@\s*([\d.]+)\s*%)?)?$/)
    if (!m || !m[1].trim()) {
      warnings.push(`Line ${at}: couldn't read "${s}"`)
      return null
    }
    const ref = m[1].trim()
    let n = ref.startsWith('#') ? ids.get(ref.slice(1)) : (ids.get(ref) ?? byText(ref))
    if (!n) {
      // Naming a step that isn't listed creates it, like in Mermaid.
      // A question becomes a decision diamond.
      const created = fitWidth(withParagraphs(makeNode(/\?\s*$/.test(ref) ? 'diamond' : 'rect', 0, 0), parseInline(ref.replace(/^#/, '')).length ? [{ runs: parseInline(ref.replace(/^#/, '')) }] : [{ runs: [] }]))
      nodes.push(created)
      auto.add(created.id)
      ids.set(ref.replace(/^#/, ''), created)
      n = created
    }
    const end: EdgeEnd = { nodeId: n.id, x: 0, y: 0 }
    if (m[3] && SIDES.has(m[3])) end.side = m[3] as Side
    if (end.side && m[4] && Number.isFinite(Number(m[4]))) end.at = Math.min(Math.max(Math.round(Number(m[4]) * 10) / 1000, 0), 1)
    if (m[2]) {
      // [phrase], [==phrase==], or [phrase #2] for the second time that wording is highlighted.
      const pm = m[2].trim().match(/^(?:==)?(.*?)(?:==)?(?:\s+#(\d+))?$/)!
      const phrase = pm[1].trim()
      const nth = Number(pm[2] ?? 1)
      const find = (node: NodeEl) => linkGroups(paragraphsOf(node)).find((g) => slug(g.phrase) === slug(phrase) && g.nth === nth)
      let hit = find(n)
      if (!hit && nth === 1) {
        const marked = markPhrase(paragraphsOf(n), phrase)
        if (marked) {
          n.rich = marked
          hit = find(n)
        }
      }
      if (hit) end.textId = hit.id
      else warnings.push(`Line ${at}: couldn't find the words "${phrase}" in that shape, so the connector attaches to the whole shape`)
    }
    return end
  }
  for (const { line, at } of connections) {
    const { text, attrs } = splitAttrs(line)
    let arrow: (typeof ARROWS)[number] | undefined
    let idx = -1
    for (const a of ARROWS) {
      const i = text.indexOf(` ${a.token} `)
      if (i >= 0 && (idx < 0 || i < idx || (i === idx && a.token.length > arrow!.token.length))) {
        idx = i
        arrow = a
      }
    }
    if (!arrow || idx < 0) {
      warnings.push(`Line ${at}: no arrow found (use -->, ---, <-->, -.-> …)`)
      continue
    }
    const left = text.slice(0, idx)
    let right = text.slice(idx + arrow.token.length + 2)
    let label = attrs.label ?? ''
    const lm = right.match(/^(.*?)\s+:\s+(.*)$/)
    if (lm) {
      right = lm[1]
      label = lm[2]
    }
    const from = endpoint(left, at)
    const to = endpoint(right, at)
    if (!from || !to) continue
    const route = attrs.route && ROUTES.has(attrs.route) ? (attrs.route as Route) : 'elbow'
    // A hand-adjusted elbow route: points=x,y;x,y;…
    const points = attrs.points
      ?.split(';')
      .map((s) => pair(s, /,/))
      .filter((q): q is [number, number] => !!q)
      .map(([x, y]) => ({ x, y }))
    const color = toColor(attrs.color) ?? 'ink'
    const labelAt = attrs['label-at'] !== undefined ? Math.round(Number(attrs['label-at'].replace('%', '')) * 10) / 1000 : NaN
    edges.push(
      makeEdge(from, to, {
        route,
        color,
        width: num(attrs.width) ?? (arrow.thick ? 4 : 2),
        dashed: attrs.solid === 'true' ? false : attrs.dashed === 'true' || arrow.dashed,
        startHead: toHead(attrs.start) ?? (arrow.start ? 'triangle' : 'none'),
        endHead: toHead(attrs.end) ?? (arrow.end ? 'triangle' : 'none'),
        label: label.replace(/<br\s*\/?>/gi, '\n').replace(/\\(.)/g, '$1').trim(),
        ...(points?.length && route === 'elbow' ? { points } : {}),
        ...(Number.isFinite(labelAt) ? { labelAt: Math.min(Math.max(labelAt, 0), 1) } : {}),
      }),
    )
  }

  if (!nodes.length && !edges.length) return null
  let doc: Doc = { nodes, edges }
  if (auto.size) doc = autoLayout(doc, auto, parent, direction)
  // Laid out from scratch: route the connectors around the shapes too.
  // (Sides written in the file stay as written.)
  if (auto.size === nodes.length) doc = routeEdges({ nodes: doc.nodes, edges }, direction)
  // Sections listed with a position but no size wrap what was written under them.
  doc = {
    ...doc,
    nodes: doc.nodes.map((n, i) => {
      const raw = raws[i]
      if (n.kind !== 'section' || !raw || raw.attrs.size || auto.has(n.id)) return n
      const kids = doc.nodes.filter((k) => parent.get(k.id) === n.id)
      if (!kids.length) return n
      const x2 = Math.max(...kids.map((k) => k.x + k.w)) + 40
      const y2 = Math.max(...kids.map((k) => k.y + k.h)) + 40
      return { ...n, w: Math.max(x2 - n.x, 120), h: Math.max(y2 - n.y, 80) }
    }),
  }
  return { doc, title, warnings }
}

const defaultAlignFor = (v: string | undefined): TextAlign | undefined => (v === 'left' || v === 'center' || v === 'right' ? v : undefined)

/** First line plus indented continuation lines, as paragraphs. */
function paragraphsFrom(raw: RawNode, align: TextAlign | undefined): Paragraph[] {
  const out: Paragraph[] = []
  const add = (line: string, list?: Paragraph['list']) => {
    const { text, attrs } = /\{\s*align\s*=/.test(line) ? splitAttrs(line) : { text: line, attrs: {} as Attrs }
    const p: Paragraph = { runs: text.trim() === '<br>' ? [] : parseInline(text) }
    if (list) p.list = list
    const a = defaultAlignFor(attrs.align) ?? align
    if (a) p.align = a
    out.push(p)
  }
  if (raw.firstText.trim()) add(raw.firstText.trim())
  const lines = [...raw.lines]
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  for (const l of lines) {
    if (!l.trim()) continue
    const b = l.match(/^\s*[-*+]\s+(.*)$/)
    const o = l.match(/^\s*\d+[.)]\s+(.*)$/)
    if (b) add(b[1], 'bullet')
    else if (o) add(o[1], 'number')
    else add(l.trim())
  }
  return out.length ? out : [{ runs: [] }]
}

/** Shapes written without a size get a width that suits their text, by the
 *  same rule the editor uses as you type. */
function fitWidth(n: NodeEl): NodeEl {
  const base = DEFAULT_SIZE[n.kind]
  return autoSize({ ...n, w: base.w, h: base.h }, base)
}

// ---------- writing ----------

const r1 = (v: number) => Math.round(v)

/** The board as Flowboard Markdown, with exact positions and sizes. */
export function writeFlowboardMarkdown(doc: Doc, title: string, preface: string[] = []): string {
  // Readable, unique ids.
  const ids = new Map<string, string>()
  const used = new Set<string>()
  for (const n of doc.nodes) {
    // Short ids read better in connections: the first few words of the text.
    const words = (n.kind === 'section' ? n.text : n.text.split('\n')[0]).trim().split(/\s+/).slice(0, 4).join(' ')
    const base = slug(words) || KIND_OUT[n.kind]
    let id = base
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`
    used.add(id)
    ids.set(n.id, id)
  }
  const parent = containingSections(doc.nodes)

  const attrs = (n: NodeEl, extra: string[] = []) => {
    const a = [`#${ids.get(n.id)}`, ...extra]
    if (n.color !== 'ink') a.push(`color=${n.color}`)
    const defaultFont = n.kind === 'text' ? 20 : 16
    if (n.kind !== 'section' && n.kind !== 'image' && n.fontSize !== defaultFont) a.push(`font=${n.fontSize}`)
    if (n.outline) a.push(`outline=${n.outline}`)
    if (n.outlineWidth) a.push(`outline-width=${n.outlineWidth}`)
    if (n.outlineDashed) a.push('outline-dashed')
    if (n.fixedSize) a.push('fixed')
    a.push(`at=${r1(n.x)},${r1(n.y)}`, `size=${r1(n.w)}x${r1(n.h)}`)
    return `{${a.join(' ')}}`
  }

  const nodeLines = (n: NodeEl): string[] => {
    const kind = KIND_OUT[n.kind]
    if (n.kind === 'image') return [`- [image] ![](${n.src ?? ''}) ${attrs(n)}`]
    const paras = paragraphsOf(n)
    const aligns = new Set(paras.map((p) => p.align))
    const shared = aligns.size === 1 ? [...aligns][0] : undefined
    const extra = shared ? [`align=${shared}`] : []
    const simple = paras.length === 1 && !paras[0].list
    if (simple) return [`- [${kind}] ${inlineOut(paras[0].runs) || ''} ${attrs(n, extra)}`.replace(/\s+\{/, ' {')]
    const out = [`- [${kind}] ${attrs(n, extra)}`]
    let num = 0
    for (const p of paras) {
      num = p.list === 'number' ? num + 1 : 0
      let body = inlineOut(p.runs)
      if (!p.list && /^([-*+]\s|\d+[.)]\s|#|>)/.test(body)) body = `\\${body}`
      if (!body && !p.list) body = '<br>'
      const prefix = p.list === 'bullet' ? '- ' : p.list === 'number' ? `${num}. ` : ''
      const own = !shared && p.align ? ` {align=${p.align}}` : ''
      out.push(`  ${prefix}${body}${own}`)
    }
    return out
  }

  const lines: string[] = ['---', 'flowboard: 1', `title: ${JSON.stringify(title)}`, '---', '', `# ${title.trim() || 'Flowchart'}`, '', ...preface]
  const emit = (group: string | undefined, level: number) => {
    const members = doc.nodes.filter((n) => parent.get(n.id) === group)
    const shapes = members.filter((n) => n.kind !== 'section')
    if (shapes.length) {
      if (group === undefined) lines.push('## Shapes', '')
      for (const n of shapes) lines.push(...nodeLines(n))
      lines.push('')
    }
    for (const s of members.filter((n) => n.kind === 'section')) {
      lines.push(`${'#'.repeat(Math.min(level, 6))} Section: ${s.text.trim() || 'Section'} ${attrs(s)}`, '')
      emit(s.id, level + 1)
    }
  }
  emit(undefined, 2)

  if (doc.edges.length) {
    lines.push('## Connections', '')
    if (doc.edges.some((e) => e.from.textId || e.to.textId))
      lines.push('<!-- shape[words] attaches the connector to the ==highlighted words== inside that shape. -->', '')
    const nodeMap = new Map(doc.nodes.map((n) => [n.id, n]))
    const end = (e: EdgeEnd) => {
      if (!e.nodeId || !nodeMap.has(e.nodeId)) return `(${r1(e.x)}, ${r1(e.y)})`
      const n = nodeMap.get(e.nodeId)!
      let s = ids.get(e.nodeId)!
      if (e.textId) {
        const g = linkGroups(paragraphsOf(n)).find((x) => x.id === e.textId)
        if (g) s += `[${g.phrase}${g.nth > 1 ? ` #${g.nth}` : ''}]`
      }
      if (e.side) s += `:${e.side}${e.at !== undefined && !e.textId ? `@${Math.round(e.at * 1000) / 10}%` : ''}`
      return s
    }
    for (const e of doc.edges) {
      const dashed = e.dashed
      const both = e.startHead !== 'none' && e.endHead !== 'none'
      const startOnly = e.startHead !== 'none' && e.endHead === 'none'
      const endOnly = e.endHead !== 'none' && e.startHead === 'none'
      const token = dashed ? (both ? '<-.->' : startOnly ? '<-.-' : endOnly ? '-.->' : '-.-') : both ? '<-->' : startOnly ? '<--' : endOnly ? '-->' : '---'
      const a: string[] = []
      if (e.startHead !== 'none' && e.startHead !== 'triangle') a.push(`start=${e.startHead}`)
      if (e.endHead !== 'none' && e.endHead !== 'triangle') a.push(`end=${e.endHead}`)
      if (e.route !== 'elbow') a.push(`route=${e.route}`)
      if (e.color !== 'ink') a.push(`color=${e.color}`)
      if (e.width !== 2) a.push(`width=${e.width}`)
      if (e.labelAt !== undefined && e.label.trim()) a.push(`label-at=${Math.round(e.labelAt * 1000) / 10}%`)
      if (e.route === 'elbow' && e.points?.length) a.push(`points=${e.points.map((q) => `${r1(q.x)},${r1(q.y)}`).join(';')}`)
      const label = e.label.trim() ? ` : ${e.label.trim().replace(/\n/g, '<br>').replace(/([{}])/g, '\\$1')}` : ''
      lines.push(`- ${end(e.from)} ${token} ${end(e.to)}${label}${a.length ? ` {${a.join(' ')}}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
