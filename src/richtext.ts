import { lineHeight, measure, setLinkRectResolver, textBox, unionRects, type LinkRect } from './geometry'
import type { NodeEl, Paragraph, TextAlign, TextRun } from './types'

// ---------- model ----------

export function plainToParagraphs(text: string): Paragraph[] {
  return text.split('\n').map((t) => ({ runs: t ? [{ text: t }] : [] }))
}

export const paragraphsOf = (n: NodeEl): Paragraph[] => n.rich ?? plainToParagraphs(n.text)

export const paragraphsToPlain = (paras: Paragraph[]) => paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n')

export const defaultAlign = (n: NodeEl): TextAlign => (n.kind === 'sticky' ? 'left' : 'center')

const sameStyle = (a: TextRun, b: TextRun) =>
  !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.strike === !!b.strike && a.color === b.color && a.link === b.link

/** Merge neighbouring runs with identical style and drop empty ones. */
export function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, r)) last.text += r.text
    else out.push({ ...r })
  }
  return out
}

/** Set a style on every run of a node (used when formatting a selected shape). */
export function styleAllRuns(n: NodeEl, patch: Partial<TextRun>): NodeEl {
  const rich = paragraphsOf(n).map((p) => ({ ...p, runs: normalizeRuns(p.runs.map((r) => ({ ...r, ...patch }))) }))
  return { ...n, rich }
}

export function alignAll(n: NodeEl, align: TextAlign): NodeEl {
  return { ...n, rich: paragraphsOf(n).map((p) => ({ ...p, align })) }
}

export function listAll(n: NodeEl, list: Paragraph['list']): NodeEl {
  return { ...n, rich: paragraphsOf(n).map((p) => ({ ...p, list })) }
}

/** True when every run with text has the style on. */
export function allRuns(n: NodeEl, key: 'bold' | 'italic' | 'underline' | 'strike'): boolean {
  const runs = paragraphsOf(n).flatMap((p) => p.runs)
  return runs.length > 0 && runs.every((r) => r[key])
}

// ---------- layout ----------

export interface Segment {
  text: string
  x: number
  w: number
  run: TextRun
}

export interface Line {
  segs: Segment[]
  /** List marker drawn before the first line of a list item. */
  marker?: { text: string; x: number }
}

const weightOf = (r: TextRun) => (r.bold ? 700 : 400)
export const measureRun = (text: string, r: TextRun, size: number) => measure(text, size, weightOf(r), !!r.italic)

/** Wrap formatted paragraphs into positioned lines inside a box `maxW` wide. */
export function layoutParagraphs(paras: Paragraph[], maxW: number, size: number, fallbackAlign: TextAlign): Line[] {
  const lines: Line[] = []
  let number = 0
  for (const p of paras) {
    number = p.list === 'number' ? number + 1 : 0
    const indent = p.list ? size * 1.3 : 0
    const avail = Math.max(maxW - indent, 10)
    const align = p.align ?? fallbackAlign
    const paraLines: { segs: { text: string; w: number; run: TextRun }[]; w: number }[] = []
    let cur: { segs: { text: string; w: number; run: TextRun }[]; w: number } = { segs: [], w: 0 }
    const pushLine = () => {
      while (cur.segs.length && /^\s+$/.test(cur.segs[cur.segs.length - 1].text)) cur.w -= cur.segs.pop()!.w
      paraLines.push(cur)
      cur = { segs: [], w: 0 }
    }
    for (const run of p.runs) {
      for (const token of run.text.match(/\s+|\S+/g) ?? []) {
        const isSpace = /^\s+$/.test(token)
        if (isSpace && !cur.segs.length && paraLines.length) continue
        let w = measureRun(token, run, size)
        if (isSpace || cur.w + w <= avail || !cur.segs.length) {
          let text = token
          // A word wider than the whole line is broken by character.
          while (!isSpace && w > avail - cur.w && text.length > 1) {
            let i = text.length - 1
            while (i > 1 && measureRun(text.slice(0, i), run, size) > avail - cur.w) i--
            const head = text.slice(0, i)
            cur.segs.push({ text: head, w: measureRun(head, run, size), run })
            pushLine()
            text = text.slice(i)
            w = measureRun(text, run, size)
          }
          cur.segs.push({ text, w, run })
          cur.w += w
        } else {
          pushLine()
          cur.segs.push({ text: token, w, run })
          cur.w = w
        }
      }
    }
    pushLine()
    paraLines.forEach((pl, i) => {
      const start = indent + (align === 'center' ? (avail - pl.w) / 2 : align === 'right' ? avail - pl.w : 0)
      let x = start
      const segs: Segment[] = []
      for (const s of pl.segs) {
        const last = segs[segs.length - 1]
        if (last && sameStyle(last.run, s.run)) {
          last.text += s.text
          last.w += s.w
        } else {
          segs.push({ text: s.text, x, w: s.w, run: s.run })
        }
        x += s.w
      }
      let marker: Line['marker']
      if (p.list && i === 0) {
        const text = p.list === 'bullet' ? '•' : `${number}.`
        marker = { text, x: start - measure(text, size) - size * 0.35 }
      }
      lines.push({ segs, marker })
    })
  }
  return lines
}

