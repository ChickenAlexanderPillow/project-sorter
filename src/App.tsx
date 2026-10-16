import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { cursorPosition, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { type DragDropEvent } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, LoaderCircle, Maximize2, Minus, MoreHorizontal, Plus, RefreshCw, Search, Wrench, X } from "lucide-react";
import "./App.css";

type ClientStatus = "OK" | "Missing folders" | "Not a client";
type ClientSort = { column: "name" | "status"; direction: "asc" | "desc" };

type ClientInfo = {
  name: string;
  path: string;
  status: ClientStatus;
  missing: string[];
  export_status: ExportStatus;
  exportStatusLoading?: boolean;
};

type ClientScanProgress = {
  project_root: string;
  scan_id: number;
  phase: "clients" | "exports" | "complete";
  clients: ClientInfo[];
  export_updates: { name: string; export_status: ExportStatus }[];
  completed: number;
  total: number;
  reset: boolean;
  client_names: string[];
  partial: boolean;
  removed_names: string[];
};

type ClientsChanged = { project_root: string; client_names: string[]; all_clients: boolean };

type ExportVersion = {
  version: number;
  filename: string;
  relative_path: string;
  added_at: string;
};

type ExportStatus = {
  versions: ExportVersion[];
  latest_version: number | null;
  latest_filename: string | null;
  approval_ready: boolean;
  approval_in_progress: boolean;
  approval_progress_phase: string | null;
  final_version: number | null;
  final_filename: string | null;
  final_current: boolean;
  issue: string | null;
};

type ProjectRootOption = { name: string; path: string; number: number };

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

const formatProjectName = (name: string) => {
  const match = name.match(/^(\d+)[_\s-]+(.+)$/);
  return match ? `${match[1]} · ${match[2].replace(/_/g, " ")}` : name.replace(/_/g, " ");
};

const isFinalised = (client: ClientInfo) =>
  !client.export_status.issue && Boolean(
    client.export_status.final_current ||
    (client.export_status.final_filename && !client.export_status.latest_filename)
  );

