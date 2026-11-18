export interface LoadedImage {
  src: string
  width: number
  height: number
}

const MAX_SIDE = 2400
const MAX_BYTES = 1_500_000

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

export const isImageFile = (f: File) => f.type.startsWith('image/')

/** Read an image file into a data URL, shrinking very large photos so the
 *  board still fits in browser storage. GIFs and SVGs are kept as they are. */
export async function loadImage(file: File): Promise<LoadedImage> {
  const original = await readAsDataUrl(file)
  const img = new Image()
  img.src = original
  await img.decode()
  let width = img.naturalWidth || 300
  let height = img.naturalHeight || 200
  const keep = file.type === 'image/gif' || file.type === 'image/svg+xml'
  if (keep || (file.size <= MAX_BYTES && Math.max(width, height) <= MAX_SIDE)) return { src: original, width, height }
  const k = Math.min(1, MAX_SIDE / Math.max(width, height))
  width = Math.round(width * k)
  height = Math.round(height * k)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
  // WebP keeps transparency and is much smaller than PNG for photos.
  const webp = canvas.toDataURL('image/webp', 0.88)
  const src = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88)
  return { src, width: img.naturalWidth, height: img.naturalHeight }
}
