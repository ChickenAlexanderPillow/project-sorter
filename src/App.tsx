import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { LazyStore } from "@tauri-apps/plugin-store";
import { cursorPosition, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { type DragDropEvent } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { check } from "@tauri-apps/plugin-updater";
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


const MODE_ACCEPTED: Record<string, string[]> = {
  "VIDEO PROXY": [
    "mov",
    "mp4",
    "mxf",
    "mkv",
    "avi",
    "mpg",
    "mpeg",
    "m4v",
    "webm",
    "r3d",
  ],
  "VIDEO RAW": [
    "mov",
    "mp4",
    "mxf",
    "mkv",
    "avi",
    "mpg",
    "mpeg",
    "m4v",
    "webm",
    "r3d",
  ],
  "AUDIO CLEAN": ["wav", "mp3", "aif", "aiff", "flac", "m4a", "aac", "ogg", "opus"],
  "AUDIO RAW": ["wav", "mp3", "aif", "aiff", "flac", "m4a", "aac", "ogg", "opus"],
  STILLS: ["jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "webp", "bmp", "gif"],
};

const acceptedForMode = (mode: string) =>
  mode === "AUTO" ? null : MODE_ACCEPTED[mode] ?? null;
const CURSOR_Y_OFFSET = -20;
const DEBUG_ENABLED = false;

const getExtension = (path: string) => {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "";
  return path.slice(lastDot + 1).toLowerCase();
};


const CLIENT_TYPES = ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"] as const;
type ClientType = (typeof CLIENT_TYPES)[number] | "CUSTOM";
type HuddleTemplate = "PHYSICAL" | "VIDEO_CALL";

const normalizeClientInput = (value: string) =>
  value.trim().replace(/\s+/g, "_").toUpperCase();

const parseClientLabel = (raw: string) => {
  const normalized = normalizeClientInput(raw);
  const parts = normalized.split("_").filter(Boolean);
  if (parts.length >= 2) {
    const typeCandidate = parts[parts.length - 1];
    if ((CLIENT_TYPES as readonly string[]).includes(typeCandidate)) {
      return {
        name: parts.slice(0, -1).join(" "),
        type: typeCandidate,
        normalized,
      };
    }
  }
  return { name: normalized.replace(/_/g, " "), type: null as string | null, normalized };
};

export default function App() {
  const [screen] = useState<"home" | "sort">("sort");
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showNonClients, setShowNonClients] = useState(false);
  const [mode] = useState<string>("AUTO");
  const [showApprovalMode, setShowApprovalMode] = useState(false);
  const [operation, setOperation] = useState<"move" | "copy">("move");
  const [dryRun, setDryRun] = useState(false);
  const [progress, setProgress] = useState<SortProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>("");
  const [lastBatch, setLastBatch] = useState<UndoEntry[]>([]);
  const [showAddInline, setShowAddInline] = useState(false);
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientType, setNewClientType] = useState<ClientType>("EXHIBITOR");
  const [customClientType, setCustomClientType] = useState("");
  const [huddleTemplate, setHuddleTemplate] = useState<HuddleTemplate>("PHYSICAL");
  const projectRootRef = useRef(projectRoot);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const hoverClientRef = useRef<string | null>(null);
  const sortableClientsRef = useRef<ClientInfo[]>([]);
  const busyRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const [debugPoint, setDebugPoint] = useState<{ x: number; y: number } | null>(null);
  const [debugInfo, setDebugInfo] = useState<{
    physical: { x: number; y: number };
    logical: { x: number; y: number };
    client: { x: number; y: number } | null;
  } | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "info" | "success" | "error" } | null>(
    null
  );
  const [queueMeta, setQueueMeta] = useState<{ queued: number; skipped: number } | null>(
    null
  );
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const debugHideTimeoutRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const lastDebugRef = useRef<{
    physical: { x: number; y: number };
    logical: { x: number; y: number };
    client: { x: number; y: number } | null;
  } | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const lastLogTsRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  const checkForUpdates = async (showResult = true) => {
    if (checkingForUpdates) return;
    setCheckingForUpdates(true);
    try {
      const update = await check();
      if (!update) {
        if (showResult) {
          setToast({ message: "Pepper is up to date.", tone: "info" });
        }
        return;
      }

      const shouldInstall = window.confirm(
        `Pepper ${update.version} is available. Install it now?\n\n${update.body ?? ""}`
      );
      if (shouldInstall) {
        await update.downloadAndInstall();
      } else if (showResult) {
        setToast({ message: "Update postponed.", tone: "info" });
      }
    } catch (err) {
      // Update failures should never prevent Pepper from opening or working offline.
      console.warn("Update check failed", err);
      if (showResult) {
        setToast({ message: "Could not check for updates.", tone: "error" });
      }
    } finally {
      setCheckingForUpdates(false);
    }
  };

  useEffect(() => {
    void checkForUpdates(false);
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const applySize = async () => {
      try {
        if (screen === "sort") {
          await appWindow.setSize(new LogicalSize(560, 520));
          await appWindow.setMinSize(new LogicalSize(520, 480));
        } else {
          await appWindow.setSize(new LogicalSize(1024, 700));
          await appWindow.setMinSize(new LogicalSize(900, 600));
        }
      } catch (err) {
        console.error(err);
      }
    };
    applySize();
  }, [screen]);


  useEffect(() => {
    const loadConfig = async () => {
      await CONFIG_STORE.init();
      const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
      const savedShowNonClients = await CONFIG_STORE.get<boolean>("showNonClients");
      const savedMode = await CONFIG_STORE.get<string>("lastMode");
      const savedOperation = await CONFIG_STORE.get<string>("lastOperation");
      const savedApproval = await CONFIG_STORE.get<boolean>("showApprovalMode");
      const savedAlwaysOnTop = await CONFIG_STORE.get<boolean>("alwaysOnTop");

      if (typeof savedRoot === "string") {
        setProjectRoot(savedRoot);
      }
      if (typeof savedShowNonClients === "boolean") {
        setShowNonClients(savedShowNonClients);
      }
      if (typeof savedMode === "string" && savedMode !== "AUTO") {
        await CONFIG_STORE.set("lastMode", "AUTO");
      }
      if (savedOperation === "copy" || savedOperation === "move") {
        setOperation(savedOperation);
      }
      if (typeof savedApproval === "boolean") {
        setShowApprovalMode(savedApproval);
      }
      if (typeof savedAlwaysOnTop === "boolean") {
        setAlwaysOnTop(savedAlwaysOnTop);
        getCurrentWindow()
          .setAlwaysOnTop(savedAlwaysOnTop)
          .catch(() => undefined);
      }

      if (typeof savedRoot === "string") {
        await refreshClients(savedRoot);
      }
    };

    const unlistenPromise = listen<SortProgress>("sort-progress", (event) => {
      setProgress(event.payload);
    });
    const unlistenClientsPromise = listen<string>("clients-changed", () => {
      const root = projectRootRef.current;
      if (!root) return;
      if (busyRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      refreshClients(root, false).catch(console.error);
    });

    loadConfig().catch(console.error);

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
      unlistenClientsPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  const showToast = (
    message: string,
    tone: "info" | "success" | "error" = "info",
    duration: number | null = 3000
  ) => {
    setToast({ message, tone });
    if (toastTimeoutRef.current) {
      window.clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    if (duration !== null) {
      toastTimeoutRef.current = window.setTimeout(() => {
        setToast(null);
        toastTimeoutRef.current = null;
      }, duration);
    }
  };

  const processingToast =
    busy && progress && queueMeta
      ? {
          message: `Processing ${progress.processed}/${progress.total} • Queued ${queueMeta.queued} • Skipped ${queueMeta.skipped}`,
          tone: "info" as const,
        }
      : null;

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const setWatcher = async () => {
      try {
        await invoke("set_watch_root", { projectRoot });
      } catch (err) {
        if (projectRoot) {
          setError(String(err));
        }
      }
    };
    setWatcher();
  }, [projectRoot]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        window.clearTimeout(toastTimeoutRef.current);
      }
      if (debugHideTimeoutRef.current) {
        window.clearTimeout(debugHideTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showAdvancedMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAdvancedMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [showAdvancedMenu]);


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

  useEffect(() => {
    sortableClientsRef.current = sortableClients;
  }, [sortableClients]);

  const resolveDropClient = () => {
    if (hoverClientRef.current) return hoverClientRef.current;
    const cursor = lastCursorRef.current;
    if (!cursor) return null;
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".droppable-row[data-client]")
    );
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (
        cursor.x >= rect.left &&
        cursor.x <= rect.right &&
        cursor.y >= rect.top &&
        cursor.y <= rect.bottom
      ) {
        return row.dataset.client ?? null;
      }
    }
    return null;
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const attach = async () => {
      const appWindow = getCurrentWindow();
      const unlistenFn = await appWindow.onDragDropEvent(async (event) => {
        const payload = event.payload as DragDropEvent;
        if (screen !== "sort") return;
        if (payload.type === "leave") {
          setDragTarget(null);
          hoverClientRef.current = null;
          setDragActive(false);
          return;
        }

        setDragActive(true);
        if (DEBUG_ENABLED) {
          setDebugInfo({
            physical: { x: payload.position.x, y: payload.position.y },
            logical: { x: payload.position.x, y: payload.position.y },
            client: lastCursorRef.current,
          });
          lastDebugRef.current = {
            physical: { x: payload.position.x, y: payload.position.y },
            logical: { x: payload.position.x, y: payload.position.y },
            client: lastCursorRef.current,
          };
          setCopiedDebug(false);
          if (debugHideTimeoutRef.current) {
            window.clearTimeout(debugHideTimeoutRef.current);
          }
          debugHideTimeoutRef.current = window.setTimeout(() => {
            setDebugPoint(null);
            setDebugInfo(null);
          }, 8000);
        }

        // Hover highlighting is driven by cursor polling for accuracy.

        if (payload.type === "drop") {
          const dropClient = resolveDropClient();
          setDragTarget(null);
          setDragActive(false);
          if (!dropClient) {
            setError("Drop files on a client row.");
            return;
          }
          const client = sortableClientsRef.current.find(
            (entry) => entry.name === dropClient
          );
          if (!client) {
            setError("Drop target not found.");
            return;
          }
          if (!payload.paths || payload.paths.length === 0) {
            setError("No files were dropped.");
            return;
          }
          const allowed = acceptedForMode(mode);
          if (allowed) {
            const filtered = payload.paths.filter((path) => {
              const ext = getExtension(path);
              return !ext || allowed.includes(ext);
            });
            const skipped = payload.paths.length - filtered.length;
            if (filtered.length === 0) {
              setError(
                `Mode ${mode} only accepts: ${allowed.join(", ")}. Files dropped: ${payload.paths
                  .map(getExtension)
                  .filter(Boolean)
                  .join(", ") || "no extensions"}`
              );
              return;
            }
            handleSortDrop(client, filtered, { queued: filtered.length, skipped });
            return;
          }
          handleSortDrop(client, payload.paths, { queued: payload.paths.length, skipped: 0 });
        }
      });
      unlisten = unlistenFn;
    };

    attach().catch(console.error);

    return () => {
      if (unlisten) unlisten();
    };
  }, [screen]);

  useEffect(() => {
    if (!dragActive) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const [cursor, innerPos, scale] = await Promise.all([
          cursorPosition(),
          getCurrentWindow().innerPosition(),
          getCurrentWindow().scaleFactor(),
        ]);
        const local = {
          x: (cursor.x - innerPos.x) / scale,
          y: (cursor.y - innerPos.y) / scale,
        };
        const adjusted = { x: local.x, y: local.y + CURSOR_Y_OFFSET };
        lastCursorRef.current = local;
        if (DEBUG_ENABLED) {
          setDebugInfo((prev) =>
            prev
              ? { ...prev, client: adjusted }
              : { physical: { x: 0, y: 0 }, logical: { x: 0, y: 0 }, client: adjusted }
          );
          setDebugPoint(adjusted);
          lastDebugRef.current = lastDebugRef.current
            ? { ...lastDebugRef.current, client: adjusted }
            : { physical: { x: 0, y: 0 }, logical: { x: 0, y: 0 }, client: adjusted };
          const now = Date.now();
          if (now - lastLogTsRef.current > 200) {
            const snapshot = lastDebugRef.current;
            if (snapshot) {
              const line = `phys:${Math.round(snapshot.physical.x)},${Math.round(
                snapshot.physical.y
              )} log:${Math.round(snapshot.logical.x)},${Math.round(
                snapshot.logical.y
              )} client:${Math.round(local.x)},${Math.round(local.y)}`;
              invoke("append_debug_log", { message: line }).catch(() => undefined);
              lastLogTsRef.current = now;
            }
          }
          if (debugHideTimeoutRef.current) {
            window.clearTimeout(debugHideTimeoutRef.current);
          }
          debugHideTimeoutRef.current = window.setTimeout(() => {
            setDebugPoint(null);
            setDebugInfo(null);
          }, 8000);
        }
        const target = document.elementFromPoint(adjusted.x, adjusted.y);
        const row = target?.closest?.(".droppable-row") as HTMLElement | null;
        if (row?.dataset?.client) {
          hoverClientRef.current = row.dataset.client;
          setDragTarget(row.dataset.client);
        }
      } catch {
        // ignore polling errors
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(poll, 100);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [dragActive]);

  const saveConfigValue = async (key: string, value: unknown) => {
    await CONFIG_STORE.set(key, value);
    await CONFIG_STORE.save();
  };

  const refreshClients = async (rootOverride?: string, showLoading = true) => {
    const root = rootOverride ?? projectRoot;
    if (!root) return;
    const scrollTop = tableScrollRef.current?.scrollTop ?? 0;
    if (showLoading) {
      setLoading(true);
    }
    setError(null);
    try {
      const data = await invoke<ClientInfo[]>("scan_project_root", {
        projectRoot: root,
      });
      setClients(data);
      window.requestAnimationFrame(() => {
        if (tableScrollRef.current) {
          tableScrollRef.current.scrollTop = scrollTop;
        }
      });
    } catch (err) {
      setError(String(err));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
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
    const baseName = newClientName.trim();
    if (!baseName) return;
    const customType = normalizeClientInput(customClientType);
    if (newClientType === "CUSTOM" && !customType) {
      setError("Enter a custom mode name.");
      return;
    }
    const normalized = normalizeClientInput(
      `${baseName}_${newClientType === "CUSTOM" ? customType : newClientType}`
    );
    if (!normalized) return;
    const parsed = parseClientLabel(normalized);
    if (!parsed.type && newClientType !== "CUSTOM") {
      setError(
        "Client name must include a valid client mode."
      );
      return;
    }

    try {
      await invoke("create_client", {
        projectRoot,
        clientName: normalized,
        clientType: newClientType,
        huddleTemplate: newClientType === "HUDDLE" ? huddleTemplate : null,
      });
      setShowAddInline(false);
      setNewClientName("");
      setNewClientType("EXHIBITOR");
      setCustomClientType("");
      setHuddleTemplate("PHYSICAL");
      await refreshClients(undefined, false);
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

  const handleSortDrop = async (
    client: ClientInfo,
    paths: string[],
    meta?: { queued: number; skipped: number }
  ) => {
    let root = projectRoot;
    if (!root) {
      try {
        await CONFIG_STORE.init();
        const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
        if (typeof savedRoot === "string" && savedRoot.trim()) {
          root = savedRoot;
          setProjectRoot(savedRoot);
        }
      } catch {
        // fall through to error
      }
    }
    if (!root) {
      setError("Choose a Project Root first (or reselect it if the app lost it).");
      return;
    }
    if (!paths.length) {
      setError("No files detected in drop.");
      return;
    }
    if (busy) return;

    setBusy(true);
    setError(null);
    if (meta) {
      setQueueMeta(meta);
    } else {
      const queued = paths.length;
      setQueueMeta({ queued, skipped: 0 });
    }
    setProgress({ processed: 0, total: paths.length, current: "", result: "" });
    try {
      const result = await invoke<SortResult>("sort_files", {
        projectRoot: root,
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
      showToast(
        `Complete • ${result.processed} processed • ${result.failed} failed • ${result.skipped} skipped`,
        result.failed ? "error" : "success",
        5000
      );
      await refreshClients(undefined, false);
    } catch (err) {
      setError(String(err));
      showToast(`Transfer failed: ${String(err)}`, "error", 5000);
    } finally {
      setBusy(false);
      setQueueMeta(null);
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        await refreshClients(root, false);
      }
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

  const formatOpenError = (path: string, err: unknown) => {
    const message = String(err ?? "");
    const lower = message.toLowerCase();
    if (
      lower.includes("not allowed") ||
      lower.includes("permission") ||
      lower.includes("access is denied") ||
      lower.includes("denied")
    ) {
      return `Failed to open folder: ${path}. Access blocked by app permissions or OS policy. If this is a network drive, confirm it is mapped for this user and reopen the app. Details: ${message}`;
    }
    return `Failed to open folder: ${path}. ${message}`;
  };

  const handleOpenFolder = async (path: string) => {
    if (!path) return;
    try {
      await invoke("open_folder", { path });
    } catch (err) {
      setError(formatOpenError(path, err));
    }
  };

  const handleLogOpen = async () => {
    if (!projectRoot) return;
    try {
      await invoke("open_folder", { path: `${projectRoot}/_logs` });
    } catch (err) {
      setError(formatOpenError(`${projectRoot}/_logs`, err));
    }
  };

  const handleDropEvent = (event: DragEvent<HTMLDivElement>, client: ClientInfo) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const paths = files
      .map((file) => (file as unknown as { path?: string }).path)
      .filter((path): path is string => typeof path === "string");
    const allowed = acceptedForMode(mode);
    if (allowed) {
      const filtered = paths.filter((path) => {
        const ext = getExtension(path);
        return !ext || allowed.includes(ext);
      });
      const skipped = paths.length - filtered.length;
      if (filtered.length === 0) {
        setError(
          `Mode ${mode} only accepts: ${allowed.join(", ")}. Files dropped: ${paths
            .map(getExtension)
            .filter(Boolean)
            .join(", ") || "no extensions"}`
        );
        return;
      }
      setDragTarget(null);
      handleSortDrop(client, filtered, { queued: filtered.length, skipped });
      return;
    }
    setDragTarget(null);
    handleSortDrop(client, paths, { queued: paths.length, skipped: 0 });
  };

  const handleSortDragOver = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (DEBUG_ENABLED) {
      if (lastLogTsRef.current === 0) {
        invoke("clear_debug_log", {}).catch(() => undefined);
        lastLogTsRef.current = Date.now();
      }
      setDebugInfo((prev) =>
        prev
          ? {
              ...prev,
              client: { x: event.clientX, y: event.clientY },
            }
          : {
              physical: { x: 0, y: 0 },
              logical: { x: 0, y: 0 },
              client: { x: event.clientX, y: event.clientY },
            }
      );
    }
    try {
      await getCurrentWindow().setFocus();
    } catch {
      // ignore focus errors
    }
  };

  return (
    <div className={`app ${screen === "sort" ? "sort-mode" : ""}`}>
      {DEBUG_ENABLED && debugPoint && screen === "sort" && (
        <div className="debug-layer">
          <div className="debug-hit" style={{ left: debugPoint.x, top: debugPoint.y }} />
        </div>
      )}
      <header className="topbar">
        <div className="project-root">
          <div className="label">Project Root</div>
          {projectRoot ? (
            <button className="path-button" onClick={pickProjectRoot}>
              {projectRoot}
            </button>
          ) : (
            <button className="path-button empty" onClick={pickProjectRoot}>
              Select project root…
            </button>
          )}
        </div>
        <div className="topbar-actions">
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {(processingToast ?? toast) && (
        <div className={`toast ${(processingToast ?? toast)!.tone}`}>
          {(processingToast ?? toast)!.message}
        </div>
      )}

      <div className="app-content">
        <section className="panel">
          {DEBUG_ENABLED && debugInfo && (
            <div className="debug-info">
              <div className="debug-row">
                <span>phys:</span>
                <span>{Math.round(debugInfo.physical.x)}, {Math.round(debugInfo.physical.y)}</span>
              </div>
              <div className="debug-row">
                <span>log:</span>
                <span>{Math.round(debugInfo.logical.x)}, {Math.round(debugInfo.logical.y)}</span>
              </div>
              {debugInfo.client && (
                <div className="debug-row">
                  <span>client:</span>
                  <span>{Math.round(debugInfo.client.x)}, {Math.round(debugInfo.client.y)}</span>
                </div>
              )}
              <div className="debug-row">
                <span>note:</span>
                <span>auto-hides after 8s</span>
              </div>
              <button
                className="debug-toggle"
                onClick={async () => {
                  const payload = `phys: ${Math.round(debugInfo.physical.x)}, ${Math.round(
                    debugInfo.physical.y
                  )}\nlog: ${Math.round(debugInfo.logical.x)}, ${Math.round(
                    debugInfo.logical.y
                  )}\nclient: ${
                    debugInfo.client
                      ? `${Math.round(debugInfo.client.x)}, ${Math.round(debugInfo.client.y)}`
                      : "n/a"
                  }`;
                  try {
                    await writeText(payload);
                    setCopiedDebug(true);
                  } catch (err) {
                    setError(`Clipboard failed: ${String(err)}`);
                  }
                }}
              >
                {copiedDebug ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          <div className="panel-header" />
          <div className="panel-tools">
            <div className="tool-row single">
              <input
                className="search panel"
                placeholder="Search clients…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="advanced-menu">
                <button
                  type="button"
                  className="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowAdvancedMenu((current) => !current);
                  }}
                >
                  ⋯
                </button>
              </div>
            </div>
          </div>
          {showAdvancedMenu && (
            <div className="advanced-overlay" onClick={() => setShowAdvancedMenu(false)}>
              <div
                className="advanced-popover fixed"
                onClick={(event) => event.stopPropagation()}
              >
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
                        saveConfigValue("lastMode", "AUTO");
                      }
                    }}
                  />
                  Approval exports
                </label>
                <label className="toggle compact">
                  <input
                    type="checkbox"
                    checked={alwaysOnTop}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setAlwaysOnTop(checked);
                      saveConfigValue("alwaysOnTop", checked);
                      getCurrentWindow()
                        .setAlwaysOnTop(checked)
                        .catch(() => undefined);
                    }}
                  />
                  Float on top
                </label>
                <label className="toggle compact">
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
                <button
                  type="button"
                  className="update-check-button ghost"
                  disabled={checkingForUpdates}
                  onClick={() => void checkForUpdates()}
                >
                  {checkingForUpdates ? "Checking…" : "Check for updates"}
                </button>
              </div>
            </div>
          )}
          <div
            className={`table-scroll ${busy ? "busy" : ""}`}
            onDragOver={screen === "sort" ? handleSortDragOver : undefined}
            ref={tableScrollRef}
          >
            <div className="table">
            <button
              className="table-row add-client-row"
              type="button"
              onClick={() => setShowAddInline(true)}
            >
              <span>+ Add client</span>
              <span className="add-client-hint">Choose a mode for the new folder</span>
            </button>
            {showAddInline && (
              <div className="table-row add-client-inline">
                <input
                  className="inline-input"
                  placeholder="Client name (e.g. Digitain)"
                  value={newClientName}
                  onChange={(event) => setNewClientName(event.target.value)}
                />
                <div className="inline-types">
                  {CLIENT_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={`type-chip ${
                        newClientType === type ? "selected" : ""
                      } ${type.toLowerCase()}`}
                      onClick={() => setNewClientType(type)}
                    >
                      {type}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`type-chip custom ${newClientType === "CUSTOM" ? "selected" : ""}`}
                    onClick={() => setNewClientType("CUSTOM")}
                  >
                    CUSTOM
                  </button>
                </div>
                {newClientType === "CUSTOM" && (
                  <input
                    className="inline-input custom-mode-input"
                    placeholder="Custom mode (e.g. WORKSHOP)"
                    value={customClientType}
                    onChange={(event) => setCustomClientType(event.target.value)}
                  />
                )}
                {newClientType === "HUDDLE" && (
                  <div className="huddle-options">
                    <span className="huddle-label">Interview type</span>
                    <label>
                      <input type="radio" name="huddle-template" checked={huddleTemplate === "PHYSICAL"} onChange={() => setHuddleTemplate("PHYSICAL")} />
                      In-person interview
                    </label>
                    <label>
                      <input type="radio" name="huddle-template" checked={huddleTemplate === "VIDEO_CALL"} onChange={() => setHuddleTemplate("VIDEO_CALL")} />
                      Video call · scene switching
                    </label>
                  </div>
                )}
                <div className="inline-actions">
                  <button
                    className="ghost"
                    onClick={() => {
                      setShowAddInline(false);
                      setNewClientName("");
                      setNewClientType("EXHIBITOR");
                      setCustomClientType("");
                      setHuddleTemplate("PHYSICAL");
                    }}
                  >
                    Cancel
                  </button>
                  <button className="primary" onClick={handleAddClient}>
                    Create
                  </button>
                </div>
              </div>
            )}
            <div className="table-row table-head">
              <div>Client Name</div>
              <div>Status</div>
              <div>Actions</div>
            </div>
            {loading && visibleClients.length === 0 && (
              <div className="table-row">Loading…</div>
            )}
            {visibleClients.length === 0 && !loading && (
              <div className="table-row">No clients found.</div>
            )}
            {visibleClients.map((client) => {
                const label = parseClientLabel(client.name);
                const droppable = screen === "sort" && client.status !== "Not a client";
                return (
                  <div
                    key={client.name}
                    className={`table-row ${droppable ? "droppable-row" : ""} ${
                      dragTarget === client.name ? "drag-over" : ""
                    }`}
                    data-client={droppable ? client.name : undefined}
                    onDragOver={
                      droppable
                        ? (event) => {
                            handleSortDragOver(event);
                            hoverClientRef.current = client.name;
                            setDragTarget(client.name);
                          }
                        : undefined
                    }
                    onDragEnter={
                      droppable
                        ? () => {
                            hoverClientRef.current = client.name;
                            setDragTarget(client.name);
                          }
                        : undefined
                    }
                    onDragLeave={
                      droppable
                        ? () => {
                            if (hoverClientRef.current === client.name) {
                              hoverClientRef.current = null;
                            }
                            setDragTarget((current) =>
                              current === client.name ? null : current
                            );
                          }
                        : undefined
                    }
                    onDrop={droppable ? (event) => handleDropEvent(event, client) : undefined}
                  >
                    <div>
                      <div className="client-title">
                        <span className="client-name">{label.name}</span>
                        {label.type && (
                          <span className={`client-tag ${label.type.toLowerCase()}`}>
                            {label.type}
                          </span>
                        )}
                      </div>
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
                        className="ghost icon-button"
                        onClick={() => handleOpenFolder(client.path)}
                        aria-label="Open folder"
                        title="Open folder"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 7.5C3 6.12 4.12 5 5.5 5H10L12 7H18.5C19.88 7 21 8.12 21 9.5V16.5C21 17.88 19.88 19 18.5 19H5.5C4.12 19 3 17.88 3 16.5V7.5Z"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      {client.status === "Missing folders" && (
                        <button
                          className="ghost icon-button"
                          onClick={() => handleFixClient(client)}
                          aria-label="Fix"
                          title="Fix"
                        >
                          <img src="/fix.png" alt="" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                </div>
              );
            })}
            </div>
          </div>
        </section>
      </div>

      <footer className="status">
        <div>
          <span className="mode-label">Auto routing</span>
          {busy && progress
            ? `Processing ${progress.processed}/${progress.total}`
            : "Ready"}
          {progress?.current && <span> • {progress.current}</span>}
        </div>
        <div className="status-actions">
          <span>{lastSummary || "No operations yet."}</span>
          <button
            className="ghost"
            onClick={() => setShowUndoConfirm(true)}
            disabled={!lastBatch.length}
          >
            Undo last
          </button>
          <button className="ghost" onClick={handleLogOpen} disabled={!projectRoot}>
            View log
          </button>
          <button className="ghost" onClick={() => refreshClients()} disabled={!projectRoot}>
            Refresh
          </button>
        </div>
      </footer>

      {showUndoConfirm && (
        <div className="modal-backdrop" onClick={() => setShowUndoConfirm(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Undo last action?</h2>
            <p>This will revert the most recent batch.</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setShowUndoConfirm(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={async () => {
                  setShowUndoConfirm(false);
                  await handleUndo();
                }}
              >
                Undo
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