export default function App() {
  const [screen] = useState<"home" | "sort">("sort");
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [projectRoots, setProjectRoots] = useState<ProjectRootOption[]>([]);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>([]);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [expandedClients, setExpandedClients] = useState<Set<string>>(() => new Set());
  const [selectedVersionByClient, setSelectedVersionByClient] = useState<Record<string, number>>({});
  const [clientSort, setClientSort] = useState<ClientSort>({ column: "status", direction: "asc" });
  const [publishingClientPath, setPublishingClientPath] = useState<string | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<ClientInfo | null>(null);
  const promotionDialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (pendingPromotion && !promotionDialogRef.current?.open) {
      promotionDialogRef.current?.showModal();
    }
  }, [pendingPromotion]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ phase: "clients" | "exports"; completed: number; total: number } | null>(null);
  const [lastClientsCheckedAt, setLastClientsCheckedAt] = useState<Date | null>(null);
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
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [showNewClientForm, setShowNewClientForm] = useState(false);
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
  const clientsScansInFlightRef = useRef(0);
  const clientsScanSequenceRef = useRef(0);
  const scanProgressVisibleRef = useRef(false);
  const watcherRefreshTimerRef = useRef<number | null>(null);
  const watcherRefreshPendingRef = useRef(false);
  const watcherRefreshAllRef = useRef(false);
  const watcherChangedClientsRef = useRef(new Set<string>());
  const lastWatcherRefreshAtRef = useRef(0);
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
  const initialUpdateCheckRef = useRef(false);
  const lastDebugRef = useRef<{
    physical: { x: number; y: number };
    logical: { x: number; y: number };
    client: { x: number; y: number } | null;
  } | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const lastLogTsRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const updateNotes = pendingUpdate?.body
    ?.split(/\r?\n/)
    .filter((line) => !/^Automatic signed Pepper build for commit\b/i.test(line.trim()))
    .join("\n")
    .trim();

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

      setPendingUpdate(update);
    } catch (err) {
      // Update failures should never prevent Pepper from opening or working offline.
      const errorMessage = err instanceof Error ? err.message : String(err);
      const noReleasePublished = /404|not found/i.test(errorMessage);
      if (noReleasePublished) {
        console.info("No GitHub release has been published yet.");
      } else {
        console.warn("Update check failed", err);
      }
      if (showResult) {
        setToast({
          message: noReleasePublished
            ? "No Pepper release has been published yet."
            : "Could not check for updates.",
          tone: noReleasePublished ? "info" : "error",
        });
      }
    } finally {
      setCheckingForUpdates(false);
    }
  };

  useEffect(() => {
    if (initialUpdateCheckRef.current) return;
    initialUpdateCheckRef.current = true;
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
      void invoke<ProjectRootOption[]>("list_project_roots")
        .then(setProjectRoots)
        .catch((err) => {
          console.error("Unable to load project folders", err);
          setError(`Unable to load project folders: ${String(err)}`);
        });
      await CONFIG_STORE.init();
      const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
      const savedShowNonClients = await CONFIG_STORE.get<boolean>("showNonClients");
      const savedMode = await CONFIG_STORE.get<string>("lastMode");
      const savedOperation = await CONFIG_STORE.get<string>("lastOperation");
      const savedApproval = await CONFIG_STORE.get<boolean>("showApprovalMode");
      const savedAlwaysOnTop = await CONFIG_STORE.get<boolean>("alwaysOnTop");
      const savedRecentProjectPaths = await CONFIG_STORE.get<string[]>("recentProjectPaths");
      const migratedRoots = (await CONFIG_STORE.get<string[]>("legacyFinalMigrationRoots")) ?? [];

      if (typeof savedRoot === "string") {
        setProjectRoot(savedRoot);
        projectRootRef.current = savedRoot;
      }
      if (Array.isArray(savedRecentProjectPaths)) {
        setRecentProjectPaths(savedRecentProjectPaths.filter((path): path is string => typeof path === "string"));
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
        await unlistenClientScanPromise;
        if (!migratedRoots.includes(savedRoot)) {
          try {
            const count = await invoke<number>("migrate_project_finals", { projectRoot: savedRoot });
            await CONFIG_STORE.set("legacyFinalMigrationRoots", [...migratedRoots, savedRoot]);
            if (count > 0) console.info(`Marked ${count} existing FINAL files as published.`);
          } catch (error) {
            console.error("Could not migrate existing FINAL status", error);
          }
        }
        await refreshClients(savedRoot);
      }
    };

    const unlistenPromise = listen<SortProgress>("sort-progress", (event) => {
      setProgress(event.payload);
    });
    const unlistenClientScanPromise = listen<ClientScanProgress>("clients-scan-progress", (event) => {
      const scan = event.payload;
      if (scan.scan_id !== clientsScanSequenceRef.current || scan.project_root !== projectRootRef.current) return;

      if (scan.phase === "clients") {
        if (scanProgressVisibleRef.current) {
          setScanProgress({ phase: "clients", completed: scan.completed, total: scan.total });
        }
        setClients((current) => {
          const existing = new Map(current.map((client) => [client.name, client]));
          const incoming = scan.clients.map((client) => ({
            ...(existing.get(client.name) ?? {}),
            ...client,
            export_status: existing.get(client.name)?.export_status ?? client.export_status,
            exportStatusLoading: scan.reset || !existing.has(client.name)
              ? client.status !== "Not a client"
              : existing.get(client.name)?.exportStatusLoading ?? false,
          }));
          if (scan.reset) return incoming;
          const received = new Set(incoming.map((client) => client.name));
          return [...current.filter((client) => !received.has(client.name)), ...incoming];
        });
      } else if (scan.phase === "exports") {
        if (scanProgressVisibleRef.current) {
          setScanProgress({ phase: "exports", completed: scan.completed, total: scan.total });
        }
        setClients((current) => current.map((client) => {
          const update = scan.export_updates.find((item) => item.name === client.name);
          if (!update) return client;
          const unchanged = JSON.stringify(client.export_status) === JSON.stringify(update.export_status);
          if (unchanged && !client.exportStatusLoading) return client;
          return { ...client, export_status: update.export_status, exportStatusLoading: false };
        }));
      } else {
        const currentNames = new Set(scan.client_names);
        if (scan.partial) {
          if (scan.removed_names.length) {
            const removedNames = new Set(scan.removed_names);
            setClients((current) => current.filter((client) => !removedNames.has(client.name)));
          }
        } else {
          setClients((current) => current.filter((client) => currentNames.has(client.name)));
        }
        setScanProgress(null);
        scanProgressVisibleRef.current = false;
      }
    });
    const unlistenClientsPromise = listen<ClientsChanged>("clients-changed", (event) => {
      const root = projectRootRef.current;
      if (!root || event.payload.project_root !== root) return;
      if (event.payload.all_clients) {
        watcherRefreshAllRef.current = true;
        watcherChangedClientsRef.current.clear();
      } else if (!watcherRefreshAllRef.current) {
        event.payload.client_names.forEach((name) => watcherChangedClientsRef.current.add(name));
      }
      if (!watcherRefreshAllRef.current && watcherChangedClientsRef.current.size === 0) return;
      if (busyRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      if (watcherRefreshTimerRef.current !== null) {
        window.clearTimeout(watcherRefreshTimerRef.current);
      }
      const elapsed = Date.now() - lastWatcherRefreshAtRef.current;
      const delay = Math.max(1_000, 5_000 - elapsed);
      watcherRefreshTimerRef.current = window.setTimeout(() => {
        watcherRefreshTimerRef.current = null;
        if (root !== projectRootRef.current) return;
        if (busyRef.current) {
          pendingRefreshRef.current = true;
          return;
        }
        if (clientsScansInFlightRef.current > 0) {
          watcherRefreshPendingRef.current = true;
          return;
        }
        lastWatcherRefreshAtRef.current = Date.now();
        const clientNames = watcherRefreshAllRef.current
          ? undefined
          : Array.from(watcherChangedClientsRef.current);
        watcherRefreshAllRef.current = false;
        watcherChangedClientsRef.current.clear();
        refreshClients(root, false, false, false, clientNames).catch(console.error);
      }, delay);
    });

    loadConfig().catch(console.error);

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
      unlistenClientScanPromise.then((unlisten) => unlisten()).catch(() => undefined);
      unlistenClientsPromise.then((unlisten) => unlisten()).catch(() => undefined);
      if (watcherRefreshTimerRef.current !== null) {
        window.clearTimeout(watcherRefreshTimerRef.current);
      }
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
    if (!showAdvancedMenu && !showProjectMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAdvancedMenu(false);
        setShowProjectMenu(false);
        setProjectSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [showAdvancedMenu, showProjectMenu]);

  const availableProjectRoots = useMemo(() => {
    const roots = [...projectRoots];
    if (projectRoot && !roots.some((project) => project.path === projectRoot)) {
      const projectPathParts = projectRoot.split(/[\\/]/).filter(Boolean);
      roots.push({ name: projectPathParts[projectPathParts.length - 1] ?? projectRoot, path: projectRoot, number: Number.MAX_SAFE_INTEGER });
    }
    return roots.sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));
  }, [projectRoot, projectRoots]);

  const visibleProjectRoots = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    return query
      ? availableProjectRoots.filter((project) => project.name.toLowerCase().includes(query))
      : availableProjectRoots;
  }, [availableProjectRoots, projectSearch]);

  const recentProjects = visibleProjectRoots.filter((project) => recentProjectPaths.includes(project.path));
  const otherProjects = visibleProjectRoots.filter((project) => !recentProjectPaths.includes(project.path));
  const activeProject = availableProjectRoots.find((project) => project.path === projectRoot);


  const visibleClients = useMemo(() => {
    const filtered = clients.filter((client) =>
      client.name.toLowerCase().includes(search.toLowerCase()) &&
      (showNonClients || client.status !== "Not a client")
    );
    return filtered.sort((left, right) => {
      const alphabetical = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      const direction = clientSort.direction === "asc" ? 1 : -1;
      if (clientSort.column === "name") return alphabetical * direction;
      const completionOrder = Number(isFinalised(left)) - Number(isFinalised(right));
      return completionOrder * direction || alphabetical;
    });
  }, [clients, search, showNonClients, clientSort]);

  const toggleClientSort = (column: ClientSort["column"]) => {
    setClientSort((current) => ({
      column,
      direction: current.column === column && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const sortIcon = (column: ClientSort["column"]) => {
    const Icon = clientSort.column !== column ? ArrowUpDown
      : clientSort.direction === "asc" ? ArrowUp : ArrowDown;
    return <Icon size={14} strokeWidth={1.8} aria-hidden="true" />;
  };

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

  const migrateLegacyFinalsOnce = async (root: string) => {
    const migratedRoots = (await CONFIG_STORE.get<string[]>("legacyFinalMigrationRoots")) ?? [];
    if (migratedRoots.includes(root)) return;
    const count = await invoke<number>("migrate_project_finals", { projectRoot: root });
    await CONFIG_STORE.set("legacyFinalMigrationRoots", [...migratedRoots, root]);
    if (count > 0) console.info(`Marked ${count} existing FINAL files as published.`);
  };

  const refreshClients = async (
    rootOverride?: string,
    showLoading = true,
    force = false,
    replaceExisting = false,
    clientNames?: string[]
  ) => {
    const root = rootOverride ?? projectRoot;
    if (!root || (clientsScansInFlightRef.current > 0 && !force)) return;
    const scanSequence = ++clientsScanSequenceRef.current;
    clientsScansInFlightRef.current += 1;
    const scrollTop = tableScrollRef.current?.scrollTop ?? 0;
    if (showLoading) {
      setLoading(true);
    }
    scanProgressVisibleRef.current = showLoading;
    if (showLoading) setScanProgress({ phase: "clients", completed: 0, total: 0 });
    setError(null);
    try {
      await invoke("scan_project_root", {
        projectRoot: root,
        scanId: scanSequence,
        replaceExisting,
        clientNames: clientNames ?? null,
      });
      if (scanSequence === clientsScanSequenceRef.current && root === projectRootRef.current) {
        window.requestAnimationFrame(() => {
          if (tableScrollRef.current) tableScrollRef.current.scrollTop = scrollTop;
        });
      }
    } catch (err) {
      if (scanSequence === clientsScanSequenceRef.current && root === projectRootRef.current) {
        setError(String(err));
      }
    } finally {
      clientsScansInFlightRef.current = Math.max(0, clientsScansInFlightRef.current - 1);
      if (scanSequence === clientsScanSequenceRef.current && root === projectRootRef.current) {
        setLastClientsCheckedAt(new Date());
        if (showLoading) setScanProgress(null);
        scanProgressVisibleRef.current = false;
      }
      if (showLoading && scanSequence === clientsScanSequenceRef.current) {
        setLoading(false);
      }
      if (watcherRefreshPendingRef.current && root === projectRootRef.current && !busyRef.current) {
        watcherRefreshPendingRef.current = false;
        window.setTimeout(() => {
          if (root === projectRootRef.current && clientsScansInFlightRef.current === 0 && !busyRef.current) {
            lastWatcherRefreshAtRef.current = Date.now();
            const clientNames = watcherRefreshAllRef.current
              ? undefined
              : Array.from(watcherChangedClientsRef.current);
            watcherRefreshAllRef.current = false;
            watcherChangedClientsRef.current.clear();
            void refreshClients(root, false, false, false, clientNames).catch(console.error);
          }
        }, 1_000);
      }
    }
  };

  const changeProjectRoot = async (nextRoot: string) => {
    if (nextRoot === projectRootRef.current) return;
    projectRootRef.current = nextRoot;
    if (watcherRefreshTimerRef.current !== null) {
      window.clearTimeout(watcherRefreshTimerRef.current);
      watcherRefreshTimerRef.current = null;
    }
    watcherRefreshAllRef.current = false;
    watcherChangedClientsRef.current.clear();
    watcherRefreshPendingRef.current = false;
    setProjectRoot(nextRoot);
    setClients([]);
    setExpandedClients(new Set());
    setSelectedVersionByClient({});
    setLastClientsCheckedAt(null);
    setError(null);
    setLoading(Boolean(nextRoot));
    if (!nextRoot) {
      setLoading(false);
      try {
        await saveConfigValue("projectRoot", "");
      } catch (err) {
        setError(`Could not save project selection: ${String(err)}`);
      }
      return;
    }
    try {
      await saveConfigValue("projectRoot", nextRoot);
      const nextRecentProjectPaths = [nextRoot, ...recentProjectPaths.filter((path) => path !== nextRoot)].slice(0, 4);
      setRecentProjectPaths(nextRecentProjectPaths);
      await saveConfigValue("recentProjectPaths", nextRecentProjectPaths);
    } catch (err) {
      setError(`Could not save project selection: ${String(err)}`);
    }
    try {
      await migrateLegacyFinalsOnce(nextRoot);
    } catch (err) {
      console.error("Could not migrate existing FINAL status", err);
    }
    await refreshClients(nextRoot, true, true, true);
  };

  useEffect(() => {
    if (!projectRoot || busy) return;
    const id = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        clientsScansInFlightRef.current === 0 &&
        !busyRef.current
      ) {
        void refreshClients(projectRoot, false).catch(console.error);
      }
    }, 120_000);
    return () => window.clearInterval(id);
  }, [projectRoot, busy, lastClientsCheckedAt]);

  const toggleClientExpanded = (name: string) => {
    setExpandedClients((current) => {
      return current.has(name) ? new Set() : new Set([name]);
    });
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
      setNewClientName("");
      setNewClientType("EXHIBITOR");
      setCustomClientType("");
      setHuddleTemplate("PHYSICAL");
      setShowNewClientForm(false);
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

  const handlePromoteLatest = async (client: ClientInfo) => {
    const exportStatus = client.export_status;
    if (!exportStatus.latest_filename || exportStatus.issue) return;
    setPendingPromotion(null);
    setPublishingClientPath(client.path);
    setError(null);
    try {
      const message = await invoke<string>("promote_latest_export", {
        clientPath: client.path,
        expectedFilename: exportStatus.latest_filename,
      });
      setToast({ message, tone: "success" });
      await refreshClients(undefined, false, true);
    } catch (err) {
      setError(`Publish failed: ${String(err)}`);
    } finally {
      setPublishingClientPath(null);
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
        watcherRefreshAllRef.current = false;
        watcherChangedClientsRef.current.clear();
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
      <header
        className="topbar"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest("button")) {
            void getCurrentWindow().startDragging();
          }
        }}
      >
        <div className="topbar-actions window-controls">
          <button
            type="button"
            className="window-control"
            aria-label="Minimize Pepper"
            title="Minimize"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label="Maximize Pepper"
            title="Maximize"
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            <Maximize2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label="Close Pepper"
            title="Close"
            onClick={() => void getCurrentWindow().close()}
          >
            <X size={15} aria-hidden="true" />
          </button>
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
          <div className="panel-project-root">
            <span className="label">Project</span>
            <div className="project-switcher">
              <button
                type="button"
                className="project-switcher-button"
                aria-haspopup="listbox"
                aria-expanded={showProjectMenu}
                onClick={() => {
                  setShowProjectMenu((current) => !current);
                  setProjectSearch("");
                }}
              >
                <span className={activeProject ? "project-switcher-value" : "project-switcher-value placeholder"}>
                  {activeProject ? formatProjectName(activeProject.name) : "Select a numbered project"}
                </span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              {showProjectMenu && (
                <>
                  <div
                    className="project-menu-scrim"
                    aria-hidden="true"
                    onClick={() => {
                      setShowProjectMenu(false);
                      setProjectSearch("");
                    }}
                  />
                  <div className="project-menu" role="listbox" aria-label="Production projects">
                    <div className="project-menu-search">
                      <Search size={15} aria-hidden="true" />
                      <input
                        autoFocus
                        type="search"
                        value={projectSearch}
                        onChange={(event) => setProjectSearch(event.target.value)}
                        placeholder="Find a project…"
                        aria-label="Find a project"
                      />
                    </div>
                    <div className="project-menu-scroll">
                      {recentProjects.length > 0 && (
                        <div className="project-group">
                          <div className="project-group-label">Recent</div>
                          {recentProjects.map((project) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={project.path === projectRoot}
                              className={`project-option ${project.path === projectRoot ? "selected" : ""}`}
                              key={`recent-${project.path}`}
                              onClick={() => {
                                setShowProjectMenu(false);
                                setProjectSearch("");
                                void changeProjectRoot(project.path);
                              }}
                            >
                              <span>{formatProjectName(project.name)}</span>
                              {project.path === projectRoot && <Check size={15} aria-hidden="true" />}
                            </button>
                          ))}
                        </div>
                      )}
                      {otherProjects.length > 0 && (
                        <div className="project-group">
                          {recentProjects.length > 0 && <div className="project-group-label">All projects</div>}
                          {otherProjects.map((project) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={project.path === projectRoot}
                              className={`project-option ${project.path === projectRoot ? "selected" : ""}`}
                              key={project.path}
                              onClick={() => {
                                setShowProjectMenu(false);
                                setProjectSearch("");
                                void changeProjectRoot(project.path);
                              }}
                            >
                              <span>{formatProjectName(project.name)}</span>
                              {project.path === projectRoot && <Check size={15} aria-hidden="true" />}
                            </button>
                          ))}
                        </div>
                      )}
                      {visibleProjectRoots.length === 0 && (
                        <div className="project-menu-empty">No projects match “{projectSearch}”.</div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
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
          <div className="panel-tools">
            <div className="tool-row single">
              <input
                className="search panel"
                placeholder="Search clients…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="button"
                className="ghost icon-button refresh-button"
                onClick={() => void refreshClients()}
                disabled={!projectRoot || loading}
                aria-label="Refresh clients"
                title="Refresh clients"
              >
                <RefreshCw size={17} strokeWidth={2} aria-hidden="true" />
              </button>
              <span className="refresh-checked" title={lastClientsCheckedAt?.toLocaleString() ?? "No scan completed yet"}>
                {lastClientsCheckedAt
                  ? `Updated ${lastClientsCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Not updated"}
              </span>
              <button
                type="button"
                className="ghost new-client-button"
                disabled={!projectRoot}
                aria-expanded={showNewClientForm}
                onClick={() => setShowNewClientForm((current) => !current)}
              >
                <Plus size={16} aria-hidden="true" />
                New client
              </button>
              <div className="advanced-menu">
                <button
                  type="button"
                  className="ghost icon-button"
                  aria-label="More options"
                  title="More options"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowAdvancedMenu((current) => !current);
                  }}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
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
                <div className="advanced-actions">
                  <button type="button" className="ghost" onClick={() => setShowUndoConfirm(true)} disabled={!lastBatch.length}>
                    Undo last
                  </button>
                  <button type="button" className="ghost" onClick={() => void handleLogOpen()} disabled={!projectRoot}>
                    View log
                  </button>
                </div>
              </div>
            </div>
          )}
          <div
            className={`table-scroll ${busy ? "busy" : ""}`}
            onDragOver={screen === "sort" ? handleSortDragOver : undefined}
            ref={tableScrollRef}
          >
            <div className="table">
              {showNewClientForm && <div className="table-row add-client-inline">
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
                <div className={`client-extra ${newClientType === "CUSTOM" || newClientType === "HUDDLE" ? "has-options" : ""}`}>
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
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="ghost icon-button inline-action-button"
                    aria-label="Cancel adding client"
                    title="Cancel"
                    onClick={() => {
                      setNewClientName("");
                      setNewClientType("EXHIBITOR");
                      setCustomClientType("");
                      setHuddleTemplate("PHYSICAL");
                      setShowNewClientForm(false);
                    }}
                  >
                    <X size={18} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="primary icon-button inline-action-button"
                    aria-label="Create client"
                    title="Create client"
                    onClick={handleAddClient}
                  >
                    <Check size={18} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </div>
              </div>}
            <div className="table-row table-head">
              <div>
                <button
                  type="button"
                  className={`column-sort ${clientSort.column === "name" ? "active" : ""}`}
                  onClick={() => toggleClientSort("name")}
                  aria-label={clientSort.column === "name" && clientSort.direction === "asc" ? "Client name: A to Z. Click to sort Z to A" : "Sort client names A to Z"}
                >
                  Client Name {sortIcon("name")}
                </button>
              </div>
              <div>
                <button
                  type="button"
                  className={`column-sort ${clientSort.column === "status" ? "active" : ""}`}
                  onClick={() => toggleClientSort("status")}
                  aria-label={clientSort.column === "status" && clientSort.direction === "asc" ? "Project status: unfinished first. Click to show finalised first" : "Sort project status: unfinished first"}
                  title={clientSort.column === "status" && clientSort.direction === "asc" ? "Show finalised projects first" : "Show unfinished projects first"}
                >
                  Project status {sortIcon("status")}
                </button>
              </div>
              <div>Actions</div>
            </div>
            {loading && visibleClients.length === 0 && (
              <div className="table-row">Loading…</div>
            )}
            {visibleClients.length === 0 && !loading && (
              <div className="table-row">
                {projectRoot ? "No clients found." : "Select a numbered project to view clients."}
              </div>
            )}
            {visibleClients.map((client) => {
                const label = parseClientLabel(client.name);
                const droppable = screen === "sort" && client.status !== "Not a client";
                const exports = client.export_status;
                const version = exports.latest_version ?? exports.final_version;
                const expanded = expandedClients.has(client.name);
                const published = isFinalised(client);
                const exportLabel = client.exportStatusLoading
                  ? "Loading exports…"
                  : exports.issue
                  ? "Check exports"
                  : exports.approval_in_progress
                    ? "Approval export in progress"
                  : isFinalised(client)
                    ? "FINAL"
                    : exports.latest_filename
                      ? exports.final_filename
                        ? exports.final_version !== null && exports.latest_version !== null && exports.final_version < exports.latest_version
                          ? "FINAL outdated" : "FINAL unverified"
                        : exports.approval_ready ? "Approval ready" : "Export ready"
                      : "No exports";
                const exportNeedsAttention = Boolean(
                  exports.issue || exportLabel === "FINAL outdated" || exportLabel === "FINAL unverified"
                );
                const exportSummary = version !== null && exportLabel !== "FINAL"
                  ? `V${version} · ${exportLabel}`
                  : exportLabel;
                const exportDetails = client.exportStatusLoading
                  ? "Checking this client's exports…"
                  : exports.issue ?? [
                  exports.latest_filename && `Latest: ${exports.latest_filename}`,
                  exports.approval_in_progress && "Approval copy is being rendered and validated",
                  exports.final_filename && `FINAL: ${exports.final_filename}`,
                  exports.versions.length > 0 && `Versions: ${exports.versions.map((item) => `V${item.version}`).join(", ")}`,
                ].filter(Boolean).join("\n");
                const lastExportVersion = exports.versions[exports.versions.length - 1];
                const defaultSelectedVersion = exports.latest_version ?? lastExportVersion?.version;
                const selectedVersionNumber = selectedVersionByClient[client.name] ?? defaultSelectedVersion;
                const selectedExportVersion = exports.versions.find((item) => item.version === selectedVersionNumber)
                  ?? lastExportVersion;
                const selectedVideoPath = selectedExportVersion
                  ? `${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${selectedExportVersion.relative_path.replace(/[\\/]+/g, "\\")}`
                  : null;
                return (
                  <Fragment key={client.name}>
                  <div
                    className={`table-row client-row ${droppable ? "droppable-row" : ""} ${
                      dragTarget === client.name ? "drag-over" : ""
                    } ${published ? "published-row" : ""}`}
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
                        <button
                          type="button"
                          className="expand-client-button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${label.name} versions`}
                          title={`${expanded ? "Hide" : "Show"} export versions`}
                          onClick={() => toggleClientExpanded(client.name)}
                        >
                          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
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
                    <div className="client-statuses">
                      {client.status !== "OK" && (
                      <span
                        className={`badge ${client.status
                          .toLowerCase()
                          .replace(/\s/g, "-")}`}
                      >
                        {client.status}
                      </span>
                      )}
                      {client.status !== "Not a client" && (
                        <>
                          {client.exportStatusLoading ? (
                            <span className="badge export-ready export-progress" title={exportDetails}>
                              <LoaderCircle className="approval-progress-spinner" size={13} aria-hidden="true" />
                              {exportLabel}
                            </span>
                          ) : exports.approval_in_progress && !exports.issue ? (
                            <span className="approval-progress-wrap" title={exportDetails}>
                              <span className="badge export-ready export-progress">
                                <LoaderCircle className="approval-progress-spinner" size={13} aria-hidden="true" />
                                {exportLabel}
                              </span>
                              <span className="approval-progress-detail">
                                {exports.approval_progress_phase ?? "Preparing approval copy"}
                              </span>
                            </span>
                          ) : exportNeedsAttention ? (
                            <span className="badge export-warning" title={exportDetails}>{exportSummary}</span>
                          ) : exportLabel === "FINAL" ? (
                            <span className="status-text final-state" title={exportDetails}>
                              <Check size={14} aria-hidden="true" /> Final
                            </span>
                          ) : exportLabel === "No exports" ? (
                            <span className="status-text empty-state" title={exportDetails}>No exports</span>
                          ) : (
                            <span className="status-text" title={exportDetails}>{exportSummary}</span>
                          )}
                        </>
                      )}
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
                      {client.status !== "Not a client" && !published && (
                        <button
                          type="button"
                          className="ghost promote-button"
                          onClick={() => setPendingPromotion(client)}
                          disabled={Boolean(busy || publishingClientPath || !exports.latest_filename || exports.issue)}
                          title={exports.issue ?? (exports.latest_filename ? `Publish ${exports.latest_filename}` : "No source export available to publish")}
                        >
                          {publishingClientPath === client.path ? (
                            <><LoaderCircle className="approval-progress-spinner" size={14} aria-hidden="true" /> Publishing…</>
                          ) : "Publish"}
                        </button>
                      )}
                      {client.status === "Missing folders" && (
                        <button
                          className="ghost icon-button"
                          onClick={() => handleFixClient(client)}
                          aria-label="Fix"
                          title="Fix"
                        >
                          <Wrench size={17} strokeWidth={2} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                </div>
                {expanded && (
                  <div className="client-details">
                    <div className="client-details-heading">
                      <div>
                        <strong>Export versions</strong>
                        <span>{exports.versions.length} {exports.versions.length === 1 ? "version" : "versions"}</span>
                      </div>
                      {exports.approval_in_progress && (
                        <span className="approval-detail-line">
                          <LoaderCircle className="approval-progress-spinner" size={13} aria-hidden="true" />
                          Approval copy: {exports.approval_progress_phase ?? "Preparing approval copy"}
                        </span>
                      )}
                    </div>
                    {client.exportStatusLoading ? (
                      <div className="versions-empty"><LoaderCircle className="approval-progress-spinner" size={14} aria-hidden="true" /> Loading export versions…</div>
                    ) : exports.versions.length === 0 ? (
                      <div className="versions-empty">No source versions found.</div>
                    ) : selectedExportVersion && selectedVideoPath && (
                      <div className="version-browser">
                        <article className="export-preview">
                          <div className="export-preview-heading">
                            <div className="export-preview-title">
                              <span className="version-label">V{selectedExportVersion.version}</span>
                              <strong>{selectedExportVersion.filename}</strong>
                            </div>
                            <time dateTime={selectedExportVersion.added_at}>
                              Added {new Date(selectedExportVersion.added_at).toLocaleString()}
                            </time>
                          </div>
                          <video
                            key={selectedVideoPath}
                            controls
                            preload="metadata"
                            src={convertFileSrc(selectedVideoPath)}
                          />
                        </article>
                        <div className="version-list" role="tablist" aria-label={`${label.name} export versions`}>
                          {[...exports.versions].reverse().map((exportVersion) => {
                            const selected = exportVersion.version === selectedExportVersion.version;
                            return (
                              <button
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`version-option ${selected ? "selected" : ""}`}
                                key={`${exportVersion.version}-${exportVersion.filename}`}
                                onClick={() => setSelectedVersionByClient((current) => ({
                                  ...current,
                                  [client.name]: exportVersion.version,
                                }))}
                              >
                                <span className="version-option-number">V{exportVersion.version}</span>
                                <span className="version-option-copy">
                                  <strong>{exportVersion.filename}</strong>
                                  <time dateTime={exportVersion.added_at}>
                                    {new Date(exportVersion.added_at).toLocaleString()}
                                  </time>
                                </span>
                                {exportVersion.version === exports.latest_version && <span className="latest-label">Latest</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                </Fragment>
              );
            })}
            {scanProgress && visibleClients.length > 0 && (
              <div className="table-row scan-progress-row">
                <span>
                  <LoaderCircle className="approval-progress-spinner" size={14} aria-hidden="true" />
                  {scanProgress.phase === "clients"
                    ? `Loading clients ${scanProgress.completed}${scanProgress.total ? ` of ${scanProgress.total}` : ""}…`
                    : `Checking exports ${scanProgress.completed} of ${scanProgress.total}…`}
                </span>
              </div>
            )}
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

      {pendingPromotion && (
        <dialog
          ref={promotionDialogRef}
          className="modal update-modal promotion-modal"
          aria-labelledby="promotion-title"
          aria-describedby="promotion-description"
          onCancel={(event) => {
            event.preventDefault();
            setPendingPromotion(null);
          }}
        >
          <h2 id="promotion-title">Publish version?</h2>
          <p id="promotion-description">
            Publish <strong>V{pendingPromotion.export_status.latest_version}</strong> for{" "}
            <strong>{parseClientLabel(pendingPromotion.name).name}</strong> to 04_FINAL.
            The source export will be kept.
          </p>
          <p className="update-notes promotion-filename">
            {pendingPromotion.name}_FINAL{pendingPromotion.export_status.latest_filename?.match(/\.[^.]+$/)?.[0]}
          </p>
          {pendingPromotion.export_status.final_filename && (
            <p>Existing FINAL videos will be moved into a timestamped archive folder.</p>
          )}
          <div className="modal-actions">
            <button type="button" className="ghost" autoFocus onClick={() => setPendingPromotion(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => void handlePromoteLatest(pendingPromotion)}>
              Publish
            </button>
          </div>
        </dialog>
      )}

      {pendingUpdate && (
        <div className="modal-backdrop" onClick={() => !installingUpdate && setPendingUpdate(null)}>
          <div className="modal update-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Pepper update available</h2>
            <p>
              Version <strong>{pendingUpdate.version}</strong> is ready to install.
            </p>
            {updateNotes && <p className="update-notes">{updateNotes}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={installingUpdate}
                onClick={() => setPendingUpdate(null)}
              >
                Later
              </button>
              <button
                type="button"
                className="primary"
                disabled={installingUpdate}
                onClick={async () => {
                  setInstallingUpdate(true);
                  try {
                    await pendingUpdate.downloadAndInstall();
                  } catch (err) {
                    setToast({
                      message: "Could not install update.",
                      tone: "error",
                    });
                    setInstallingUpdate(false);
                  }
                }}
              >
                {installingUpdate ? "Installing…" : "Install update"}
              </button>
            </div>
          </div>
        </div>
      )}

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