export const textHeight = (lines: Line[], size: number) => Math.max(lines.length, 1) * lineHeight(size)

// ---------- HTML for the editor ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function runHtml(r: TextRun): string {
  const css: string[] = []
  if (r.bold) css.push('font-weight:700')
  if (r.italic) css.push('font-style:italic')
  const deco = [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ')
  if (deco) css.push(`text-decoration:${deco}`)
  if (r.color) css.push(`color:${r.color}`)
  const inner = css.length ? `<span style="${css.join(';')}">${esc(r.text)}</span>` : esc(r.text)
  return r.link ? `<span class="linkmark" data-link="${esc(r.link)}">${inner}</span>` : inner
}

export function paragraphsToHtml(paras: Paragraph[]): string {
  let html = ''
  let openList: string | null = null
  for (const p of paras) {
    const listTag = p.list === 'bullet' ? 'ul' : p.list === 'number' ? 'ol' : null
    if (openList && openList !== listTag) {
      html += `</${openList}>`
      openList = null
    }
    if (listTag && !openList) {
      html += `<${listTag}>`
      openList = listTag
    }
    const style = p.align ? ` style="text-align:${p.align}"` : ''
    const inner = p.runs.map(runHtml).join('') || '<br>'
    html += listTag ? `<li${style}>${inner}</li>` : `<div${style}>${inner}</div>`
  }
  if (openList) html += `</${openList}>`
  return html
}

const BLOCKS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE'])

/** Read the editor's DOM back into paragraphs, using computed styles so it
 *  understands whatever markup the browser's editing commands produced. */
