import { edgeGeometry, sectionTitleRect, unionRects } from './geometry'
import { withSectionContents } from './store'
import type { Doc, Rect } from './types'

const PAD = 32

export type ExportFormat = 'png' | 'jpg' | 'svg' | 'pdf'

export interface BuiltSvg {
  svg: string
  w: number
  h: number
  /** Top-left of the drawing on the board (the SVG's viewBox origin). */
  x: number
  y: number
}

/** Shapes in `ids`, plus connectors that are selected or run between two of them. */
function keptIds(doc: Doc, ids: Set<string> | null): Set<string> {
  if (!ids) return new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)])
  const all = withSectionContents(doc, ids)
  const kept = new Set(doc.nodes.filter((n) => all.has(n.id)).map((n) => n.id))
  for (const e of doc.edges) {
    const between = e.from.nodeId && e.to.nodeId && kept.has(e.from.nodeId) && kept.has(e.to.nodeId)
    if (ids.has(e.id) || between) kept.add(e.id)
  }
  return kept
}

/** Standalone SVG of the board (or just `ids`), cropped to what is drawn.
 *  `background` null leaves it transparent. */
export function buildSvg(content: SVGGElement, doc: Doc, ids: Set<string> | null, background: string | null): BuiltSvg | null {
  const kept = keptIds(doc, ids)
  const map = new Map(doc.nodes.map((n) => [n.id, n]))
  const rects: Rect[] = doc.nodes.filter((n) => kept.has(n.id))
  for (const n of doc.nodes) if (kept.has(n.id) && n.kind === 'section') rects.push(sectionTitleRect(n))
  for (const e of doc.edges) if (kept.has(e.id)) rects.push(edgeGeometry(e, map).bounds)
  const b = unionRects(rects)
  if (!b) return null
  const x = Math.floor(b.x - PAD)
  const y = Math.floor(b.y - PAD)
  const w = Math.ceil(b.w + PAD * 2)
  const h = Math.ceil(b.h + PAD * 2)
  const clone = content.cloneNode(true) as SVGGElement
  clone.removeAttribute('transform')
  clone.querySelectorAll('[data-hit]').forEach((el) => el.remove())
  clone.querySelectorAll<SVGElement>('[data-node], [data-edge]').forEach((el) => {
    const id = el.dataset.node ?? el.dataset.edge ?? ''
    if (!kept.has(id)) el.remove()
  })
  const bg = background ?? '#ffffff'
  const body = clone.outerHTML
    .replaceAll('var(--ink)', '#1e1e1e')
    .replaceAll('var(--canvas)', bg === 'transparent' ? '#ffffff' : bg)
    .replaceAll('var(--shape)', '#ffffff')
    .replaceAll('var(--section-tab-text)', '#3a3a37')
    .replaceAll('var(--section-tab)', '#e7e6e0')
    .replaceAll('var(--section-line)', '#d6d5cf')
    .replaceAll('var(--section)', '#fcfcfa')
    .replaceAll('var(--link-mark)', 'rgba(28,126,214,0.18)')
  const rect = background ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">${rect}${body}</svg>`
  return { svg, w, h, x, y }
}

async function svgToCanvas(svg: string, w: number, h: number, scale: number, background: string | null): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    // Too big for this browser: it gives no drawing context.
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas too large')
    if (background) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality),
  )

/** Pixels per board pixel for image exports: 4x, so you can zoom in to 400%
 *  and still see every detail, reduced as far as needed to stay within what
 *  every browser can draw (16,384 px a side, about 64 million pixels). */
export function detailScale(w: number, h: number): number {
  return Math.max(0.25, Math.min(4, 16384 / Math.max(w, h, 1), Math.sqrt(64e6 / Math.max(w * h, 1))))
}

/** Pixels per board pixel for tiled PNG and PDF exports, which have no
 *  canvas limit: 4x, kept under about 400 million pixels so the file still
 *  opens in ordinary image viewers. */
export function fullScale(w: number, h: number): number {
  return Math.max(0.25, Math.min(4, Math.sqrt(400e6 / Math.max(w * h, 1))))
}

/** Draw and encode at `scale`, stepping down whenever the browser can't
 *  manage that size (limits differ by browser, graphics card and memory). */
async function encodeBest(built: BuiltSvg, scale: number, background: string | null, type: string, quality?: number): Promise<{ blob: Blob; scale: number; w: number; h: number }> {
  let s = scale
  for (;;) {
    try {
      const canvas = await svgToCanvas(built.svg, built.w, built.h, s, background)
      const blob = await toBlob(canvas, type, quality)
      // Release the pixels straight away; big canvases hold a lot of memory.
      const { width, height } = canvas
      canvas.width = canvas.height = 0
      return { blob, scale: s, w: width, h: height }
    } catch (err) {
      if (s <= 0.25) throw err
      s = Math.max(0.25, s * 0.7)
    }
  }
}

export async function rasterize(built: BuiltSvg, format: 'png' | 'jpg', scale: number, background: string | null): Promise<Blob> {
  return (await rasterizeBest(built, format, scale, background)).blob
}

/** Like rasterize, and says the size it managed. */
export async function rasterizeBest(built: BuiltSvg, format: 'png' | 'jpg', scale: number, background: string | null) {
  // JPG has no transparency, so it always gets a background.
  const bg = format === 'jpg' ? (background ?? '#ffffff') : background
  return encodeBest(built, scale, bg, format === 'png' ? 'image/png' : 'image/jpeg', format === 'png' ? undefined : 0.92)
}

/** One-page PDF sized to the content (1 CSS px = 0.75 pt), holding a
 *  high-resolution JPEG of the drawing. */
export async function buildPdf(built: BuiltSvg, background: string | null): Promise<Blob> {
  const img = await encodeBest(built, detailScale(built.w, built.h), background ?? '#ffffff', 'image/jpeg', 0.95)
  const jpeg = new Uint8Array(await img.blob.arrayBuffer())
  const canvas = { width: img.w, height: img.h }
  const W = (built.w * 0.75).toFixed(2)
  const H = (built.h * 0.75).toFixed(2)
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (p: Uint8Array | string) => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p
    parts.push(bytes)
    length += bytes.length
  }
  const obj = (n: number, body: string) => {
    offsets[n] = length
    push(`${n} 0 obj\n${body}\nendobj\n`)
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  offsets[4] = length
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  )
  push(jpeg)
  push('\nendstream\nendobj\n')
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = length
  push(`xref\n0 6\n0000000000 65535 f \n`)
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

type Downloads = { save(r: { filename: string; data: Blob }): Promise<unknown> }
type ClaudeHost = { use(name: 'downloads'): Promise<Downloads | null> }

/** Save a file. Inside a claude.ai artifact, the page's own download links are
 *  blocked, so go through the viewer's downloads capability when it exists. */
export async function download(blob: Blob, filename: string): Promise<void> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude
  if (host?.use) {
    const downloads = await host.use('downloads')
    if (downloads) {
      await downloads.save({ filename, data: blob })
      return
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyBlob(blob: Blob, text?: string) {
  if (text !== undefined) return navigator.clipboard.writeText(text)
  return navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

export const safeName = (title: string) => title.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'flowchart'
