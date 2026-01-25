import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { LazyStore } from "@tauri-apps/plugin-store";
import "./App.css";

type ClientStatus = "OK" | "Missing folders" | "Not a client";

type ClientInfo = {
  name: string;
  path: string;
  status: ClientStatus;
  missing: string[];
};

type SortEntry = {
  timestamp: string;
  username: string;
  mode: string;
  client: string;
  operation: string;
  source_path: string;
  dest_path: string;
  result: string;
  error_message: string;
};

type SortResult = {
  processed: number;
  failed: number;
  skipped: number;
  entries: SortEntry[];
  log_path: string;
};

type UndoEntry = {
  source_path: string;
  dest_path: string;
  operation: string;
};

type UndoResult = {
  processed: number;
  failed: number;
  entries: { source_path: string; dest_path: string; result: string; error_message: string }[];
};

type SortProgress = {
  processed: number;
  total: number;
  current: string;
  result: string;
};

const CONFIG_STORE = new LazyStore("config.json", {
  autoSave: true,
  defaults: {},
});

const MODES = [
  "VIDEO PROXY",
  "VIDEO RAW",
  "AUDIO CLEAN",
  "AUDIO RAW",
  "STILLS",
  "EXPORTS",
];

export default function App() {
  const [screen, setScreen] = useState<"home" | "sort">("home");
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showNonClients, setShowNonClients] = useState(false);
  const [mode, setMode] = useState<string>("VIDEO RAW");
  const [showApprovalMode, setShowApprovalMode] = useState(false);
  const [operation, setOperation] = useState<"move" | "copy">("move");
  const [dryRun, setDryRun] = useState(false);
  const [progress, setProgress] = useState<SortProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>("");
  const [lastBatch, setLastBatch] = useState<UndoEntry[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newClientName, setNewClientName] = useState("");

  useEffect(() => {
    const loadConfig = async () => {
      await CONFIG_STORE.init();
      const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
      const savedShowNonClients = await CONFIG_STORE.get<boolean>("showNonClients");
      const savedMode = await CONFIG_STORE.get<string>("lastMode");
      const savedOperation = await CONFIG_STORE.get<string>("lastOperation");
      const savedApproval = await CONFIG_STORE.get<boolean>("showApprovalMode");

      if (typeof savedRoot === "string") {
        setProjectRoot(savedRoot);
      }
      if (typeof savedShowNonClients === "boolean") {
        setShowNonClients(savedShowNonClients);
      }
      if (typeof savedMode === "string") {
        setMode(savedMode);
      }
      if (savedOperation === "copy" || savedOperation === "move") {
        setOperation(savedOperation);
      }
      if (typeof savedApproval === "boolean") {
        setShowApprovalMode(savedApproval);
      }

      if (typeof savedRoot === "string") {
        await refreshClients(savedRoot);
      }
    };

    const unlistenPromise = listen<SortProgress>("sort-progress", (event) => {
      setProgress(event.payload);
    });

    loadConfig().catch(console.error);

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  const modeOptions = useMemo(() => {
    const options = [...MODES];
    if (showApprovalMode) {
      options.push("APPROVAL EXPORTS");
    }
    return options;
  }, [showApprovalMode]);

  const visibleClients = useMemo(() => {
    const filtered = clients.filter((client) =>
      client.name.toLowerCase().includes(search.toLowerCase())
    );
    if (showNonClients) {
      return filtered;
    }
    return filtered.filter((client) => client.status !== "Not a client");
  }, [clients, search, showNonClients]);

  const sortableClients = useMemo(
    () => clients.filter((client) => client.status !== "Not a client"),
    [clients]
  );

  const saveConfigValue = async (key: string, value: unknown) => {
    await CONFIG_STORE.set(key, value);
    await CONFIG_STORE.save();
  };

  const refreshClients = async (rootOverride?: string) => {
    const root = rootOverride ?? projectRoot;
    if (!root) return;
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<ClientInfo[]>("scan_project_root", {
        projectRoot: root,
      });
      setClients(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const pickProjectRoot = async () => {
    const selection = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Project Root",
    });

    if (typeof selection === "string") {
      setProjectRoot(selection);
      await saveConfigValue("projectRoot", selection);
      await refreshClients(selection);
    }
  };

  const handleAddClient = async () => {
    if (!projectRoot) {
      setError("Choose a Project Root first.");
      return;
    }
    const trimmed = newClientName.trim();
    if (!trimmed) return;

    try {
      await invoke("create_client", {
        projectRoot,
        clientName: trimmed,
      });
      setShowAddModal(false);
      setNewClientName("");
      await refreshClients();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleFixClient = async (client: ClientInfo) => {
    try {
      await invoke("fix_client", {
        projectRoot,
        clientName: client.name,
      });
      await refreshClients();
    } catch (err) {
      setError(String(err));
    }
  };

  const buildUndoBatch = (entries: SortEntry[]): UndoEntry[] => {
    return entries
      .filter((entry) => entry.result === "ok")
      .map((entry) => ({
        source_path: entry.source_path,
        dest_path: entry.dest_path,
        operation: entry.operation,
      }));
  };

  const handleSortDrop = async (client: ClientInfo, paths: string[]) => {
    if (!projectRoot) {
      setError("Choose a Project Root first.");
      return;
    }
    if (!paths.length) {
      setError("No files detected in drop.");
      return;
    }
    if (busy) return;

    setBusy(true);
    setError(null);
    setProgress({ processed: 0, total: paths.length, current: "", result: "" });
    try {
      const result = await invoke<SortResult>("sort_files", {
        projectRoot,
        clientName: client.name,
        mode,
        operation,
        dryRun,
        paths,
      });
      setLastBatch(buildUndoBatch(result.entries));
      setLastSummary(
        `${result.processed} processed • ${result.failed} failed • ${result.skipped} skipped`
      );
      await refreshClients();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!lastBatch.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<UndoResult>("undo_batch", {
        entries: lastBatch,
      });
      setLastSummary(
        `Undo complete • ${result.processed - result.failed} ok • ${result.failed} failed`
      );
      setLastBatch([]);
      await refreshClients();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFolder = async (path: string) => {
    if (!path) return;
    await openPath(path);
  };

  const handleLogOpen = async () => {
    if (!projectRoot) return;
    await openPath(`${projectRoot}/_logs`);
  };

  const handleDropEvent = (event: DragEvent<HTMLDivElement>, client: ClientInfo) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const paths = files
      .map((file) => (file as unknown as { path?: string }).path)
      .filter((path): path is string => typeof path === "string");
    handleSortDrop(client, paths);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="project-root">
          <div className="label">Project Root</div>
          <div className="path">{projectRoot || "Not set"}</div>
        </div>
        <div className="topbar-actions">
          <button className="ghost" onClick={pickProjectRoot}>
            Change…
          </button>
          {screen === "home" ? (
            <>
              <input
                className="search"
                placeholder="Search clients…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button className="ghost" onClick={() => refreshClients()}>
                Refresh
              </button>
              <button
                className="primary"
                onClick={() => setShowAddModal(true)}
              >
                Add Client
              </button>
              <button className="accent" onClick={() => setScreen("sort")}>
                Sort Mode
              </button>
            </>
          ) : (
            <>
              <label className="select compact">
                <span>Mode</span>
                <select
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value);
                    saveConfigValue("lastMode", event.target.value);
                  }}
                >
                  {modeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle compact">
                <input
                  type="checkbox"
                  checked={operation === "copy"}
                  onChange={(event) => {
                    const next = event.target.checked ? "copy" : "move";
                    setOperation(next);
                    saveConfigValue("lastOperation", next);
                  }}
                />
                Copy
              </label>
              <label className="toggle compact">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(event) => setDryRun(event.target.checked)}
                />
                Dry run
              </label>
              <label className="toggle compact">
                <input
                  type="checkbox"
                  checked={showApprovalMode}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setShowApprovalMode(checked);
                    saveConfigValue("showApprovalMode", checked);
                    if (!checked && mode === "APPROVAL EXPORTS") {
                      setMode("EXPORTS");
                      saveConfigValue("lastMode", "EXPORTS");
                    }
                  }}
                />
                Approval exports
              </label>
              <button className="ghost" onClick={() => setScreen("home")}>
                Back
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      {screen === "home" && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">Clients</div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={showNonClients}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setShowNonClients(checked);
                  saveConfigValue("showNonClients", checked);
                }}
              />
              Show non-client folders
            </label>
          </div>
          <div className="table">
            <div className="table-row table-head">
              <div>Client Name</div>
              <div>Status</div>
              <div>Actions</div>
            </div>
            {loading && <div className="table-row">Loading…</div>}
            {!loading && visibleClients.length === 0 && (
              <div className="table-row">No clients found.</div>
            )}
            {!loading &&
              visibleClients.map((client) => (
                <div className="table-row" key={client.name}>
                  <div>
                    <div className="client-name">{client.name}</div>
                    {client.status === "Missing folders" && (
                      <div className="missing">
                        Missing: {client.missing.join(", ")}
                      </div>
                    )}
                  </div>
                  <div>
                    <span
                      className={`badge ${client.status
                        .toLowerCase()
                        .replace(/\s/g, "-")}`}
                    >
                      {client.status}
                    </span>
                  </div>
                  <div className="actions">
                    <button
                      className="ghost"
                      onClick={() => handleOpenFolder(client.path)}
                    >
                      Open
                    </button>
                    {client.status === "Missing folders" && (
                      <button
                        className="ghost"
                        onClick={() => handleFixClient(client)}
                      >
                        Fix
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {screen === "sort" && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">Sort Mode</div>
            <div className="client-meta">Drop onto a client row to sort.</div>
          </div>

          <div className={`drop-grid ${busy ? "busy" : ""}`}>
            {sortableClients.map((client) => (
              <div
                key={client.name}
                className="drop-row"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDropEvent(event, client)}
              >
                <div>
                  <div className="client-name">{client.name}</div>
                  <div className="client-meta">{client.status}</div>
                </div>
                <div className="drop-hint">Drop files or folders here</div>
              </div>
            ))}
            {sortableClients.length === 0 && (
              <div className="empty">No valid clients to sort into.</div>
            )}
          </div>
        </section>
      )}

      <footer className="status">
        <div>
          {busy && progress
            ? `Processing ${progress.processed}/${progress.total}`
            : "Ready"}
          {progress?.current && <span> • {progress.current}</span>}
        </div>
        <div className="status-actions">
          <span>{lastSummary || "No operations yet."}</span>
          <button className="ghost" onClick={handleUndo} disabled={!lastBatch.length}>
            Undo last
          </button>
          <button className="ghost" onClick={handleLogOpen} disabled={!projectRoot}>
            View log
          </button>
        </div>
      </footer>

      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Add Client</h2>
            <p>Creates a new client folder with the full template.</p>
            <input
              placeholder="Client name"
              value={newClientName}
              onChange={(event) => setNewClientName(event.target.value)}
            />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button className="primary" onClick={handleAddClient}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