export function htmlToParagraphs(root: HTMLElement): Paragraph[] {
  const paras: Paragraph[] = []
  const rootStyle = getComputedStyle(root)
  const baseColor = rootStyle.color
  let cur: Paragraph | null = null

  const blockProps = (block: Element): Pick<Paragraph, 'align' | 'list'> => {
    const out: Pick<Paragraph, 'align' | 'list'> = {}
    const a = getComputedStyle(block).textAlign
    const align: TextAlign | undefined = a === 'center' ? 'center' : a === 'right' || a === 'end' ? 'right' : a === 'left' || a === 'start' ? 'left' : undefined
    if (align && align !== rootStyle.textAlign.replace('start', 'left')) out.align = align
    else if (align && block !== root && (block as HTMLElement).style.textAlign) out.align = align
    const li = block.closest('li')
    if (li && root.contains(li)) out.list = li.parentElement?.tagName === 'OL' ? 'number' : 'bullet'
    return out
  }
  const start = (block: Element) => {
    cur = { runs: [], ...blockProps(block) }
    paras.push(cur)
  }
  const decorations = (el: Element) => {
    let underline = false
    let strike = false
    for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) {
      const d = getComputedStyle(e).textDecorationLine
      if (d.includes('underline')) underline = true
      if (d.includes('line-through')) strike = true
      if (e === root) break
    }
    return { underline, strike }
  }

  const walk = (node: Node, block: Element) => {
    node.childNodes.forEach((child, i) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/ /g, ' ').replace(/\n/g, '')
        if (!text) return
        if (!cur) start(block)
        const el = child.parentElement!
        const cs = getComputedStyle(el)
        const { underline, strike } = decorations(el)
        const run: TextRun = { text }
        if (Number(cs.fontWeight) >= 600) run.bold = true
        if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') run.italic = true
        if (underline) run.underline = true
        if (strike) run.strike = true
        if (cs.color !== baseColor) run.color = cs.color
        const link = el.closest<HTMLElement>('[data-link]')
        if (link && root.contains(link) && link.dataset.link) run.link = link.dataset.link
        cur!.runs.push(run)
        return
      }
      if (!(child instanceof Element)) return
      if (child.tagName === 'BR') {
        const isLast = i === node.childNodes.length - 1
        if (!cur) start(block)
        if (!isLast) start(block)
        return
      }
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        cur = null
        walk(child, block)
        cur = null
        return
      }
      if (BLOCKS.has(child.tagName)) {
        // The paragraph starts lazily, when text or a line break shows up, so a
        // wrapper block around a list doesn't leave an empty line behind.
        cur = null
        walk(child, child)
        cur = null
        return
      }
      walk(child, block)
    })
  }
  walk(root, root)
  const cleaned = paras.map((p) => ({ ...p, runs: normalizeRuns(p.runs) }))
  // Drop a single trailing empty paragraph the browser leaves behind.
  while (cleaned.length > 1 && !cleaned[cleaned.length - 1].runs.length && !cleaned[cleaned.length - 1].list) cleaned.pop()
  return cleaned.length ? cleaned : [{ runs: [] }]
}

/** Rich text only when it carries formatting; plain text otherwise. */
export function isPlain(paras: Paragraph[]): boolean {
  return paras.every((p) => !p.align && !p.list && p.runs.every((r) => !r.bold && !r.italic && !r.underline && !r.strike && !r.color && !r.link))
}

export const nodeLines = (n: NodeEl) => layoutParagraphs(paragraphsOf(n), Math.max(textBox(n).w, 10), n.fontSize, defaultAlign(n))

/** World position of the first line's middle and the left edge of the text box. */
export function textOrigin(n: NodeEl, lineCount: number): { left: number; top: number } {
  const box = textBox(n)
  const lh = lineHeight(n.fontSize)
  const top = n.kind === 'sticky' ? n.y + box.y + lh / 2 : n.y + n.h / 2 - ((lineCount - 1) * lh) / 2
  return { left: n.x + box.x, top }
}

/** Boxes (one per line it spans) of every highlighted phrase in a node, in world space. */
export function linkRects(n: NodeEl): Map<string, LinkRect[]> {
  const out = new Map<string, LinkRect[]>()
  if (!n.rich || n.kind === 'image' || n.kind === 'section') return out
  const lines = nodeLines(n)
  const { left, top } = textOrigin(n, lines.length)
  const lh = lineHeight(n.fontSize)
  // Spaces and punctuation (a closing quote, a full stop) don't get in a connector's way.
  const blank = (s: Segment) => /^[\s\p{P}]*$/u.test(s.text)
  lines.forEach((line, i) => {
    line.segs.forEach((seg, j) => {
      if (!seg.run.link || !seg.text.trim()) return
      const other = (s: Segment) => !blank(s) && s.run.link !== seg.run.link
      const freeLeft = !line.marker && !line.segs.slice(0, j).some(other)
      const freeRight = !line.segs.slice(j + 1).some(other)
      // Trailing spaces stay out of the box so the connector meets the last letter.
      const w = seg.text.trimEnd() === seg.text ? seg.w : measureRun(seg.text.trimEnd(), seg.run, n.fontSize)
      const rects = out.get(seg.run.link) ?? []
      // A connector leaves past punctuation touching the phrase, not through it.
      const touching = (segs: Segment[]) => {
        let k = 0
        while (k < segs.length && segs[k].run.link !== seg.run.link && segs[k].text.trim() && blank(segs[k])) k++
        return segs.slice(0, k)
      }
      const after = touching(line.segs.slice(j + 1))
      const before = touching(line.segs.slice(0, j).reverse())
      const x = left + seg.x
      const outRight = after.length ? left + after[after.length - 1].x + measureRun(after[after.length - 1].text.trimEnd(), after[after.length - 1].run, n.fontSize) : undefined
      const outLeft = before.length ? left + before[before.length - 1].x : undefined
      // Clear above / below: no words on the neighbouring line overlap the phrase sideways.
      const clear = (other?: Line) =>
        !other || !other.segs.some((o) => !blank(o) && o.run.link !== seg.run.link && left + o.x < x + w && left + o.x + o.w > x)
      const freeTop = clear(lines[i - 1])
      const freeBottom = clear(lines[i + 1])
      const r = { x, y: top + i * lh - lh / 2, w, h: lh, freeLeft, freeRight, outLeft, outRight, freeTop, freeBottom }
      const prev = rects[rects.length - 1]
      // Neighbouring segments on the same line (split by other styling) join up.
      if (prev && Math.abs(prev.y - r.y) < 0.5) rects[rects.length - 1] = { ...unionRects([prev, r])!, freeLeft: prev.freeLeft, freeRight, outLeft: prev.outLeft, outRight, freeTop: prev.freeTop && freeTop, freeBottom: prev.freeBottom && freeBottom }
      else rects.push(r)
      out.set(seg.run.link, rects)
    })
  })
  return out
}

