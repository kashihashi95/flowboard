import type { WorkspaceFile } from './workspace'

/** The workspace folder: its charts, and where the open chart is saved. */
export function WorkspacePanel({
  supported,
  folder,
  access,
  files,
  current,
  onChoose,
  onAllow,
  onOpen,
  onSave,
  onSaveAs,
  onRefresh,
  onClose,
  recent,
  onSwitch,
  onForget,
}: {
  recent: { name: string; current: boolean }[]
  onSwitch: (i: number) => void
  onForget: (i: number) => void
  supported: boolean
  folder: string | null
  access: boolean
  files: WorkspaceFile[] | null
  current: string | null
  onChoose: () => void
  onAllow: () => void
  onOpen: (f: WorkspaceFile) => void
  onSave: () => void
  onSaveAs: () => void
  onRefresh: () => void
  onClose: () => void
}) {
  const when = (t: number) => {
    const d = new Date(t)
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  return (
    <div className="chrome help workspace" role="dialog" aria-label="Workspace">
      <div className="help-head">
        <strong>Workspace</strong>
        <button className="textbtn" onClick={onClose}>
          Close
        </button>
      </div>
      {!supported ? (
        <p className="muted">
          Saving to a folder needs Chrome or Edge on a computer (phones and tablets can't link a folder). Here, use Menu → Export board (Markdown or HTML), and Open file to bring a board back.
        </p>
      ) : folder === null ? (
        <>
          <p className="muted">Choose a folder for your charts. Flowboard lists the charts in it and saves to it with {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S.</p>
          <button className="primary" onClick={onChoose}>
            Choose folder…
          </button>
        </>
      ) : !access ? (
        <>
          <p className="muted">
            Flowboard needs your OK to use <strong>{folder}</strong> again this visit.
          </p>
          <div className="ws-actions">
            <button className="primary" onClick={onAllow}>
              Allow access
            </button>
            <button className="textbtn" onClick={onChoose}>
              Choose another folder…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ws-folder">
            <span title="Workspace folder">📁 {folder}</span>
            <button className="textbtn" onClick={onChoose}>
              Change…
            </button>
          </div>
          <div className="ws-actions">
            <button className="primary" onClick={onSave}>
              {current ? `Save to ${current}` : 'Save to workspace'}
            </button>
            <button className="textbtn" onClick={onSaveAs}>
              Save as…
            </button>
            <button className="textbtn" onClick={onRefresh}>
              Refresh
            </button>
          </div>
          {files === null ? (
            <p className="muted">Reading the folder…</p>
          ) : files.length === 0 ? (
            <p className="muted">No charts here yet. Save this one to start.</p>
          ) : (
            <ul className="ws-files">
              {files.map((f) => (
                <li key={f.path}>
                  <button className={f.path === current ? 'on' : ''} onClick={() => onOpen(f)} title={`Open ${f.path}`}>
                    <span className="ws-name">{f.path}</span>
                    <span className="ws-when">{when(f.modified)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {supported && recent.length > 0 && (
        <div className="ws-recent">
          <span className="ws-label">Workspaces</span>
          <ul className="ws-files">
            {recent.map((r, i) => (
              <li key={`${r.name}-${i}`} className="ws-row">
                <button className={r.current ? 'on' : ''} onClick={() => !r.current && onSwitch(i)} title={r.current ? 'Current workspace' : `Switch to ${r.name}`}>
                  <span className="ws-name">📁 {r.name}</span>
                  <span className="ws-when">{r.current ? 'current' : ''}</span>
                </button>
                {!r.current && (
                  <button className="ws-x" aria-label={`Remove ${r.name} from the list`} title="Remove from the list (the folder is not touched)" onClick={() => onForget(i)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
