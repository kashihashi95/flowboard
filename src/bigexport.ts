import type { BuiltSvg } from './exporter'

/** Full-detail PNG and PDF of boards of any size. Browsers refuse canvases
 *  past a size limit, so the drawing is rendered in tiles, each one a crop
 *  of the SVG drawn at its own native resolution, and the tiles are stitched
 *  into the file here: PNG rows go through the browser's deflate stream,
 *  and a PDF page holds one JPEG per tile. */

const TILE = 4096

/** The board's SVG cropped to one tile, drawn at `scale`. */
async function renderTile(built: BuiltSvg, scale: number, tx: number, ty: number, tw: number, th: number, background: string | null) {
  const vx = built.x + tx / scale
  const vy = built.y + ty / scale
  const svg = built.svg.replace(/^<svg[^>]*>/, (open) =>
    open
      .replace(/ width="[^"]*"/, ` width="${tw}"`)
      .replace(/ height="[^"]*"/, ` height="${th}"`)
      .replace(/ viewBox="[^"]*"/, ` viewBox="${vx} ${vy} ${tw / scale} ${th / scale}"`),
  )
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas unavailable')
    if (background) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, tw, th)
    }
    ctx.drawImage(img, 0, 0, tw, th)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------- PNG ----------

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const head = new Uint8Array(8)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, data.length)
  const name = new TextEncoder().encode(type)
  head.set(name, 4)
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc32([name, data]))
  return [head, data, tail]
}

export async function bigPng(built: BuiltSvg, scale: number, background: string | null): Promise<Blob> {
  const W = Math.round(built.w * scale)
  const H = Math.round(built.h * scale)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, W)
  dv.setUint32(4, H)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace

  const zip = new CompressionStream('deflate')
  const writer = zip.writable.getWriter()
  const compressed: Uint8Array[] = []
  const reading = (async () => {
    const reader = zip.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      compressed.push(value)
    }
  })()

  // A band of whole rows at a time, about 64 MB of pixels.
  const bandH = Math.max(1, Math.min(TILE, Math.floor((16 * 1024 * 1024) / W)))
  const stride = W * 4 + 1
  for (let y = 0; y < H; y += bandH) {
    const h = Math.min(bandH, H - y)
    const band = new Uint8Array(stride * h)
    for (let x = 0; x < W; x += TILE) {
      const w = Math.min(TILE, W - x)
      const canvas = await renderTile(built, scale, x, y, w, h, background)
      const px = canvas.getContext('2d')!.getImageData(0, 0, w, h).data
      for (let r = 0; r < h; r++) band.set(px.subarray(r * w * 4, (r + 1) * w * 4), r * stride + 1 + x * 4)
      canvas.width = canvas.height = 0
    }
    // Each row starts with filter type 0 (none); the band is already zeroed there.
    await writer.write(band)
  }
  await writer.close()
  await reading

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts: Uint8Array[] = [sig, ...chunk('IHDR', ihdr)]
  for (const c of compressed) parts.push(...chunk('IDAT', c))
  parts.push(...chunk('IEND', new Uint8Array(0)))
  return new Blob(parts as BlobPart[], { type: 'image/png' })
}

// ---------- PDF ----------

/** One-page PDF sized to the content (1 CSS px = 0.75 pt), tiled with
 *  full-detail JPEGs. */
export async function bigPdf(built: BuiltSvg, scale: number, background: string): Promise<Blob> {
  const W = Math.round(built.w * scale)
  const H = Math.round(built.h * scale)
  const pw = built.w * 0.75
  const ph = built.h * 0.75
  const tiles: { jpeg: Uint8Array; w: number; h: number; x: number; y: number }[] = []
  for (let y = 0; y < H; y += TILE) {
    for (let x = 0; x < W; x += TILE) {
      const w = Math.min(TILE, W - x)
      const h = Math.min(TILE, H - y)
      const canvas = await renderTile(built, scale, x, y, w, h, background)
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.95))
      canvas.width = canvas.height = 0
      tiles.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w, h, x, y })
    }
  }
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (p: Uint8Array | string) => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p
    parts.push(bytes)
    length += bytes.length
  }
  const n = tiles.length
  // Objects: 1 catalog, 2 pages, 3 page, 4 contents, 5.. images.
  const k = pw / W // points per pixel
  const content = tiles
    .map((t, i) => `q ${(t.w * k).toFixed(3)} 0 0 ${(t.h * k).toFixed(3)} ${(t.x * k).toFixed(3)} ${(ph - (t.y + t.h) * k).toFixed(3)} cm /Im${i} Do Q`)
    .join('\n')
  const obj = (num: number, body: string) => {
    offsets[num] = length
    push(`${num} 0 obj\n${body}\nendobj\n`)
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const xobjects = tiles.map((_, i) => `/Im${i} ${5 + i} 0 R`).join(' ')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << ${xobjects} >> >> /Contents 4 0 R >>`)
  obj(4, `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`)
  tiles.forEach((t, i) => {
    offsets[5 + i] = length
    push(`${5 + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${t.w} /Height ${t.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${t.jpeg.length} >>\nstream\n`)
    push(t.jpeg)
    push('\nendstream\nendobj\n')
  })
  const total = 5 + n
  const xref = length
  push(`xref\n0 ${total}\n0000000000 65535 f \n`)
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}
