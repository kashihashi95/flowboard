import { center, insideRect } from './geometry'
import { parseFlowboardMarkdown, writeFlowboardMarkdown } from './mdformat'
import { isDoc, normalizeDoc, withSectionContents } from './store'
import { PALETTE, SHAPE_LABELS, type Doc, type EdgeEl, type NodeEl } from './types'

/** Markdown files for Obsidian and similar apps: a Mermaid preview they draw,
 *  followed by the board in Flowboard Markdown (see mdformat.ts). */

const DATA_START = '<!-- flowboard:data'
const DATA_END = '-->'

// ---------- helpers ----------

const plain = (n: NodeEl) => n.text.trim()
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

function nodeName(n: NodeEl): string {
  if (n.kind === 'image') return 'Image'
  if (n.kind === 'section') return n.text.trim() || 'Section'
  return oneLine(plain(n)) || `Untitled ${SHAPE_LABELS[n.kind].toLowerCase()}`
}

// ---------- Mermaid ----------

const mermaidText = (s: string) => s.replace(/"/g, '#quot;').replace(/\n/g, '<br>')

function mermaidShape(n: NodeEl, label: string): string {
  const t = `"${mermaidText(label)}"`
  switch (n.kind) {
    case 'rounded':
      return `([${t}])`
    case 'diamond':
      return `{${t}}`
    case 'ellipse':
      return `((${t}))`
    case 'parallelogram':
      return `[/${t}/]`
    case 'cylinder':
      return `[(${t})]`
    case 'hexagon':
      return `{{${t}}}`
    default:
      return `[${t}]`
  }
}

function mermaidStyle(n: NodeEl, id: string): string | null {
  const pal = PALETTE[n.color]
  if (n.kind === 'sticky') return `style ${id} fill:${pal.sticky},stroke:${pal.sticky},color:${n.color === 'black' ? '#ffffff' : '#1e1e1e'}`
  if (n.kind === 'text') return `style ${id} fill:transparent,stroke:transparent`
  if (n.color === 'ink') return null
  return `style ${id} fill:${pal.fill},stroke:${pal.stroke},color:${pal.text}`
}

function mermaidArrow(e: EdgeEl): { arrow: string; reverse: boolean } {
  const s = e.startHead !== 'none'
  const t = e.endHead !== 'none'
  const reverse = s && !t
  const head = s && t ? 'both' : s || t ? 'one' : 'none'
  if (e.dashed) return { arrow: head === 'both' ? '<-.->' : head === 'one' ? '-.->' : '-.-', reverse }
  if (e.width >= 4) return { arrow: head === 'both' ? '<==>' : head === 'one' ? '==>' : '===', reverse }
  return { arrow: head === 'both' ? '<-->' : head === 'one' ? '-->' : '---', reverse }
}

/** Smallest section fully containing each shape (sections can nest). */
function parentSections(nodes: NodeEl[]): Map<string, string> {
  const sections = nodes.filter((n) => n.kind === 'section')
  const parent = new Map<string, string>()
  for (const n of nodes) {
    let best: NodeEl | undefined
    for (const s of sections) {
      if (s.id === n.id || !insideRect(s, n)) continue
      if (!best || s.w * s.h < best.w * best.h) best = s
    }
    if (best) parent.set(n.id, best.id)
  }
  return parent
}

function mermaid(doc: Doc, shortId: (id: string) => string): string[] {
  const nodes = doc.nodes
  const map = new Map(nodes.map((n) => [n.id, n]))
  const edges = doc.edges.filter((e) => e.from.nodeId && e.to.nodeId && map.has(e.from.nodeId) && map.has(e.to.nodeId))
  // Lay the diagram out top-down or left-right, whichever the board mostly does.
  let dx = 0, dy = 0
  for (const e of edges) {
    const a = center(map.get(e.from.nodeId!)!)
    const b = center(map.get(e.to.nodeId!)!)
    dx += Math.abs(b.x - a.x)
    dy += Math.abs(b.y - a.y)
  }
  const out = [`flowchart ${dx > dy * 1.2 ? 'LR' : 'TD'}`]
  const parent = parentSections(nodes)
  const children = new Map<string | undefined, NodeEl[]>()
  for (const n of nodes) {
    const key = parent.get(n.id)
    children.set(key, [...(children.get(key) ?? []), n])
  }
  const byPosition = (a: NodeEl, b: NodeEl) => a.y - b.y || a.x - b.x
  const emit = (key: string | undefined, depth: number) => {
    const pad = '  '.repeat(depth)
    for (const n of [...(children.get(key) ?? [])].sort(byPosition)) {
      const id = shortId(n.id)
      if (n.kind === 'section') {
        out.push(`${pad}subgraph ${id}["${mermaidText(nodeName(n))}"]`)
        emit(n.id, depth + 1)
        out.push(`${pad}end`)
      } else {
        out.push(`${pad}${id}${mermaidShape(n, n.kind === 'image' ? '🖼 Image' : plain(n) || ' ')}`)
      }
    }
  }
  emit(undefined, 1)
  for (const e of edges) {
    const { arrow, reverse } = mermaidArrow(e)
    const a = shortId(e.from.nodeId!)
    const b = shortId(e.to.nodeId!)
    const label = e.label.trim() ? `|"${mermaidText(e.label.trim())}"|` : ''
    out.push(`  ${reverse ? b : a} ${arrow}${label} ${reverse ? a : b}`)
  }
  for (const n of nodes) {
    if (n.kind === 'section') continue
    const s = mermaidStyle(n, shortId(n.id))
    if (s) out.push(`  ${s}`)
  }
  return out
}

// ---------- public ----------

/** Markdown for the whole board, or just the selected shapes (with their section contents). */
export function buildMarkdown(doc: Doc, title: string, ids: Set<string> | null): string | null {
  let part = doc
  if (ids) {
    const keep = withSectionContents(doc, ids)
    const nodes = doc.nodes.filter((n) => keep.has(n.id))
    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges = doc.edges.filter((e) => ids.has(e.id) || (e.from.nodeId && e.to.nodeId && nodeIds.has(e.from.nodeId) && nodeIds.has(e.to.nodeId)))
    part = { nodes, edges }
  }
  if (!part.nodes.length && !part.edges.length) return null
  const short = new Map<string, string>()
  const shortId = (id: string) => {
    if (!short.has(id)) short.set(id, `n${short.size + 1}`)
    return short.get(id)!
  }
  const preview = [
    '<!-- A Flowboard board (https://github.com/kashihashi95/flowboard). The format is described in FLOWBOARD-MARKDOWN.md (in Flowboard: Menu → Download Markdown guide). To change the board, edit the lists below; never edit the flowboard:history block at the end. -->',
    '<!-- Preview for Obsidian and GitHub. Flowboard ignores this block and reads the lists below. -->',
    '```mermaid',
    ...mermaid(part, shortId),
    '```',
    '',
  ]
  return writeFlowboardMarkdown(part, title, preview)
}

/** Read a Markdown board: Flowboard Markdown, or a file saved by an earlier
 *  version (which kept the board in a hidden comment). */
export function parseMarkdown(text: string): { doc: Doc; title?: string; warnings: string[] } | null {
  const start = text.lastIndexOf(DATA_START)
  if (start >= 0) {
    const body = text.slice(text.indexOf('\n', start) + 1)
    const end = body.indexOf(DATA_END)
    try {
      const data = JSON.parse(body.slice(0, end))
      if (isDoc(data?.doc)) return { doc: normalizeDoc(data.doc), title: typeof data.title === 'string' ? data.title : undefined, warnings: [] }
    } catch {
      /* fall through to the readable format */
    }
  }
  return parseFlowboardMarkdown(text)
}
