import * as Dialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useState } from "react"
import { api, type StorageDirectoryEntry, type StorageLocation } from "../api.js"
import { appIcons } from "../icons.js"

interface Props {
  open: boolean
  initialPath: string
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
}

const parentPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "") || "/"
  if (trimmed === "/") return "/"
  const slash = trimmed.lastIndexOf("/")
  return slash <= 0 ? "/" : trimmed.slice(0, slash)
}

const shortPath = (path: string): string => {
  if (path.length <= 54) return path
  const parts = path.split("/").filter(Boolean)
  if (parts.length <= 2) return path
  return `/${parts[0]}/.../${parts.slice(-2).join("/")}`
}

export const DirectoryPickerDialog = ({
  open,
  initialPath,
  disabled = false,
  onOpenChange,
  onSelect,
}: Props) => {
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<StorageDirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newDirName, setNewDirName] = useState("pi-wallpaper-engine")

  const canUseCurrent = currentPath !== null && !loading
  const atLocationRoot = currentPath !== null && locations.some((location) => location.path === currentPath)
  const currentLabel = useMemo(() => (currentPath ? shortPath(currentPath) : "Locations"), [currentPath])

  const loadLocations = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.storageLocations()
      setLocations(next)
      setCurrentPath(null)
      setEntries([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadDirectory = async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const listing = await api.storageDirectories(path)
      setCurrentPath(listing.path)
      setEntries(listing.entries)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setCreating(false)
    setNewDirName("pi-wallpaper-engine")
    if (initialPath) {
      void loadDirectory(initialPath)
      // Silently fetch locations so `atLocationRoot` can detect when we navigate up to a root.
      void api.storageLocations().then(setLocations).catch(console.error)
    } else {
      void loadLocations()
    }
  }, [open, initialPath])

  const createDirectory = async () => {
    if (!currentPath || !newDirName.trim()) return
    setLoading(true)
    setError(null)
    try {
      const created = await api.createStorageDirectory({
        parent: currentPath,
        name: newDirName.trim(),
      })
      setCreating(false)
      setNewDirName("pi-wallpaper-engine")
      await loadDirectory(created.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  const goBack = () => {
    if (!currentPath || atLocationRoot) {
      void loadLocations()
      return
    }
    void loadDirectory(parentPath(currentPath))
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="directory-dialog-overlay" />
        <Dialog.Content className="directory-dialog" aria-describedby="directory-dialog-desc">
          <div className="directory-dialog-header">
            <div>
              <Dialog.Title className="directory-dialog-title">Select media root</Dialog.Title>
              <Dialog.Description id="directory-dialog-desc" className="directory-dialog-desc">
                Choose a directory accessible on the Pi. The app will validate it first; migration will not start immediately.
              </Dialog.Description>
            </div>
            <Dialog.Close className="directory-dialog-close" aria-label="Close">
              {appIcons.close}
            </Dialog.Close>
          </div>

          <div className="directory-toolbar">
            <button
              type="button"
              className="btn btn-secondary directory-icon-btn"
              onClick={goBack}
              disabled={loading}
              aria-label={currentPath ? "Go up" : "Refresh locations"}
            >
              {currentPath ? appIcons.chevLeft : appIcons.refresh}
            </button>
            <div className="directory-current mono" title={currentPath ?? "Locations"}>
              {currentLabel}
            </div>
            <button
              type="button"
              className="btn btn-secondary directory-icon-btn"
              onClick={() => (currentPath ? loadDirectory(currentPath) : loadLocations())}
              disabled={loading}
              aria-label="Refresh"
            >
              {appIcons.refresh}
            </button>
          </div>

          {error && <div className="error-banner directory-error">{error}</div>}

          <div className="directory-list">
            {loading && <div className="empty-state directory-empty">Reading directory...</div>}
            {!loading && !currentPath && (
              <>
                {locations.map((location) => (
                  <button
                    key={`${location.id}:${location.path}`}
                    type="button"
                    className="directory-row"
                    onClick={() => void loadDirectory(location.path)}
                    disabled={disabled}
                  >
                    <span className="directory-row-icon">{appIcons.folder}</span>
                    <span className="directory-row-main">
                      <span>{location.label}</span>
                      <span className="directory-row-path mono">{location.display_path}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {!loading && currentPath && entries.length === 0 && (
              <div className="empty-state directory-empty">No subdirectories available.</div>
            )}
            {!loading &&
              currentPath &&
              entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="directory-row"
                  onClick={() => void loadDirectory(entry.path)}
                  disabled={disabled}
                >
                  <span className="directory-row-icon">{appIcons.folder}</span>
                  <span className="directory-row-main">
                    <span>{entry.name}</span>
                    <span className="directory-row-path mono">{entry.path}</span>
                  </span>
                </button>
              ))}
          </div>

          {currentPath && (
            <div className="directory-create">
              {creating ? (
                <>
                  <input
                    value={newDirName}
                    onChange={(event) => setNewDirName(event.target.value)}
                    disabled={loading}
                    aria-label="New folder name"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void createDirectory()}
                    disabled={loading || !newDirName.trim()}
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setCreating(false)}
                    disabled={loading}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCreating(true)}
                  disabled={loading || disabled}
                >
                  {appIcons.plus}
                  New folder
                </button>
              )}
            </div>
          )}

          <div className="directory-dialog-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (currentPath) onSelect(currentPath)
              }}
              disabled={!canUseCurrent || disabled}
            >
              Use this directory
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
