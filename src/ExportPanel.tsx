import { useEffect, useState } from 'react'
import { bigPdf, bigPng } from './bigexport'
import { fullScale, copyBlob, download, detailScale, rasterizeBest, safeName, type BuiltSvg, type ExportFormat } from './exporter'

export type ExportScope = 'board' | 'selection' | 'diff'

interface Output {
  blob: Blob
  text?: string
  w: number
  h: number
  /** Pixels per board pixel, for image formats. */
  detail?: number
}

type Format = ExportFormat | 'md' | 'html'

const FORMATS: { value: Format; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'svg', label: 'SVG' },
  { value: 'pdf', label: 'PDF' },
  { value: 'md', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
]

export function ExportPanel({
  title,
  hasSelection,
  diffCount = 0,
  diffFrom = '',
  initialScope,
  build,
  buildMd,
  onClose,
  flash,
  saveFile,
  buildHtml,
  workspace,
}: {
  title: string
  hasSelection: boolean
  /** How many shapes and connectors are new or edited since the ghost copy. */
  diffCount?: number
  /** The file the ghost copy is of. */
  diffFrom?: string
  initialScope: ExportScope
  build: (scope: ExportScope, background: string | null) => BuiltSvg | null
  buildMd: (scope: ExportScope) => string | null
  onClose: () => void
  flash: (m: string) => void
  /** Saves into the workspace folder when one is set; resolves false to fall back to a download. */
  saveFile?: (blob: Blob, filename: string) => Promise<boolean>
  /** Flowboard itself as one HTML file, opening straight to this board (or the selection). */
  buildHtml: (scope: ExportScope) => string | null
  /** Name of the workspace folder, when one is set. */
  workspace?: string | null
}) {
  const [scope, setScope] = useState<ExportScope>(initialScope === 'selection' && !hasSelection ? 'board' : initialScope)
  const [format, setFormat] = useState<Format>('png')
  const [background, setBackground] = useState(true)
  const [name, setName] = useState(safeName(title))
  const [out, setOut] = useState<Output | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [mdText, setMdText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const emptyText =
    scope === 'selection' ? 'Nothing is selected.' : scope === 'diff' ? `Nothing is new or edited in ${diffFrom || 'this diff'}.` : 'The board is empty. Add a shape before exporting.'
  const raster = format === 'png' || format === 'jpg' || format === 'pdf'
  const transparentAllowed = format === 'png' || format === 'svg'

  useEffect(() => {
    let cancelled = false
    const bg = background || !transparentAllowed ? '#ffffff' : null
    setOut(null)
    if (format === 'md') {
      const md = buildMd(scope)
      setMdText(md)
      setError(md ? null : emptyText)
      if (md) setOut({ blob: new Blob([md], { type: 'text/markdown' }), text: md, w: 0, h: 0 })
      return
    }
    setMdText(null)
    const built = build(scope, bg)
    if (!built) {
      setPreview(null)
      setError(emptyText)
      return
    }
    setError(null)
    // Show the drawing right away; encoding a large PNG or PDF can take a moment.
    const previewUrl = URL.createObjectURL(new Blob([built.svg], { type: 'image/svg+xml' }))
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old)
      return previewUrl
    })
    const make = async (): Promise<Output> => {
      if (format === 'html') {
        const html = buildHtml(scope)
        if (!html) throw new Error('empty')
        return { blob: new Blob([html], { type: 'text/html' }), w: 0, h: 0 }
      }
      if (format === 'svg') {
        const blob = new Blob([built.svg], { type: 'image/svg+xml' })
        return { blob, text: built.svg, w: built.w, h: built.h }
      }
      if (format === 'pdf') {
        const scale = fullScale(built.w, built.h)
        return { blob: await bigPdf(built, scale, bg ?? '#ffffff'), w: built.w, h: built.h, detail: scale }
      }
      if (format === 'png') {
        // Drawn in tiles and stitched, so any board gets full detail.
        const scale = fullScale(built.w, built.h)
        return { blob: await bigPng(built, scale, bg), w: Math.round(built.w * scale), h: Math.round(built.h * scale), detail: scale }
      }
      const r = await rasterizeBest(built, format, detailScale(built.w, built.h), bg)
      return { blob: r.blob, w: r.w, h: r.h, detail: r.scale }
    }
    make()
      .then((o) => !cancelled && setOut(o))
      .catch(() => !cancelled && setError('This board is too big for your browser to turn into an image. Try SVG, or export a selection.'))
    return () => {
      cancelled = true
    }
  }, [build, buildMd, buildHtml, scope, format, background, transparentAllowed, emptyText])

  useEffect(() => () => setPreview((old) => (old && URL.revokeObjectURL(old), null)), [])

  const filename = `${name.trim() || 'flowchart'}.${format}`

  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!out || saving) return
    setSaving(true)
    try {
      if (saveFile && (await saveFile(out.blob, filename))) return
    } finally {
      setSaving(false)
    }
    download(out.blob, filename).catch((err: { code?: string }) => {
      if (err?.code !== 'declined') flash('This view blocked the download. Use Copy, or right-click the preview to save it.')
    })
  }

  const copy = async () => {
    if (!out) return
    try {
      await copyBlob(out.blob, format === 'svg' || format === 'md' ? out.text : undefined)
      flash(format === 'svg' ? 'Copied SVG code' : format === 'md' ? 'Copied Markdown' : 'Copied image to clipboard')
    } catch {
      flash('Your browser blocked the clipboard. Use Export, or right-click the preview to save it.')
    }
  }

  return (
    <div className="chrome backdrop" onPointerDown={onClose}>
      <div className="dialog export" role="dialog" aria-label="Export" onPointerDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <strong>Export</strong>
          <button className="textbtn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="export-body">
          <div className="preview">
            {error ? (
              <p className="muted">{error}</p>
            ) : mdText !== null ? (
              <pre aria-label="Markdown preview">{mdText
                .replace(/\n<!-- flowboard:data[\s\S]*$/, '\n<!-- board data for reopening in Flowboard (hidden in Obsidian) -->')
                .replace(/\n<!-- flowboard:history[\s\S]*$/, '\n<!-- timeline, view and toggles for Flowboard (hidden in Markdown viewers) -->')}</pre>
            ) : preview ? (
              <img src={preview} alt="Export preview" />
            ) : null}
          </div>
          <div className="export-form">
            {scope !== 'diff' && (
            <div className="field">
              <span>Export</span>
              <div className="seg" role="radiogroup" aria-label="What to export">
                <button role="radio" aria-checked={scope === 'board'} className={scope === 'board' ? 'on' : ''} onClick={() => setScope('board')}>
                  Entire board
                </button>
                <button
                  role="radio"
                  aria-checked={scope === 'selection'}
                  className={scope === 'selection' ? 'on' : ''}
                  disabled={!hasSelection}
                  title={hasSelection ? undefined : 'Select something on the board first'}
                  onClick={() => setScope('selection')}
                >
                  Selection
                </button>
              </div>
            </div>
            )}
            {scope === 'diff' && (
              <p className="muted">
                Diff from the Timeline, {diffFrom}: {diffCount} {diffCount === 1 ? 'item' : 'items'}, meaning what's new or edited plus the shapes new connectors join. Moving or resizing doesn't count.
              </p>
            )}
            <div className="field">
              <span>Format</span>
              <div className="seg" role="radiogroup" aria-label="Format">
                {FORMATS.map((f) => (
                  <button key={f.value} role="radio" aria-checked={format === f.value} className={format === f.value ? 'on' : ''} onClick={() => setFormat(f.value)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {raster && (
              <p className="muted">
                Exported at full detail (up to 4× the board, less only for very large boards), so it stays sharp when you zoom in. SVG stays sharp at any zoom.
              </p>
            )}
            {format === 'html' && (
              <p className="muted">
                Flowboard itself with this board built in. Double-click the file to open it in your browser and keep editing; nothing to install. Its changes autosave in that browser.
              </p>
            )}
            {format === 'md' && (
              <p className="muted">
                Opens in Obsidian as a drawn diagram (Mermaid) with an outline of the steps. Open the .md file in Flowboard to keep editing it.
              </p>
            )}
            {format !== 'md' && <label className="check" htmlFor="export-bg">
              <input
                id="export-bg"
                type="checkbox"
                checked={background || !transparentAllowed}
                disabled={!transparentAllowed}
                onChange={(e) => setBackground(e.target.checked)}
              />
              <span>Include background</span>
            </label>}
            <label className="field" htmlFor="export-name">
              <span>File name</span>
              <div className="filename">
                <input id="export-name" value={name} onChange={(e) => setName(e.target.value)} />
                <span className="muted">.{format}</span>
              </div>
            </label>
            <p className="muted dims" aria-live="polite">
              {out && format === 'md'
                ? `${(out.text ?? '').split('\n').length} lines · ${formatBytes(out.blob.size)}`
                : out
                ? format === 'html' ? `Flowboard app + board · ${formatBytes(out.blob.size)}` : `${format === 'pdf' ? `${Math.round(out.w * 0.75)} × ${Math.round(out.h * 0.75)} pt page` : `${out.w} × ${out.h} px`}${out.detail ? ` · ${Math.round(out.detail * 10) / 10}× detail` : ''} · ${formatBytes(out.blob.size)}`
                : error
                  ? ''
                  : 'Preparing file…'}
            </p>
            <div className="dialog-actions">
              {format !== 'pdf' && (
                <button className="textbtn" onClick={copy} disabled={!out}>
                  {format === 'svg' ? 'Copy SVG code' : format === 'md' ? 'Copy Markdown' : 'Copy image'}
                </button>
              )}
              <button className="primary" onClick={save} disabled={!out || saving}>
                {saving ? 'Saving…' : <>
                {workspace != null ? 'Save' : 'Export'} {format === 'md' ? '.md' : format.toUpperCase()}{workspace != null ? ' to workspace' : ''}</>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