export const linkIdsOf = (n: NodeEl) => [...new Set(paragraphsOf(n).flatMap((p) => p.runs.map((r) => r.link).filter((l): l is string => !!l)))]

setLinkRectResolver((n, id) => linkRects(n).get(id) ?? [])

/** Grow a node so its text fits (text nodes also shrink to fit). */
export function fitToText(n: NodeEl): NodeEl {
  if (n.kind === 'image') return n
  const box = textBox(n)
  const needed = textHeight(nodeLines(n), n.fontSize)
  if (n.kind === 'text') return { ...n, h: needed + 8 }
  const extra = n.h - box.h
  const scale = n.kind === 'diamond' ? 1 / 0.6 : n.kind === 'ellipse' ? 1 / 0.7 : 1
  const minH = n.kind === 'diamond' || n.kind === 'ellipse' ? needed * scale : needed + extra
  return minH > n.h ? { ...n, h: Math.ceil(minH) } : n
}

/** Size a shape to its text: wider for longer lines (up to a limit, then the
 *  text wraps and the shape grows taller), and smaller again when text is
 *  removed, never below `base`. The shape stays centred sideways and keeps
 *  its top edge. Stickies keep their width; shapes sized by hand only grow. */
export function autoSize(n: NodeEl, base: { w: number; h: number }): NodeEl {
  if (n.kind === 'image' || n.kind === 'section') return n
  if (n.fixedSize) return fitToText(n)
  if (n.kind === 'sticky') return fitToText({ ...n, h: base.h })
  const longest = Math.max(
    ...paragraphsOf(n).map((p) => p.runs.reduce((s, r) => s + measureRun(r.text, r, n.fontSize), 0) + (p.list ? n.fontSize * 1.3 : 0)),
    0,
  )
  const scale = n.kind === 'diamond' ? 1.7 : n.kind === 'ellipse' ? 1.45 : n.kind === 'hexagon' || n.kind === 'parallelogram' ? 1.35 : 1
  const pad = n.kind === 'text' ? 12 : 32
  const max = n.kind === 'text' ? 480 : 360
  const w = Math.round(Math.min(Math.max(base.w, (longest + pad) * scale), Math.max(max, base.w)))
  return fitToText({ ...n, x: n.x + (n.w - w) / 2, w, h: base.h })
}

/** Store edited paragraphs on a node, dropping the rich form when it carries no formatting. */
export function withParagraphs(n: NodeEl, paras: Paragraph[]): NodeEl {
  const text = paragraphsToPlain(paras)
  const next: NodeEl = { ...n, text }
  if (isPlain(paras)) delete next.rich
  else next.rich = paras
  return fitToText(next)
}
