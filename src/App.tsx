import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { cursorPosition, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { type DragDropEvent } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { InlineVideoPlayer } from "./components/InlineVideoPlayer";
import { ArrowDown, ArrowUp, ArrowUpDown, Bell, Check, ChevronDown, ChevronRight, ChevronsUpDown, Clapperboard, CloudUpload, Copy, FolderKanban, FolderOpen, Link2, LoaderCircle, Minus, Plus, RefreshCw, Search, Settings2, Square, Trash2, Wrench, X } from "lucide-react";
import pepperIcon from "../src-tauri/icons/128x128.png";
import "./App.css";

type ClientStatus = "OK" | "Missing folders" | "Not a client";
type ClientSort = { column: "name" | "status"; direction: "asc" | "desc" };

type ClientInfo = {
  name: string;
  path: string;
  season?: string | null;
  status: ClientStatus;
  cachePublished?: boolean;
  cachePublishedDividerBefore?: boolean;
  cacheOrder?: number;
  missing: string[];
  export_status: ExportStatus;
  exportStatusLoading?: boolean;
};
type CachedClientRow = Pick<ClientInfo, "name" | "path" | "season"> & {
  status?: ClientStatus;
  published?: boolean;
  publishedDividerBefore?: boolean;
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
type ApprovalProgressStatus = { client_name: string; phase: string | null };

type ExportVersion = {
  version: number;
  filename: string;
  relative_path: string;
  added_at: string;
  frameio: FrameIoRecord | null;
};

type FrameIoRecord = { state: string; share_url: string | null; last_error: string | null; updated_at: string; destination_account_id: string; destination_project_id: string };
type FrameIoProgress = { approval_path: string; state: string; uploaded: number; total: number; message: string | null; share_url: string | null };
type FrameIoOption = { id: string; name: string; workspace_name: string | null };
type FrameIoStorage = { usedBytes: number; limitBytes: number };
type NotificationEntry = { id: string; message: string; tone: "info" | "success" | "error"; createdAt: number; unread: boolean };

type ExportStatus = {
  versions: ExportVersion[];
  approval_versions: ExportVersion[];
  latest_version: number | null;
  latest_filename: string | null;
  approval_ready: boolean;
  approval_in_progress: boolean;
  approval_progress_phase: string | null;
  final_version: number | null;
  final_filename: string | null;
  final_published_at: string | null;
  final_current: boolean;
  publish_failed: boolean;
  issue: string | null;
};

const EMPTY_EXPORT_STATUS: ExportStatus = {
  versions: [],
  approval_versions: [],
  latest_version: null,
  latest_filename: null,
  approval_ready: false,
  approval_in_progress: false,
  approval_progress_phase: null,
  final_version: null,
  final_filename: null,
  final_published_at: null,
  final_current: false,
  publish_failed: false,
  issue: null,
};

type ProjectRootOption = { name: string; path: string; number: number };
type ProjectShowCatalog = { path: string; shows: { name: string }[] };
const alphabetizeProjectShows = (shows: ProjectShowCatalog["shows"]) =>
  [...shows].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

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
const clientCacheKey = (root: string) => `client-list-cache:${root}`;
const clientLocalCacheKey = (root: string) => `pepper.clientListCache.v1:${root}`;
const PEPPER_FRAMEIO_ACCOUNT_ID = "e44a308c-5a20-4f8b-ba14-f56d0fb8c50c";
const NOTIFICATION_STORE_KEY = "pepper.notificationHistory.v1";

const readNotificationHistory = (): NotificationEntry[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTIFICATION_STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NotificationEntry =>
      Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.message === "string" &&
        (item.tone === "info" || item.tone === "success" || item.tone === "error") && typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && typeof item.unread === "boolean")
    ).slice(0, 100);
  } catch { return []; }
};
const formatStorage = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit > 1 ? 1 : 0 })} ${units[unit]}`;
};


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
  value.trim().replace(/\s+/g, "_");

const parseClientLabel = (raw: string) => {
  const normalized = normalizeClientInput(raw);
  const parts = normalized.split("_").filter(Boolean);
  if (parts.length >= 2) {
    const typeCandidate = parts[parts.length - 1].toUpperCase();
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

const projectDisplayName = (name: string) => {
  const match = name.match(/^\d+[_\s-]+(.+)$/);
  return (match?.[1] ?? name).replace(/_/g, " ");
};

const isFinalised = (client: ClientInfo) =>
  !client.export_status.issue && Boolean(
    client.export_status.final_current ||
    (client.export_status.final_filename && !client.export_status.latest_filename)
  );

const formatAverageDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return "—";
  const totalMinutes = Math.round(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (totalMinutes >= 60) return `${(totalMinutes / 60).toFixed(1)}h`;
  return `${totalMinutes}m`;
};

const formatUiDateTime = (value: Date | string | number) =>
  new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function App() {
  const [screen] = useState<"home" | "sort">("sort");
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [projectRoots, setProjectRoots] = useState<ProjectRootOption[]>([]);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [projectShowCatalog, setProjectShowCatalog] = useState<ProjectShowCatalog | null>(null);
  const [selectedProjectShow, setSelectedProjectShow] = useState("");
  const [customProjectShow, setCustomProjectShow] = useState("");
  const [customProjectShowSelected, setCustomProjectShowSelected] = useState(false);
  const [projectYear, setProjectYear] = useState(new Date().getFullYear());
  const [projectCreateBusy, setProjectCreateBusy] = useState(false);
  const [projectCreateError, setProjectCreateError] = useState("");
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [expandedClients, setExpandedClients] = useState<Set<string>>(() => new Set());
  const [selectedVersionByClient, setSelectedVersionByClient] = useState<Record<string, string>>({});
  const [frameIoConfig, setFrameIoConfig] = useState({
    clientId: import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "",
    scopes: import.meta.env.VITE_FRAMEIO_SCOPES ?? "",
    accountId: import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "",
    projectId: import.meta.env.VITE_FRAMEIO_PROJECT_ID ?? "",
  });
  const [showFrameIoConfig, setShowFrameIoConfig] = useState(false);
  const [frameIoStorage, setFrameIoStorage] = useState<FrameIoStorage | null>(null);
  const [frameIoStorageLoading, setFrameIoStorageLoading] = useState(false);
  const [frameIoStorageError, setFrameIoStorageError] = useState<string | null>(null);
  const [frameIoAccounts, setFrameIoAccounts] = useState<FrameIoOption[]>([]);
  const [frameIoProjects, setFrameIoProjects] = useState<FrameIoOption[]>([]);
  const [frameIoLoadingChoices, setFrameIoLoadingChoices] = useState(false);
  const [frameIoSetupError, setFrameIoSetupError] = useState<string | null>(null);
  const [frameIoAuthBusy, setFrameIoAuthBusy] = useState(false);
  const [frameIoProgress, setFrameIoProgress] = useState<Record<string, FrameIoProgress>>({});
  const [frameIoBusyPath, setFrameIoBusyPath] = useState<string | null>(null);
  const [clientSort, setClientSort] = useState<ClientSort>({ column: "name", direction: "asc" });
  const [publishingClientPath, setPublishingClientPath] = useState<string | null>(null);
  const [publishingStage, setPublishingStage] = useState<"publishing" | "refreshing" | null>(null);
  const [publishFailedClientPaths, setPublishFailedClientPaths] = useState<Set<string>>(new Set());
  const [pendingPromotion, setPendingPromotion] = useState<ClientInfo | null>(null);
  const promotionDialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (pendingPromotion && !promotionDialogRef.current?.open) {
      promotionDialogRef.current?.showModal();
    }
  }, [pendingPromotion]);
  const [loading, setLoading] = useState(false);
  const [clientCacheLoadedRoot, setClientCacheLoadedRoot] = useState<string | null>(null);
  const [clientListRevealedRoot, setClientListRevealedRoot] = useState<string | null>(null);
  const [cachedClientNames, setCachedClientNames] = useState<Set<string>>(new Set());
  const [clientRefreshFailedRoot, setClientRefreshFailedRoot] = useState<string | null>(null);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ phase: "clients" | "exports"; completed: number; total: number } | null>(null);
  const [lastClientsCheckedAt, setLastClientsCheckedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [showNonClients, setShowNonClients] = useState(false);
  const [mode] = useState<string>("AUTO");
  const [progress, setProgress] = useState<SortProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>("");
  const [lastBatch, setLastBatch] = useState<UndoEntry[]>([]);
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedModeRequested, setAdvancedModeRequested] = useState(false);
  const [advancedPassword, setAdvancedPassword] = useState("");
  const [advancedPasswordError, setAdvancedPasswordError] = useState("");
  const [manualPublishedPaths, setManualPublishedPaths] = useState<Record<string, boolean>>({});
  const [newClientName, setNewClientName] = useState("");
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [createdMariyaSeason, setCreatedMariyaSeason] = useState<string | null>(null);
  const [newClientType, setNewClientType] = useState<ClientType>("EXHIBITOR");
  const [customClientType, setCustomClientType] = useState("");
  const [huddleTemplate, setHuddleTemplate] = useState<HuddleTemplate>("PHYSICAL");
  const projectRootRef = useRef(projectRoot);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const expandedName = expandedClients.values().next().value as string | undefined;
    if (!expandedName) return;
    const container = tableScrollRef.current;
    const row = Array.from(container?.querySelectorAll<HTMLElement>(".client-row") ?? [])
      .find((candidate) => candidate.dataset.clientName === expandedName);
    if (!container || !row) return;
    const frame = window.requestAnimationFrame(() => {
      const rowOffset = row.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
      container.scrollTo({ top: container.scrollTop + rowOffset, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedClients]);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const hoverClientRef = useRef<string | null>(null);
  const clientsRef = useRef<ClientInfo[]>([]);
  clientsRef.current = clients;
  const cachedClientNamesRef = useRef(new Set<string>());
  const clientCacheSaveTimerRef = useRef<number | null>(null);
  const sortableClientsRef = useRef<ClientInfo[]>([]);
  const busyRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const clientsScansInFlightRef = useRef(0);
  const clientsScanSequenceRef = useRef(0);
  const approvalProgressPollInFlightRef = useRef(false);
  const approvalProgressActiveRef = useRef(new Set<string>());
  const approvalProgressRefreshPendingRef = useRef(new Set<string>());
  const approvalProgressCompletionPendingRef = useRef(new Set<string>());
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
  const [notificationHistory, setNotificationHistory] = useState<NotificationEntry[]>(readNotificationHistory);
  const [showNotificationMenu, setShowNotificationMenu] = useState(false);
  const unreadNotificationCount = notificationHistory.filter((entry) => entry.unread).length;
  const notificationCenterRef = useRef<HTMLDivElement | null>(null);
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
          showToast("Pepper is up to date.", "info");
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
        showToast(
          noReleasePublished
            ? "No Pepper release has been published yet."
            : "Could not check for updates.",
          noReleasePublished ? "info" : "error",
        );
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
      void invoke<ProjectShowCatalog>("get_project_show_catalog")
        .then((catalog) => {
          const sortedCatalog = { ...catalog, shows: alphabetizeProjectShows(catalog.shows) };
          setProjectShowCatalog(sortedCatalog);
          setSelectedProjectShow((current) => current || sortedCatalog.shows[0]?.name || "");
        })
        .catch((err) => setProjectCreateError(`Could not load the local show list: ${String(err)}`));
      await CONFIG_STORE.init();
      const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
      const savedShowNonClients = await CONFIG_STORE.get<boolean>("showNonClients");
      const savedMode = await CONFIG_STORE.get<string>("lastMode");
      const savedAlwaysOnTop = await CONFIG_STORE.get<boolean>("alwaysOnTop");
      const savedFrameIo = await CONFIG_STORE.get<typeof frameIoConfig>("frameIoConfig");
      const savedManualPublished = await CONFIG_STORE.get<Record<string, boolean>>("manualPublishedClients");
      if (savedManualPublished && typeof savedManualPublished === "object") setManualPublishedPaths(savedManualPublished);
      if (savedFrameIo) setFrameIoConfig({
        clientId: savedFrameIo.clientId ?? import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "",
        scopes: savedFrameIo.scopes ?? import.meta.env.VITE_FRAMEIO_SCOPES ?? "",
        accountId: savedFrameIo.accountId ?? import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "",
        projectId: savedFrameIo.projectId ?? import.meta.env.VITE_FRAMEIO_PROJECT_ID ?? "",
      });
      const savedFrameIoClientId = savedFrameIo?.clientId ?? import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "";
      const savedFrameIoAccountId = savedFrameIo?.accountId ?? import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "";
      if (savedFrameIoClientId) {
        void invoke<FrameIoOption[]>("frameio_list_accounts", { clientId: savedFrameIoClientId })
          .then((accounts) => {
            setFrameIoAccounts(accounts);
            if (savedFrameIoAccountId !== PEPPER_FRAMEIO_ACCOUNT_ID) return [];
            return invoke<FrameIoOption[]>("frameio_list_projects", { clientId: savedFrameIoClientId, accountId: savedFrameIoAccountId });
          })
          .then((projects) => setFrameIoProjects(projects))
          .catch((err) => console.warn("Frame.io destination verification is unavailable", err));
      }
      const migratedRoots = (await CONFIG_STORE.get<string[]>("legacyFinalMigrationRoots")) ?? [];

      if (typeof savedRoot === "string") {
        setProjectRoot(savedRoot);
        projectRootRef.current = savedRoot;
        setLoading(true);
        setScanProgress({ phase: "clients", completed: 0, total: 0 });
        scanProgressVisibleRef.current = true;
        await loadClientCache(savedRoot);
      }
      if (typeof savedShowNonClients === "boolean") {
        setShowNonClients(savedShowNonClients);
      }
      if (typeof savedMode === "string" && savedMode !== "AUTO") {
        await CONFIG_STORE.set("lastMode", "AUTO");
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
        const confirmedNonClients = new Set(scan.clients
          .filter((client) => client.status === "Not a client")
          .map((client) => client.name));
        if (confirmedNonClients.size) {
          const remainingCachedNames = new Set(cachedClientNamesRef.current);
          confirmedNonClients.forEach((name) => remainingCachedNames.delete(name));
          cachedClientNamesRef.current = remainingCachedNames;
          setCachedClientNames(remainingCachedNames);
        }
        const preserveCacheDuringReset = scan.reset && cachedClientNamesRef.current.size > 0;
        setClients((current) => {
          const existing = new Map(current.map((client) => [client.name, client]));
          const incoming = scan.clients.map((client) => {
            const prior = existing.get(client.name);
            const isCached = cachedClientNamesRef.current.has(client.name);
            return {
              ...(prior ?? {}),
              ...client,
              cachePublished: prior?.cachePublished ?? (prior ? isFinalised(prior) : isFinalised(client)),
              export_status: isCached ? client.export_status : prior?.export_status ?? client.export_status,
              exportStatusLoading: isCached || scan.reset || !prior
                ? client.status !== "Not a client"
                : prior.exportStatusLoading ?? false,
            };
          });
          if (scan.reset && !preserveCacheDuringReset) return incoming;
          const received = new Set(incoming.map((client) => client.name));
          return [...current.filter((client) => !received.has(client.name)), ...incoming];
        });
      } else if (scan.phase === "exports") {
        setClientListRevealedRoot(scan.project_root);
        for (const update of scan.export_updates) {
          if (!approvalProgressCompletionPendingRef.current.has(update.name)) continue;
          const latestSourceStem = update.export_status.latest_filename?.replace(/\.[^.]+$/, "");
          const expectedApprovalFilename = latestSourceStem
            ? `${latestSourceStem}_APPROVAL_1080p_WM_TC.mp4`.toLowerCase()
            : null;
          const completedApproval = expectedApprovalFilename
            ? update.export_status.approval_versions.find(
              (version) => version.filename.toLowerCase() === expectedApprovalFilename,
            )
            : undefined;
          if (update.export_status.approval_ready && completedApproval) {
            setSelectedVersionByClient((current) => ({
              ...current,
              [update.name]: completedApproval.relative_path,
            }));
          }
          approvalProgressCompletionPendingRef.current.delete(update.name);
        }
        const refreshedNames = new Set(scan.export_updates.map((item) => item.name));
        if (refreshedNames.size) {
          const remainingCachedNames = new Set(cachedClientNamesRef.current);
          refreshedNames.forEach((name) => remainingCachedNames.delete(name));
          cachedClientNamesRef.current = remainingCachedNames;
          setCachedClientNames(remainingCachedNames);
        }
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
        setClientListRevealedRoot(scan.project_root);
        cachedClientNamesRef.current = new Set();
        setCachedClientNames(new Set());
        const currentNames = new Set(scan.client_names);
        if (scan.partial) {
          if (scan.removed_names.length) {
            const removedNames = new Set(scan.removed_names);
            setClients((current) => current
              .filter((client) => !removedNames.has(client.name))
              .map(({ cachePublished: _cachePublished, cachePublishedDividerBefore: _divider, cacheOrder: _order, ...client }) => client));
          } else {
            setClients((current) => current.map(({ cachePublished: _cachePublished, cachePublishedDividerBefore: _divider, cacheOrder: _order, ...client }) => client));
          }
        } else {
          setClients((current) => current
            .filter((client) => currentNames.has(client.name))
            .map(({ cachePublished: _cachePublished, cachePublishedDividerBefore: _divider, cacheOrder: _order, ...client }) => client));
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

  useEffect(() => {
    const pending = listen<FrameIoProgress>("frameio-upload-progress", (event) => {
      setFrameIoProgress((current) => ({ ...current, [event.payload.approval_path]: event.payload }));
    });
    return () => { pending.then((unlisten) => unlisten()).catch(() => undefined); };
  }, []);

  const saveFrameIoConfig = async (next: typeof frameIoConfig) => {
    if (next.accountId !== frameIoConfig.accountId || next.projectId !== frameIoConfig.projectId) {
      setFrameIoProgress({});
    }
    setFrameIoConfig(next);
    await CONFIG_STORE.set("frameIoConfig", next);
    await CONFIG_STORE.save();
  };

  const loadFrameIoStorage = async (accountId = frameIoConfig.accountId) => {
    if (!accountId || !frameIoConfig.clientId) {
      setFrameIoStorage(null);
      setFrameIoStorageError(null);
      return;
    }
    setFrameIoStorageLoading(true);
    setFrameIoStorageError(null);
    try {
      const storage = await invoke<FrameIoStorage>("frameio_get_storage", { clientId: frameIoConfig.clientId, accountId });
      setFrameIoStorage(storage);
    } catch (err) {
      setFrameIoStorage(null);
      setFrameIoStorageError(String(err));
    } finally { setFrameIoStorageLoading(false); }
  };

  const loadFrameIoChoices = async () => {
    setFrameIoLoadingChoices(true);
    setFrameIoSetupError(null);
    try {
      const accounts = await invoke<FrameIoOption[]>("frameio_list_accounts", { clientId: frameIoConfig.clientId });
      setFrameIoAccounts(accounts);
      if (frameIoConfig.accountId) {
        const [projects] = await Promise.all([
          invoke<FrameIoOption[]>("frameio_list_projects", { clientId: frameIoConfig.clientId, accountId: frameIoConfig.accountId }),
          loadFrameIoStorage(frameIoConfig.accountId),
        ]);
        setFrameIoProjects(projects);
      } else {
        setFrameIoProjects([]);
        setFrameIoStorage(null);
      }
    } catch (err) {
      setFrameIoSetupError(String(err));
      throw err;
    } finally {
      setFrameIoLoadingChoices(false);
    }
  };

  const selectFrameIoAccount = async (accountId: string) => {
    setFrameIoProjects([]);
    await saveFrameIoConfig({ ...frameIoConfig, accountId, projectId: "" });
    if (!accountId) return;
    setFrameIoLoadingChoices(true);
    setFrameIoSetupError(null);
    try {
      const projects = await invoke<FrameIoOption[]>("frameio_list_projects", { clientId: frameIoConfig.clientId, accountId });
      setFrameIoProjects(projects);
      await loadFrameIoStorage(accountId);
    } catch (err) {
      setFrameIoSetupError(String(err));
    } finally {
      setFrameIoLoadingChoices(false);
    }
  };

  const openFrameIoSettings = () => {
    setShowFrameIoConfig(true);
    if (frameIoConfig.clientId) void loadFrameIoChoices().catch(() => undefined);
  };

  const connectFrameIo = async () => {
    setFrameIoAuthBusy(true);
    try {
      const authUrl = await invoke<string>("frameio_start_auth", { clientId: frameIoConfig.clientId, scopes: frameIoConfig.scopes });
      await invoke("frameio_open_external_url", { url: authUrl });
      showToast("Complete Adobe sign-in in your browser. Pepper will wait for the callback.", "info", null);
      await invoke("frameio_finish_auth");
      await loadFrameIoChoices();
      showToast("Adobe connected for Frame.io uploads.", "success");
    } catch (err) {
      await invoke("frameio_cancel_auth").catch(() => undefined);
      if (!String(err).toLowerCase().includes("cancelled")) showToast(String(err), "error", 7000);
    } finally { setFrameIoAuthBusy(false); }
  };

  const cancelFrameIoAuth = async () => {
    await invoke("frameio_cancel_auth").catch(() => undefined);
    showToast("Adobe sign-in cancelled.", "info");
  };

  const uploadApprovalToFrameIo = async (path: string, clientKey: string, productionProjectName: string, productionProjectPath: string) => {
    setFrameIoBusyPath(path);
    setFrameIoProgress((current) => ({ ...current, [path]: { approval_path: path, state: "preparing", uploaded: 0, total: 0, message: null, share_url: null } }));
    try {
      const result = await invoke<FrameIoRecord & { share_url: string | null }>("frameio_upload", {
        approvalPath: path, clientId: frameIoConfig.clientId, accountId: frameIoConfig.accountId,
        projectId: frameIoConfig.projectId,
        productionProjectPath, productionProjectName, clientKey,
      });
      setFrameIoProgress((current) => ({ ...current, [path]: { approval_path: path, state: result.state, uploaded: 1, total: 1, message: null, share_url: result.share_url } }));
      showToast("Frame.io share link saved beside the approval copy on the NAS. Downloads are enabled on this plan.", "success");
    } catch (err) {
      const message = String(err);
      const uploadCompletedPrefix = "FRAMEIO_VIDEO_UPLOADED_SHARE_FAILED:";
      if (message.includes(uploadCompletedPrefix)) {
        const detail = message.slice(message.indexOf(uploadCompletedPrefix) + uploadCompletedPrefix.length).trim();
        setFrameIoProgress((current) => ({ ...current, [path]: { approval_path: path, state: "share_needs_reconciliation", uploaded: 1, total: 1, message: `Video uploaded; share link needs retry. ${detail}`, share_url: null } }));
        showToast(`Video upload completed, but the share link was not created. Retry share link on this client row; Pepper will not upload the video again. ${detail}`, "error", null);
      } else {
        showToast(message, "error", 8000);
      }
    }
    finally {
      setFrameIoBusyPath(null);
      // The link is already saved and visible; NAS reconciliation must not
      // keep the upload spinner running or scan unrelated client folders.
      if (projectRootRef.current === productionProjectPath) {
        void refreshClients(productionProjectPath, false, false, false, [clientKey]).catch(console.error);
      }
    }
  };

  const copyFrameIoShareLink = async (url: string) => {
    try {
      await writeText(url);
      showToast("Frame.io share link copied to clipboard.", "success");
    } catch (err) {
      showToast(`Could not copy Frame.io share link: ${String(err)}`, "error", 7000);
    }
  };

  function showToast(
    message: string,
    tone: "info" | "success" | "error" = "info",
    duration: number | null = 3000
  ) {
    setToast({ message, tone });
    setNotificationHistory((current) => [{ id: crypto.randomUUID(), message, tone, createdAt: Date.now(), unread: true }, ...current].slice(0, 100));
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
  }

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
    try { localStorage.setItem(NOTIFICATION_STORE_KEY, JSON.stringify(notificationHistory)); }
    catch (err) { console.warn("Could not save Pepper notification history", err); }
  }, [notificationHistory]);

  useEffect(() => {
    if (!showNotificationMenu) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!notificationCenterRef.current?.contains(event.target as Node)) setShowNotificationMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setShowNotificationMenu(false); };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showNotificationMenu]);

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

  const activeProject = availableProjectRoots.find((project) => project.path === projectRoot);
  const frameIoConfigured = Boolean(frameIoConfig.clientId && frameIoConfig.scopes
    && frameIoConfig.accountId === PEPPER_FRAMEIO_ACCOUNT_ID
    && frameIoConfig.projectId);


  const sortedClients = useMemo(() => {
    const filtered = clients.filter((client) => showNonClients || client.status !== "Not a client");
    return filtered.sort((left, right) => {
      const leftCachedOrder = left.cacheOrder ?? Number.MAX_SAFE_INTEGER;
      const rightCachedOrder = right.cacheOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftCachedOrder !== rightCachedOrder) return leftCachedOrder - rightCachedOrder;
      if (left.season || right.season) {
        const leftSeason = Number(left.season?.match(/\d+/)?.[0] ?? 0);
        const rightSeason = Number(right.season?.match(/\d+/)?.[0] ?? 0);
        if (leftSeason !== rightSeason) return rightSeason - leftSeason;
      }
      const alphabetical = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      const direction = clientSort.direction === "asc" ? 1 : -1;
      const leftPublished = left.cachePublished ?? (isFinalised(left) || Boolean(manualPublishedPaths[left.path]));
      const rightPublished = right.cachePublished ?? (isFinalised(right) || Boolean(manualPublishedPaths[right.path]));
      const completionOrder = Number(leftPublished) - Number(rightPublished);
      if (clientSort.column === "status") return completionOrder * direction || alphabetical;
      return completionOrder || alphabetical * direction;
    });
  }, [clients, showNonClients, clientSort, manualPublishedPaths]);

  const visibleClients = useMemo(() => {
    const query = search.toLowerCase();
    return sortedClients.filter((client) => client.name.toLowerCase().includes(query));
  }, [sortedClients, search]);

  const clientListReady = clientCacheLoadedRoot === projectRoot
    && (!loading || clientListRevealedRoot === projectRoot || clients.length > 0 || scanProgress?.phase !== "clients");

  const isMariyaMeetsRoot = projectRoot.split(/[\\/]/).pop()?.toLowerCase() === "8_mariya meets";

  const advancedStats = useMemo(() => {
    const clientsWithExports = clients.filter((client) =>
      client.status !== "Not a client" && !client.export_status.issue && client.export_status.versions.length > 0
    );
    const totalVersions = clientsWithExports.reduce((sum, client) => sum + client.export_status.versions.length, 0);
    const approvalReadyCount = clientsWithExports.filter((client) => client.export_status.approval_ready).length;
    const finalCurrentCount = clientsWithExports.filter((client) => isFinalised(client)).length;
    const awaitingApprovalCount = clientsWithExports.filter((client) =>
      !client.export_status.approval_ready && !client.export_status.approval_in_progress
    ).length;
    const awaitingFinalCount = clientsWithExports.filter((client) => !isFinalised(client)).length;
    const manualOverrideCount = clients.filter((client) =>
      client.status !== "Not a client" && Boolean(manualPublishedPaths[client.path])
    ).length;
    const approvalToPublishMs = clientsWithExports.flatMap((client) => {
      if (!isFinalised(client) || !client.export_status.final_published_at || client.export_status.approval_versions.length === 0) return [];
      const latestApproval = client.export_status.approval_versions.reduce((latest, version) =>
        version.version > latest.version ? version : latest,
      );
      const approvalTime = Date.parse(latestApproval.added_at);
      const publishedTime = Date.parse(client.export_status.final_published_at);
      return Number.isFinite(approvalTime) && Number.isFinite(publishedTime) && publishedTime >= approvalTime
        ? [publishedTime - approvalTime]
        : [];
    });
    return {
      updating: loading || statsRefreshing || clients.some((client) => client.exportStatusLoading),
      clientCount: clients.filter((client) => client.status !== "Not a client").length,
      exportIssueCount: clients.filter((client) => client.status !== "Not a client" && Boolean(client.export_status.issue)).length,
      exportClientCount: clientsWithExports.length,
      totalVersions,
      averageVersions: clientsWithExports.length ? totalVersions / clientsWithExports.length : null,
      approvalReadyCount,
      finalCurrentCount,
      awaitingApprovalCount,
      awaitingFinalCount,
      manualOverrideCount,
      averageApprovalToPublishMs: approvalToPublishMs.length
        ? approvalToPublishMs.reduce((sum, duration) => sum + duration, 0) / approvalToPublishMs.length
        : null,
      approvalPublishSampleCount: approvalToPublishMs.length,
    };
  }, [clients, manualPublishedPaths, loading, statsRefreshing]);

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

  const loadClientCache = async (root: string) => {
    let stored: unknown = null;
    try {
      const raw = localStorage.getItem(clientLocalCacheKey(root));
      if (raw) stored = JSON.parse(raw);
    } catch (err) {
      console.warn("Could not read the local client list cache", err);
    }
    if (!Array.isArray(stored)) {
      try {
        stored = await CONFIG_STORE.get<unknown>(clientCacheKey(root));
      } catch (err) {
        console.warn("Could not read cached client list", err);
      }
    }
    let cachedRows: CachedClientRow[] = [];
    try {
      if (Array.isArray(stored)) {
        cachedRows = stored.filter((value): value is CachedClientRow =>
          Boolean(value)
          && typeof value === "object"
          && typeof (value as CachedClientRow).name === "string"
          && typeof (value as CachedClientRow).path === "string"
          && ((value as CachedClientRow).status === undefined
            || ["OK", "Missing folders", "Not a client"].includes((value as CachedClientRow).status as string))
          && ((value as CachedClientRow).published === undefined
            || typeof (value as CachedClientRow).published === "boolean")
          && ((value as CachedClientRow).publishedDividerBefore === undefined
            || typeof (value as CachedClientRow).publishedDividerBefore === "boolean")
        );
      }
    } catch (err) {
      console.warn("Could not read cached client list", err);
    }
    if (projectRootRef.current !== root) return;
    const isMariyaRoot = root.split(/[\\/]/).pop()?.toLowerCase() === "8_mariya meets";
    const orderedCachedRows = [...cachedRows].sort((left, right) => {
      if (left.season || right.season) {
        const leftSeason = Number(left.season?.match(/\d+/)?.[0] ?? 0);
        const rightSeason = Number(right.season?.match(/\d+/)?.[0] ?? 0);
        if (leftSeason !== rightSeason) return rightSeason - leftSeason;
      }
      const alphabetical = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      const direction = clientSort.direction === "asc" ? 1 : -1;
      const completionOrder = Number(Boolean(left.published)) - Number(Boolean(right.published));
      if (clientSort.column === "status") return completionOrder * direction || alphabetical;
      return completionOrder || alphabetical * direction;
    });
    const rowsToShow: ClientInfo[] = orderedCachedRows.map((cached, cacheOrder) => {
      const { published, publishedDividerBefore, ...client } = cached;
      const previous = orderedCachedRows[cacheOrder - 1];
      const publishedDivider = Boolean(published) && (!previous
        || (isMariyaRoot && previous.season !== client.season)
        || !previous.published);
      const cachedDividerMatchesOrder = publishedDividerBefore === publishedDivider;
      return {
        ...client,
        status: client.status ?? (client.name.startsWith("XX") ? "Not a client" : "OK"),
        cachePublished: published ?? false,
        cachePublishedDividerBefore: cachedDividerMatchesOrder ? publishedDividerBefore : publishedDivider,
        cacheOrder,
        missing: [],
        export_status: EMPTY_EXPORT_STATUS,
        exportStatusLoading: true,
      };
    });
    const staleNames = new Set(rowsToShow.map((client) => client.name));
    cachedClientNamesRef.current = staleNames;
    setCachedClientNames(staleNames);
    setClients(rowsToShow);
    setClientCacheLoadedRoot(root);
    setClientListRevealedRoot(rowsToShow.length ? root : null);
  };

  useEffect(() => {
    if (!projectRoot || clientCacheLoadedRoot !== projectRoot) return;
    const snapshot: CachedClientRow[] = sortedClients.map((client, index) => {
      const published = client.cachePublished ?? (isFinalised(client) || Boolean(manualPublishedPaths[client.path]));
      const previous = sortedClients[index - 1];
      const previousPublished = previous
        ? previous.cachePublished ?? (isFinalised(previous) || Boolean(manualPublishedPaths[previous.path]))
        : false;
      const publishedDividerBefore = published && (!previous
        || (projectRoot.split(/[\\/]/).pop()?.toLowerCase() === "8_mariya meets" && previous.season !== client.season)
        || !previousPublished);
      return {
        name: client.name,
        path: client.path,
        season: client.season,
        status: client.status,
        published,
        publishedDividerBefore,
      };
    });
    try {
      localStorage.setItem(clientLocalCacheKey(projectRoot), JSON.stringify(snapshot));
    } catch (err) {
      console.warn("Could not write the local client list cache", err);
    }
    if (clientCacheSaveTimerRef.current !== null) {
      window.clearTimeout(clientCacheSaveTimerRef.current);
    }
    clientCacheSaveTimerRef.current = window.setTimeout(() => {
      clientCacheSaveTimerRef.current = null;
      void saveConfigValue(clientCacheKey(projectRoot), snapshot).catch((err) => {
        console.warn("Could not save cached client list", err);
      });
    }, 300);
    return () => {
      if (clientCacheSaveTimerRef.current !== null) {
        window.clearTimeout(clientCacheSaveTimerRef.current);
        clientCacheSaveTimerRef.current = null;
      }
    };
  }, [clients, sortedClients, manualPublishedPaths, projectRoot, clientCacheLoadedRoot]);

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
    setStatsRefreshing(true);
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
        setClientRefreshFailedRoot(null);
      }
      if (scanSequence === clientsScanSequenceRef.current && root === projectRootRef.current) {
        window.requestAnimationFrame(() => {
          if (tableScrollRef.current) tableScrollRef.current.scrollTop = scrollTop;
        });
      }
    } catch (err) {
      if (scanSequence === clientsScanSequenceRef.current && root === projectRootRef.current) {
        setClientRefreshFailedRoot(root);
        setError(String(err));
      }
    } finally {
      clientsScansInFlightRef.current = Math.max(0, clientsScansInFlightRef.current - 1);
      setStatsRefreshing(clientsScansInFlightRef.current > 0);
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

  useEffect(() => {
    if (!projectRoot) {
      approvalProgressActiveRef.current.clear();
      approvalProgressRefreshPendingRef.current.clear();
      approvalProgressCompletionPendingRef.current.clear();
      return;
    }
    let cancelled = false;
    const pollApprovalProgress = async () => {
      if (cancelled || approvalProgressPollInFlightRef.current
        || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const clientNames = clientsRef.current
        .filter((client) => client.status !== "Not a client")
        .map((client) => client.name);
      if (!clientNames.length) return;
      approvalProgressPollInFlightRef.current = true;
      try {
        const activeProgress = await invoke<ApprovalProgressStatus[]>("scan_approval_progress", {
          projectRoot,
          clientNames,
        });
        if (cancelled || projectRootRef.current !== projectRoot) return;
        const byClient = new Map(activeProgress.map((progress) => [progress.client_name, progress]));
        const previouslyActive = new Set(approvalProgressActiveRef.current);
        for (const client of clientsRef.current) {
          if (client.export_status.approval_in_progress
            && !approvalProgressCompletionPendingRef.current.has(client.name)) {
            previouslyActive.add(client.name);
          }
        }
        const nextActive = new Set(byClient.keys());
        // NAS filesystem notifications can be missed. The progress marker is a
        // reliable signal that a new source export has reached the watcher, so
        // refresh its version immediately as well as when rendering completes.
        for (const name of nextActive) {
          if (!previouslyActive.has(name)) approvalProgressRefreshPendingRef.current.add(name);
        }
        for (const name of previouslyActive) {
          if (!nextActive.has(name)) {
            approvalProgressRefreshPendingRef.current.add(name);
            approvalProgressCompletionPendingRef.current.add(name);
          }
        }
        approvalProgressActiveRef.current = nextActive;
        setClients((current) => current.map((client) => {
          const progress = byClient.get(client.name);
          const completing = approvalProgressCompletionPendingRef.current.has(client.name);
          const inProgress = Boolean(progress) || completing;
          const phase = progress?.phase ?? (completing
            ? "Finishing approval copy"
            : inProgress ? "Preparing approval copy" : null);
          if (client.export_status.approval_in_progress === inProgress
            && client.export_status.approval_progress_phase === phase) return client;
          return {
            ...client,
            export_status: {
              ...client.export_status,
              approval_in_progress: inProgress,
              approval_progress_phase: phase,
            },
          };
        }));
        if (approvalProgressRefreshPendingRef.current.size
          && !busyRef.current && clientsScansInFlightRef.current === 0) {
          const completedClients = Array.from(approvalProgressRefreshPendingRef.current);
          approvalProgressRefreshPendingRef.current.clear();
          void refreshClients(projectRoot, false, false, false, completedClients).catch(console.error);
        }
      } catch {
        // Keep the last known render state when a transient NAS read fails.
      } finally {
        approvalProgressPollInFlightRef.current = false;
      }
    };
    void pollApprovalProgress();
    const interval = window.setInterval(pollApprovalProgress, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      approvalProgressActiveRef.current.clear();
      approvalProgressRefreshPendingRef.current.clear();
      approvalProgressCompletionPendingRef.current.clear();
    };
  }, [projectRoot]);

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
    setClientCacheLoadedRoot(null);
    setClientListRevealedRoot(null);
    cachedClientNamesRef.current = new Set();
    setCachedClientNames(new Set());
    setClientRefreshFailedRoot(null);
    setExpandedClients(new Set());
    setSelectedVersionByClient({});
    setLastClientsCheckedAt(null);
    setError(null);
    setLoading(Boolean(nextRoot));
    setScanProgress(nextRoot ? { phase: "clients", completed: 0, total: 0 } : null);
    scanProgressVisibleRef.current = Boolean(nextRoot);
    if (!nextRoot) {
      setLoading(false);
      setClientCacheLoadedRoot("");
      try {
        await saveConfigValue("projectRoot", "");
      } catch (err) {
        setError(`Could not save project selection: ${String(err)}`);
      }
      return;
    }
    await loadClientCache(nextRoot);
    if (projectRootRef.current !== nextRoot) return;
    try {
      await saveConfigValue("projectRoot", nextRoot);
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

  const createProject = async () => {
    const showName = customProjectShowSelected ? customProjectShow.trim() : selectedProjectShow;
    if (!showName || projectCreateBusy) return;
    setProjectCreateBusy(true);
    setProjectCreateError("");
    try {
      const created = await invoke<ProjectRootOption>("create_project_folder", {
        showName,
        year: projectYear,
      });
      const roots = await invoke<ProjectRootOption[]>("list_project_roots");
      setProjectRoots(roots);
      setShowProjectCreate(false);
      setShowProjectMenu(false);
      await changeProjectRoot(created.path);
    } catch (err) {
      setProjectCreateError(String(err));
    } finally {
      setProjectCreateBusy(false);
    }
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
    if (!expandedClients.has(name)) {
      setSelectedVersionByClient((current) => {
        if (!(name in current)) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
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
    const customType = normalizeClientInput(customClientType).toUpperCase();
    if (newClientType === "CUSTOM" && !customType) {
      setError("Enter a custom mode name.");
      return;
    }
    const normalized = `${normalizeClientInput(baseName)}_${newClientType === "CUSTOM" ? customType : newClientType}`;
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
      setCreatedMariyaSeason(null);
      await refreshClients(undefined, false);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCreateMariyaMeetsSeason = async () => {
    if (!projectRoot || !isMariyaMeetsRoot) return;
    try {
      const season = await invoke<string>("create_mariya_meets_season", { projectRoot });
      setCreatedMariyaSeason(season);
      setShowNewClientForm(true);
      setNewClientType("MARIYAMEETS");
      await refreshClients(projectRoot, true);
      setError(null);
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
    setPublishingStage("publishing");
    setError(null);
    try {
      let message: string;
      try {
        message = await invoke<string>("promote_latest_export", {
          clientPath: client.path,
          expectedFilename: exportStatus.latest_filename,
        });
      } catch (err) {
        setPublishFailedClientPaths((current) => new Set(current).add(client.path));
        setError(`Publish failed: ${String(err)}`);
        void refreshClients(undefined, false, true).catch((refreshError) => console.warn("Could not refresh failed publish status", refreshError));
        return;
      }
      setPublishFailedClientPaths((current) => {
        const next = new Set(current);
        next.delete(client.path);
        return next;
      });
      showToast(message, "success");
      setPublishingStage("refreshing");
      try {
        await refreshClients(undefined, false, true);
      } catch (err) {
        setError(`Published, but project status could not refresh: ${String(err)}`);
      }
    } finally {
      setPublishingClientPath(null);
      setPublishingStage(null);
    }
  };

  const toggleManualPublished = async (client: ClientInfo) => {
    const next = { ...manualPublishedPaths };
    if (next[client.path]) delete next[client.path];
    else next[client.path] = true;
    setManualPublishedPaths(next);
    await saveConfigValue("manualPublishedClients", next);
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
        operation: "move",
        dryRun: false,
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

  const handleOpenFinal = async (client: ClientInfo) => {
    const filename = client.export_status.final_filename;
    if (!filename) return;
    const path = `${client.path.replace(/[\\/]+$/, "")}\\04_FINAL\\${filename}`;
    try {
      await openPath(path);
    } catch (err) {
      setError(`Failed to open FINAL video: ${path}. ${String(err)}`);
    }
  };

  const handleLogOpen = async () => {
    if (!projectRoot) return;
    try {
      const hasLogs = await invoke<boolean>("project_has_sort_logs", { projectRoot });
      if (!hasLogs) {
        showToast("No sort logs have been recorded for this project yet.", "info", 4500);
        return;
      }
      await invoke("open_folder", { path: `${projectRoot}/_logs` });
    } catch (err) {
      showToast(formatOpenError(`${projectRoot}/_logs`, err), "error", 7000);
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
      >
        <div className="topbar-brand" data-tauri-drag-region aria-label="Pepper">
          <span className="topbar-brand-icon" aria-hidden="true">
            <img src={pepperIcon} alt="" />
          </span>
          <span className="topbar-brand-wordmark">Pepper</span>
        </div>
        <div className="topbar-actions window-controls">
          <div className="notification-center" ref={notificationCenterRef}>
            <button
              type="button"
              className="notification-bell"
              aria-label={unreadNotificationCount ? `Notifications, ${unreadNotificationCount} unread` : "Notifications"}
              aria-expanded={showNotificationMenu}
              title="Notifications"
              onClick={() => {
                const opening = !showNotificationMenu;
                setShowNotificationMenu(opening);
                if (opening) setNotificationHistory((current) => current.map((entry) => ({ ...entry, unread: false })));
              }}
            >
              <Bell size={17} aria-hidden="true" />
              {unreadNotificationCount > 0 && <span className="notification-count">{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</span>}
            </button>
            {showNotificationMenu && (
              <section className="notification-popover" aria-label="Notification history">
                <header className="notification-popover-heading">
                  <div className="notification-popover-title">
                    <strong>Notifications</strong>
                    <span>{notificationHistory.length ? `${notificationHistory.length} recent` : "Up to date"}</span>
                  </div>
                  <button type="button" disabled={notificationHistory.length === 0} onClick={() => setNotificationHistory([])} aria-label="Clear notification history" title="Clear history"><Trash2 size={14} /></button>
                </header>
                {notificationHistory.length === 0 ? (
                  <p className="notification-empty">No notifications yet.</p>
                ) : (
                  <ul>
                    {notificationHistory.map((entry) => (
                      <li key={entry.id} className={`notification-entry ${entry.tone}`}>
                        <span className="notification-entry-mark" aria-hidden="true" />
                        <div><p>{entry.message}</p><time dateTime={new Date(entry.createdAt).toISOString()}>{formatUiDateTime(entry.createdAt)}</time></div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
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
            <Square size={14} aria-hidden="true" />
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
                <span className="project-switcher-icon" aria-hidden="true">
                  <FolderKanban size={18} strokeWidth={1.8} />
                </span>
                <span className={activeProject ? "project-switcher-copy" : "project-switcher-copy placeholder"}>
                  <small>Current project</small>
                  <strong>{activeProject ? formatProjectName(activeProject.name) : "Choose a production project"}</strong>
                </span>
                <ChevronsUpDown className="project-switcher-chevron" size={15} aria-hidden="true" />
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
                    <button
                      type="button"
                      className="project-create-menu-action"
                      onClick={() => {
                        setProjectCreateError("");
                        setProjectYear(new Date().getFullYear());
                        if (projectShowCatalog?.shows[0]) setSelectedProjectShow(projectShowCatalog.shows[0].name);
                        setCustomProjectShowSelected(false);
                        setCustomProjectShow("");
                        setShowProjectMenu(false);
                        setShowProjectCreate(true);
                      }}
                    >
                      <Plus size={15} aria-hidden="true" /> New Project
                    </button>
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
                      {visibleProjectRoots.map((project) => (
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
                          <span className="project-option-number">{project.number}</span>
                          <span className="project-option-name">{projectDisplayName(project.name)}</span>
                          {project.path === projectRoot && <Check size={15} aria-hidden="true" />}
                        </button>
                      ))}
                      {visibleProjectRoots.length === 0 && (
                        <div className="project-menu-empty">No projects match “{projectSearch}”.</div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          {advancedMode && (
            <div className="advanced-stats" aria-label="Project process statistics">
              <div className="advanced-stat">
                <span>Clients with valid exports</span>
                <strong>{advancedStats.updating ? "Updating" : `${advancedStats.exportClientCount} / ${advancedStats.clientCount}`}</strong>
                <small>{advancedStats.exportIssueCount ? `${advancedStats.exportIssueCount} export scan issues excluded` : "Source export history found"}</small>
              </div>
              <div className="advanced-stat">
                <span>Average source versions</span>
                <strong>{advancedStats.updating ? "Updating" : advancedStats.averageVersions === null ? "N/A" : advancedStats.averageVersions.toFixed(1)}</strong>
                <small>{advancedStats.totalVersions} versions across {advancedStats.exportClientCount} clients</small>
              </div>
              <div className="advanced-stat">
                <span>Latest export approval ready</span>
                <strong>{advancedStats.updating ? "Updating" : `${advancedStats.approvalReadyCount} / ${advancedStats.exportClientCount}`}</strong>
                <small>{advancedStats.exportClientCount ? `${Math.round(advancedStats.approvalReadyCount / advancedStats.exportClientCount * 100)}% of exported clients` : "No clients with exports"}</small>
              </div>
              <div className="advanced-stat">
                <span>Current FINAL published</span>
                <strong>{advancedStats.updating ? "Updating" : `${advancedStats.finalCurrentCount} / ${advancedStats.exportClientCount}`}</strong>
                <small>Manual overrides are excluded</small>
              </div>
              <div className="advanced-stat">
                <span>Awaiting approval</span>
                <strong>{advancedStats.updating ? "Updating" : advancedStats.awaitingApprovalCount}</strong>
                <small>Latest export has no approval copy in progress</small>
              </div>
              <div className="advanced-stat">
                <span>Awaiting FINAL</span>
                <strong>{advancedStats.updating ? "Updating" : advancedStats.awaitingFinalCount}</strong>
                <small>Latest export has no current FINAL</small>
              </div>
              <div className="advanced-stat">
                <span>Average approval to FINAL</span>
                <strong>{advancedStats.updating ? "Updating" : formatAverageDuration(advancedStats.averageApprovalToPublishMs)}</strong>
                <small>Approval file to FINAL time; legacy uses available file timestamps ({advancedStats.approvalPublishSampleCount} clients)</small>
              </div>
              <div className="advanced-stat">
                <span>Manual published overrides</span>
                <strong>{advancedStats.updating ? "Updating" : advancedStats.manualOverrideCount}</strong>
                <small>Overrides set in Advanced mode</small>
              </div>
            </div>
          )}
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
              <div className="client-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Find a client"
                  aria-label="Find a client"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button type="button" className="client-search-clear" onClick={() => setSearch("")} aria-label="Clear client search" title="Clear search">
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="client-toolbar-actions">
                <span className="client-result-count" aria-live="polite">
                  {clientRefreshFailedRoot === projectRoot && cachedClientNames.size > 0
                      ? "Cached · refresh failed"
                    : `${visibleClients.length} ${visibleClients.length === 1 ? "client" : "clients"}`}
                </span>
                {isMariyaMeetsRoot && <button type="button" className="ghost new-season-button" onClick={() => void handleCreateMariyaMeetsSeason()} title="Create the next Mariya Meets season">New season</button>}
                {advancedMode && <button
                  type="button"
                  className="ghost icon-button refresh-button"
                  onClick={() => void refreshClients()}
                  disabled={!projectRoot || loading}
                  aria-label="Refresh clients"
                  title={lastClientsCheckedAt ? `Last updated ${formatUiDateTime(lastClientsCheckedAt)}` : "Refresh clients"}
                >
                  <RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />
                </button>}
                <button
                  type="button"
                  className="ghost new-client-button"
                  disabled={!projectRoot}
                  aria-expanded={showNewClientForm}
                  aria-label="New client"
                  title="New client"
                  onClick={() => setShowNewClientForm((current) => !current)}
                >
                  <Plus size={16} aria-hidden="true" />
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
                  <span className="more-options-ellipsis" aria-hidden="true">...</span>
                </button>
              </div>
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
                    checked={advancedMode || advancedModeRequested}
                    onChange={(event) => {
                      if (!event.target.checked) {
                        setAdvancedMode(false);
                        setAdvancedModeRequested(false);
                        setAdvancedPassword("");
                        setAdvancedPasswordError("");
                      } else {
                        setAdvancedModeRequested(true);
                        setAdvancedPasswordError("");
                      }
                    }}
                  />
                  Advanced mode
                </label>
                {advancedModeRequested && !advancedMode && (
                  <form className="advanced-password-form" onSubmit={(event) => {
                    event.preventDefault();
                    if (advancedPassword === "fidelio") {
                      setAdvancedMode(true);
                      setAdvancedModeRequested(false);
                      setAdvancedPassword("");
                      setAdvancedPasswordError("");
                    } else setAdvancedPasswordError("Incorrect password");
                  }}>
                    <input type="password" autoComplete="current-password" value={advancedPassword} onChange={(event) => setAdvancedPassword(event.target.value)} placeholder="Advanced mode password" aria-label="Advanced mode password" />
                    <button type="submit" className="ghost" disabled={!advancedPassword}>Confirm</button>
                    {advancedPasswordError && <small role="alert">{advancedPasswordError}</small>}
                  </form>
                )}
                {advancedMode && <>
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
                </>}
                <div className="advanced-utility-row">
                  <button
                    type="button"
                    className="ghost advanced-utility-button"
                    aria-label="Frame.io settings"
                    title={frameIoConfigured ? "Frame.io settings — destination configured" : "Frame.io settings — setup required"}
                    onClick={() => {
                      setShowAdvancedMenu(false);
                      openFrameIoSettings();
                    }}
                  >
                    <Settings2 size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ghost advanced-utility-button"
                    aria-label="Check for updates"
                    title={checkingForUpdates ? "Checking for updates" : "Check for updates"}
                    disabled={checkingForUpdates}
                    onClick={() => void checkForUpdates()}
                  >
                    <RefreshCw size={15} className={checkingForUpdates ? "spinning" : ""} aria-hidden="true" />
                  </button>
                </div>
                <div className="advanced-actions">
                  {advancedMode && <button type="button" className="ghost" onClick={() => setShowUndoConfirm(true)} disabled={!lastBatch.length}>Undo last</button>}
                  {advancedMode && <button type="button" className="ghost" onClick={() => void handleLogOpen()} disabled={!projectRoot}>View log</button>}
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
                  Client {sortIcon("name")}
                </button>
              </div>
              <div>
                <button
                  type="button"
                  className={`column-sort ${clientSort.column === "status" ? "active" : ""}`}
                  onClick={() => toggleClientSort("status")}
                  aria-label={clientSort.column === "status" && clientSort.direction === "asc" ? "Status: unfinished first. Click to show finalised first" : "Sort status: unfinished first"}
                  title={clientSort.column === "status" && clientSort.direction === "asc" ? "Show finalised projects first" : "Show unfinished projects first"}
                >
                  Status {sortIcon("status")}
                </button>
              </div>
              <div>Actions</div>
            </div>
            {loading && visibleClients.length === 0 && clients.length > 0 && (
              <div className="table-row">Loading…</div>
            )}
            {visibleClients.length === 0 && !loading && (
              <div className="table-row">
                {projectRoot ? "No clients found." : "Select a numbered project to view clients."}
              </div>
            )}
            {isMariyaMeetsRoot && visibleClients.length === 0 && createdMariyaSeason && (
              <div className="season-divider" role="heading" aria-level={2}>{createdMariyaSeason}</div>
            )}
            {clientListReady && visibleClients.map((client, index) => {
                const label = parseClientLabel(client.name);
                const clientIsCached = cachedClientNames.has(client.name);
                const droppable = screen === "sort" && client.status !== "Not a client" && !clientIsCached;
                const exports = client.export_status;
                const version = exports.latest_version ?? exports.final_version;
                const sortedApprovalVersions = [...exports.approval_versions].sort((left, right) => {
                  const leftSuperseded = left.relative_path.split(/[\\/]/).some((part) => part.toLowerCase() === "superseded");
                  const rightSuperseded = right.relative_path.split(/[\\/]/).some((part) => part.toLowerCase() === "superseded");
                  return right.version - left.version
                    || Number(leftSuperseded) - Number(rightSuperseded)
                    || Date.parse(right.added_at) - Date.parse(left.added_at)
                    || right.filename.localeCompare(left.filename);
                });
                const latestApprovalVersion = sortedApprovalVersions[0];
                const latestSourceStem = exports.latest_filename?.replace(/\.[^.]+$/, "");
                const expectedApprovalFilename = latestSourceStem
                  ? `${latestSourceStem}_APPROVAL_1080p_WM_TC.mp4`.toLowerCase()
                  : null;
                const currentExportApproval = expectedApprovalFilename
                  ? sortedApprovalVersions.find((approval) => approval.filename.toLowerCase() === expectedApprovalFilename)
                  : undefined;
                const creatingApprovalVersion = exports.approval_in_progress
                  && exports.latest_version !== null
                  && !currentExportApproval;
                const latestApprovalIsRendering = exports.approval_in_progress
                  && latestApprovalVersion?.relative_path === currentExportApproval?.relative_path;
                const latestApprovalPath = latestApprovalVersion
                  ? `${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${latestApprovalVersion.relative_path.replace(/[\\/]+/g, "\\")}`
                  : null;
                const latestFrameIoProgress = latestApprovalPath ? frameIoProgress[latestApprovalPath] : undefined;
                const latestFrameIoRecord = latestApprovalVersion?.frameio;
                const latestFrameIoRecordMatchesDestination = latestFrameIoRecord?.destination_account_id === frameIoConfig.accountId
                  && latestFrameIoRecord?.destination_project_id === frameIoConfig.projectId;
                const latestFrameIoState = latestFrameIoProgress?.state ?? (latestFrameIoRecordMatchesDestination ? latestFrameIoRecord?.state : undefined);
                const latestFrameIoBusy = latestApprovalPath !== null && frameIoBusyPath === latestApprovalPath;
                const latestFrameIoShareUrl = latestFrameIoProgress?.state === "ready" && latestFrameIoProgress.share_url
                  ? latestFrameIoProgress.share_url
                  : latestFrameIoBusy ? null : latestFrameIoProgress?.share_url ?? (latestFrameIoRecordMatchesDestination ? latestFrameIoRecord?.share_url : null);
                const latestFrameIoShareRetryAvailable = latestFrameIoState === "share_needs_reconciliation"
                  || latestFrameIoState === "creating_share"
                  || (latestFrameIoState === "ready" && latestFrameIoRecordMatchesDestination && !latestFrameIoRecord?.share_url);
                const latestFrameIoHasUnfinishedJob = Boolean(latestFrameIoState && latestFrameIoState !== "ready"
                  && !latestFrameIoBusy && !latestFrameIoShareRetryAvailable);
                const uploadPercent = latestFrameIoProgress && latestFrameIoProgress.total > 0
                  ? Math.max(0, Math.min(99, Math.floor(latestFrameIoProgress.uploaded / latestFrameIoProgress.total * 100)))
                  : null;
                const frameIoUploadLabel = latestFrameIoState === "uploading"
                  ? uploadPercent !== null ? `Uploading ${uploadPercent}%` : "Uploading…"
                  : latestFrameIoState === "processing" ? "Processing on Frame.io…"
                    : latestFrameIoState === "creating_version_stack" ? "Adding version…"
                      : latestFrameIoState === "updating_share" ? "Updating share link…"
                        : latestFrameIoState === "creating_share" ? "Creating share link…"
                          : latestFrameIoState === "finalizing_review" ? "Preparing review link…"
                            : latestFrameIoState === "preparing" ? "Preparing upload…" : "Sending for review…";
                const latestApprovalShared = latestApprovalVersion?.version === exports.latest_version
                  && (latestFrameIoState === "ready" || Boolean(latestFrameIoShareUrl));
                const expanded = expandedClients.has(client.name);
                const manuallyPublished = Boolean(manualPublishedPaths[client.path]);
                const published = manuallyPublished || isFinalised(client);
                const previousClient = visibleClients[index - 1];
                const previousPublished = previousClient
                  ? Boolean(manualPublishedPaths[previousClient.path]) || isFinalised(previousClient)
                  : false;
                const computedPublishedDividerStarts = published && (!previousClient
                  || (isMariyaMeetsRoot && previousClient.season !== client.season)
                  || !previousPublished);
                const publishedDividerStarts = search.trim()
                  ? computedPublishedDividerStarts
                  : client.cachePublishedDividerBefore ?? computedPublishedDividerStarts;
                const publishFailed = exports.publish_failed || publishFailedClientPaths.has(client.path);
                const exportLabel = manuallyPublished
                  ? "FINAL"
                  : client.exportStatusLoading
                  ? "Loading exports…"
                  : exports.approval_in_progress
                    ? "Approval export in progress"
                  : exports.issue
                  ? "Check exports"
                  : published
                    ? "FINAL"
                    : exports.latest_filename
                      ? exports.final_filename
                        ? exports.final_version !== null && exports.latest_version !== null && exports.final_version < exports.latest_version
                          ? "FINAL outdated" : "FINAL unverified"
                        : latestApprovalShared ? "Shared"
                          : exports.approval_ready ? "Approval ready" : "Export ready"
                      : "No exports";
                const exportNeedsAttention = Boolean(
                  exports.issue || exportLabel === "FINAL outdated" || exportLabel === "FINAL unverified"
                );
                const exportSummary = version !== null && exportLabel !== "FINAL"
                  ? `V${version} · ${exportLabel}`
                  : exportLabel;
                const versionCreatedAt = exports.versions
                  .map((item) => Date.parse(item.added_at))
                  .filter(Number.isFinite);
                const firstVersionAt = versionCreatedAt.length ? Math.min(...versionCreatedAt) : null;
                const finalPublishedAt = exports.final_published_at ? Date.parse(exports.final_published_at) : Number.NaN;
                const totalVersions = Math.max(
                  exports.versions.length,
                  exports.latest_version ?? 0,
                  exports.final_version ?? 0,
                );
                const timeToFinal = firstVersionAt !== null
                  && Number.isFinite(finalPublishedAt)
                  && finalPublishedAt >= firstVersionAt
                  ? formatAverageDuration(finalPublishedAt - firstVersionAt)
                  : null;
                const publishedVersionDetails = !manuallyPublished && isFinalised(client)
                  ? [
                    `Versions: ${totalVersions}`,
                    timeToFinal && `Time from first version to FINAL: ${timeToFinal}`,
                  ]
                  : [];
                const exportDetails = manuallyPublished
                  ? "Manually marked as published in Advanced mode"
                  : client.exportStatusLoading
                  ? "Checking this client's exports…"
                  : isFinalised(client)
                    ? publishedVersionDetails.filter(Boolean).join("\n")
                    : [
                      exports.issue,
                      exports.approval_in_progress && `Approval copy is being rendered and validated${exports.approval_progress_phase ? ` (${exports.approval_progress_phase})` : ""}`,
                      exports.final_filename && `FINAL: ${exports.final_filename}`,
                      exports.versions.length > 0 && `Versions: ${exports.versions.map((item) => `V${item.version}`).join(", ")}`,
                    ].filter(Boolean).join("\n");
                const lastApprovalVersion = sortedApprovalVersions[0];
                const selectedVersionPath = (exports.approval_in_progress
                  ? lastApprovalVersion?.relative_path
                  : selectedVersionByClient[client.name]) ?? lastApprovalVersion?.relative_path;
                const selectedApprovalVersion = sortedApprovalVersions.find((item) => item.relative_path === selectedVersionPath)
                  ?? lastApprovalVersion;
                const selectedApprovalPath = selectedApprovalVersion
                  ? `${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${selectedApprovalVersion.relative_path.replace(/[\\/]+/g, "\\")}`
                  : null;
                const pendingApprovalEntry = creatingApprovalVersion && exports.latest_version !== null
                  ? (
                    <div className="version-entry version-pending" aria-label={`V${exports.latest_version} approval export in progress`}>
                      <div className="version-option" aria-disabled="true">
                        <span className="version-option-heading">
                          <span className="version-option-number version-label">V{exports.latest_version}</span>
                          <span className="version-pending-label">Creating approval copy</span>
                          <LoaderCircle className="approval-progress-spinner" size={15} aria-hidden="true" />
                        </span>
                      </div>
                    </div>
                  )
                  : null;
                return (
                  <Fragment key={client.path}>
                  {isMariyaMeetsRoot && client.season && client.season !== visibleClients[index - 1]?.season && (
                    <div className="season-divider" role="heading" aria-level={2}>{client.season}</div>
                  )}
                  {publishedDividerStarts && (
                    <div className="published-divider" role="heading" aria-level={2}>Published</div>
                  )}
                  <div
                    className={`table-row client-row ${clientIsCached ? "cached-client-row" : ""} ${droppable ? "droppable-row" : ""} ${
                      dragTarget === client.name ? "drag-over" : ""
                    } ${published ? "published-row" : ""} ${expanded ? "expanded-row" : ""}`}
                    style={{ animationDelay: `${Math.min(index * 18, 180)}ms` }}
                    data-client-name={client.name}
                    data-client={droppable ? client.name : undefined}
                    onClick={() => toggleClientExpanded(client.name)}
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
                    <button
                      type="button"
                      className="client-row-disclosure"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${label.name} export versions`}
                    />
                    <div>
                      <div className="client-title">
                        <span className="client-expand-icon" aria-hidden="true">
                          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </span>
                        <span className="client-name">{expanded ? label.name : label.name.toUpperCase()}</span>
                        {label.type && (
                          <span className={`client-tag ${label.type.toLowerCase()}`}>
                            {label.type}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={`client-statuses ${clientIsCached ? "" : !client.exportStatusLoading ? "client-status-enter" : ""}`}>
                      {!clientIsCached && client.status !== "OK" && (
                      <span
                        className={`badge ${client.status
                          .toLowerCase()
                          .replace(/\s/g, "-")}`}
                      >
                        {client.status}
                      </span>
                      )}
                      {!clientIsCached && client.status !== "Not a client" && (
                        <>
                          {client.exportStatusLoading ? (
                            <span className="client-status-space" aria-hidden="true" />
                          ) : (
                            <span className="client-export-status">
                              {exports.approval_in_progress ? (
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
                                <span className="status-text final-state" title={exportDetails} aria-label="Published">
                                  <Check size={14} aria-hidden="true" />
                                </span>
                              ) : exportLabel === "Shared" ? (
                                <span className="status-text shared-state" title={exportDetails}>
                                  <Link2 size={14} aria-hidden="true" /> {exportSummary}
                                </span>
                              ) : exportLabel === "No exports" ? (
                                <span className="status-text empty-state" title={exportDetails}>No exports</span>
                              ) : (
                                <span className="status-text" title={exportDetails}>{exportSummary}</span>
                              )}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="actions" onClick={(event) => event.stopPropagation()}>
                      {advancedMode && client.status !== "Not a client" && (manuallyPublished || !isFinalised(client)) && (
                        <button type="button" className="ghost promote-button" onClick={() => void toggleManualPublished(client)} title={manuallyPublished ? "Remove manual published override" : "Mark this client as published manually"}>
                          {manuallyPublished ? "Clear override" : "Mark published"}
                        </button>
                      )}
                      <button
                        className="ghost icon-button"
                        onClick={() => handleOpenFolder(client.path)}
                        aria-label="Open folder"
                        title="Open folder"
                      >
                        <FolderOpen size={17} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                      {client.status !== "Not a client" && exports.latest_filename && !exports.issue && (!published || publishFailed) && (
                        <button
                          type="button"
                          className="ghost promote-button"
                          onClick={() => setPendingPromotion({ ...client, export_status: { ...exports, publish_failed: publishFailed } })}
                          disabled={Boolean(busy || publishingClientPath || !exports.latest_filename || exports.issue)}
                          title={`${publishFailed ? "Retry failed publish" : "Publish"} ${exports.latest_filename}`}
                        >
                          {publishingClientPath === client.path ? (
                            <span className="publish-progress-content">
                              <span className="publish-progress-label">{publishingStage === "refreshing" ? "Refreshing project…" : "Publishing export…"}</span>
                              <span className="publish-progress-track" role="progressbar" aria-label={publishingStage === "refreshing" ? "Refreshing project status" : "Publishing export"} aria-valuetext={publishingStage === "refreshing" ? "Refreshing project status" : "Publishing export"}>
                                <span className={`publish-progress-indicator ${publishingStage === "refreshing" ? "is-refreshing" : ""}`} />
                              </span>
                            </span>
                          ) : publishFailed ? "Failed" : "Publish"}
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
                      {exports.final_filename && !exports.issue && (
                        <button
                          type="button"
                          className="ghost icon-button"
                          onClick={() => void handleOpenFinal(client)}
                          aria-label="Open FINAL video"
                          title="Open FINAL video"
                        >
                          <Clapperboard size={17} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                </div>
                {expanded && !client.exportStatusLoading && (
                  <div className="client-details">
                    {sortedApprovalVersions.length === 0 ? (
                      pendingApprovalEntry
                        ? <div className="version-list" role="group" aria-label={`${label.name} approval versions`}>{pendingApprovalEntry}</div>
                        : <div className="versions-empty">No finalized watermarked approval copies found.</div>
                    ) : selectedApprovalVersion && selectedApprovalPath && (
                      <div className="version-browser">
                        <article className="export-preview">
                          <div className="export-preview-heading">
                            <div className="export-preview-title">
                              <span className="version-label">V{selectedApprovalVersion.version}</span>
                              <strong>{selectedApprovalVersion.filename}</strong>
                            </div>
                            <time dateTime={selectedApprovalVersion.added_at}>
                              Added {formatUiDateTime(selectedApprovalVersion.added_at)}
                            </time>
                          </div>
                          <InlineVideoPlayer
                            key={selectedApprovalPath}
                            className="approval-video-player"
                            src={convertFileSrc(selectedApprovalPath)}
                          />
                        </article>
                        <div className="version-list" role="group" aria-label={`${label.name} approval versions`}>
                          {pendingApprovalEntry}
                          {sortedApprovalVersions.map((approvalVersion) => {
                            const selected = approvalVersion.relative_path === selectedApprovalVersion.relative_path;
                            return (
                              <div
                                className={`version-entry ${selected ? "selected" : ""}`}
                                key={`${approvalVersion.version}-${approvalVersion.filename}`}
                              >
                                <button
                                  type="button"
                                  aria-pressed={selected}
                                  className="version-option"
                                  onClick={() => setSelectedVersionByClient((current) => ({
                                    ...current,
                                    [client.name]: approvalVersion.relative_path,
                                  }))}
                                >
                                  <span className="version-option-heading">
                                    <span className="version-option-number version-label">V{approvalVersion.version}</span>
                                    {approvalVersion.relative_path === lastApprovalVersion?.relative_path && <span className="version-latest">Latest</span>}
                                    <time dateTime={approvalVersion.added_at} title={formatUiDateTime(approvalVersion.added_at)}>
                                      {new Date(approvalVersion.added_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                    </time>
                                  </span>
                                </button>
                                {approvalVersion.relative_path === lastApprovalVersion?.relative_path && latestApprovalPath && (
                                  <div className="frameio-inline-row">
                                    {!latestFrameIoShareUrl && (
                                      <span className="frameio-inline-label">
                                        {latestFrameIoBusy ? frameIoUploadLabel : "Frame.io review"}
                                      </span>
                                    )}
                                    {latestFrameIoShareUrl ? (
                                      <button
                                        type="button"
                                        className="frameio-open-link"
                                        title="Frame.io review link"
                                        aria-label={`Open Frame.io review: ${latestFrameIoShareUrl}`}
                                        onClick={() => void invoke("frameio_open_external_url", { url: latestFrameIoShareUrl }).catch((err) => showToast(String(err), "error", 7000))}
                                      >
                                        <Link2 size={15} aria-hidden="true" />
                                        <span>{latestFrameIoShareUrl.replace(/^https?:\/\//, "")}</span>
                                      </button>
                                    ) : latestFrameIoHasUnfinishedJob ? (
                                      <span className="frameio-inline-label">{latestFrameIoRecord?.last_error ?? "Frame.io upload needs reconciliation"}</span>
                                    ) : !frameIoConfigured ? (
                                      <button
                                        type="button"
                                        className="frameio-icon-button"
                                        title="Set up Frame.io review delivery"
                                        aria-label="Set up Frame.io review delivery"
                                        onClick={openFrameIoSettings}
                                      >
                                        <Settings2 size={16} aria-hidden="true" />
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="frameio-icon-button"
                                        title={latestApprovalIsRendering
                                          ? "Wait until this approval version has finished rendering"
                                          : latestFrameIoBusy ? frameIoUploadLabel : latestFrameIoShareRetryAvailable ? "Retry share link; video already uploaded" : "Send for review"}
                                        aria-label={latestApprovalIsRendering
                                          ? "Approval export in progress"
                                          : latestFrameIoBusy ? frameIoUploadLabel : latestFrameIoShareRetryAvailable ? "Retry share link; video already uploaded" : "Send for review"}
                                        disabled={client.exportStatusLoading || !activeProject || frameIoBusyPath === latestApprovalPath || latestApprovalIsRendering}
                                        onClick={() => activeProject && void uploadApprovalToFrameIo(latestApprovalPath, client.name, activeProject.name, activeProject.path)}
                                      >
                                        {frameIoBusyPath === latestApprovalPath
                                          ? <LoaderCircle className="approval-progress-spinner" size={16} aria-hidden="true" />
                                          : latestFrameIoShareRetryAvailable ? <Link2 size={16} aria-hidden="true" /> : <CloudUpload size={16} aria-hidden="true" />}
                                      </button>
                                    )}
                                    {latestFrameIoShareUrl ? (
                                      <button
                                        type="button"
                                        className="frameio-icon-button copy"
                                        title="Copy to clipboard"
                                        aria-label="Copy Frame.io share link"
                                        onClick={() => void copyFrameIoShareLink(latestFrameIoShareUrl)}
                                      >
                                        <Copy size={14} aria-hidden="true" />
                                      </button>
                                    ) : latestFrameIoProgress?.message || (latestFrameIoRecordMatchesDestination && latestFrameIoRecord?.last_error) ? (
                                      <span className="frameio-inline-message">{latestFrameIoProgress?.message ?? latestFrameIoRecord?.last_error}</span>
                                    ) : null}
                                    {latestFrameIoBusy && latestFrameIoState === "uploading" && uploadPercent !== null && (
                                      <progress
                                        className="frameio-upload-progress"
                                        value={uploadPercent}
                                        max={100}
                                        aria-label="Upload to Frame.io"
                                        title={`${((latestFrameIoProgress?.uploaded ?? 0) / 1048576).toFixed(1)} MB of ${((latestFrameIoProgress?.total ?? 0) / 1048576).toFixed(1)} MB`}
                                      />
                                    )}
                                  </div>
                                )}
                              </div>
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
            </div>
          </div>
          {projectRoot && clientRefreshFailedRoot === projectRoot && (
            <div
              className="client-refresh-overlay"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="client-refresh-error-title"
              aria-describedby="client-refresh-error-description"
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  event.preventDefault();
                  event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
                }
              }}
            >
              <div className="client-refresh-overlay-card">
                <h2 id="client-refresh-error-title">Project folder unavailable</h2>
                <p id="client-refresh-error-description">
                  Pepper couldn’t refresh this project. The last saved client list is preserved, and project actions are paused until the folder is available again.
                </p>
                <button
                  type="button"
                  className="primary client-refresh-overlay-action"
                  autoFocus
                  disabled={loading}
                  onClick={() => void refreshClients(projectRoot, true, true, true)}
                >
                  {loading ? "Retrying…" : "Retry refresh"}
                </button>
              </div>
            </div>
          )}
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
          {advancedMode && <button className="ghost" onClick={handleLogOpen} disabled={!projectRoot}>View log</button>}
          {advancedMode && <button className="ghost" onClick={() => refreshClients()} disabled={!projectRoot}>Refresh</button>}
        </div>
      </footer>

      {showFrameIoConfig && (
        <div className="modal-backdrop" onClick={() => setShowFrameIoConfig(false)}>
          <div className="modal frameio-config-modal" onClick={(event) => event.stopPropagation()}>
            <div className="frameio-config-header">
              <div>
                <h2>Frame.io</h2>
                <p>Send Pepper’s watermarked approval copies to a shared review project.</p>
              </div>
              <span className={`frameio-state-badge ${frameIoConfigured ? "ready" : "idle"}`}>
                {frameIoConfigured ? "Destination configured" : "Setup required"}
              </span>
            </div>
            <section className="frameio-config-section">
              <div className="frameio-config-section-heading">
                <strong>Upload destination</strong>
                <span>Choose where Pepper should place review files.</span>
              </div>
              <div className="frameio-config-grid">
                <label>Account<select value={frameIoConfig.accountId} onChange={(event) => void selectFrameIoAccount(event.target.value)} disabled={frameIoLoadingChoices || frameIoAccounts.length === 0}><option value="">{frameIoAccounts.length ? "Select an account" : "Connect Adobe to load accounts"}</option>{frameIoAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label>Project<select value={frameIoConfig.projectId} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, projectId: event.target.value })} disabled={!frameIoConfig.accountId || frameIoLoadingChoices || frameIoProjects.length === 0}><option value="">{frameIoProjects.length ? "Select a project" : frameIoConfig.accountId ? "No projects returned for this account" : "Choose an account first"}</option>{frameIoProjects.map((project) => <option key={project.id} value={project.id}>{project.workspace_name ? `${project.workspace_name} — ` : ""}{project.name}</option>)}</select></label>
              </div>
              <p className="frameio-help frameio-config-destination">Uploads use Callum’s Account. Choose the review project; workspace names are shown when Frame.io returns them.</p>
            </section>
            <section className="frameio-storage-section" aria-live="polite">
              <div className="frameio-storage-heading">
                <div><strong>Account storage</strong><span>Frame.io account quota</span></div>
                <button type="button" className="frameio-storage-refresh" disabled={frameIoStorageLoading || !frameIoConfig.accountId} onClick={() => void loadFrameIoStorage()} title="Refresh storage"><RefreshCw size={13} className={frameIoStorageLoading ? "spinning" : ""} /> Refresh</button>
              </div>
              {frameIoStorageLoading && <p className="frameio-storage-note">Loading storage usage…</p>}
              {!frameIoStorageLoading && frameIoStorage && (() => {
                const remaining = Math.max(0, frameIoStorage.limitBytes - frameIoStorage.usedBytes);
                const percentage = frameIoStorage.limitBytes > 0 ? Math.min(100, frameIoStorage.usedBytes / frameIoStorage.limitBytes * 100) : 0;
                return <>
                  <div className="frameio-storage-numbers"><strong>{formatStorage(remaining)} remaining</strong><span>{formatStorage(frameIoStorage.usedBytes)} of {formatStorage(frameIoStorage.limitBytes)} used</span></div>
                  <div className="frameio-storage-track" role="progressbar" aria-label="Frame.io storage used" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percentage}%` }} /></div>
                </>;
              })()}
              {!frameIoStorageLoading && !frameIoStorage && <p className="frameio-storage-note">{frameIoStorageError ?? (frameIoConfig.accountId ? "Storage usage is unavailable." : "Select an account to view its storage quota.")}</p>}
            </section>
            <details className="frameio-advanced-settings">
              <summary>Advanced Adobe OAuth settings</summary>
              <div className="frameio-advanced-fields">
                <label>Client ID<input value={frameIoConfig.clientId} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, clientId: event.target.value })} placeholder="From Adobe Developer Console" /></label>
                <label>OAuth scopes<input value={frameIoConfig.scopes} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, scopes: event.target.value })} placeholder="Scopes enabled for this credential" /></label>
                <p className="frameio-help">Pepper uses the Adobe Native App redirect URI assigned to this credential. Credentials stay in this computer’s secure credential store.</p>
              </div>
            </details>
            <p className="frameio-help">Share links require downloads to be enabled on the current Frame.io plan.</p>
            {frameIoLoadingChoices && <p className="frameio-help">Loading accounts and projects…</p>}
            {frameIoSetupError && <p className="frameio-setup-error">{frameIoSetupError}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost" disabled={frameIoAuthBusy} onClick={() => setShowFrameIoConfig(false)}>Close</button>
              {frameIoAccounts.length > 0 && <button type="button" className="ghost" disabled={frameIoLoadingChoices} onClick={() => void loadFrameIoChoices().catch(() => undefined)}>Refresh accounts</button>}
              {frameIoAuthBusy && <button type="button" className="ghost" onClick={() => void cancelFrameIoAuth()}>Cancel sign-in</button>}
              <button type="button" className="primary" disabled={!frameIoConfig.clientId || !frameIoConfig.scopes || frameIoLoadingChoices || frameIoAuthBusy} onClick={() => void connectFrameIo()}>{frameIoAuthBusy ? "Waiting for Adobe…" : frameIoAccounts.length ? "Reconnect Adobe" : "Connect Adobe & load accounts"}</button>
            </div>
          </div>
        </div>
      )}

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
          <h2 id="promotion-title">{pendingPromotion.export_status.publish_failed ? "Retry failed publish?" : "Publish version?"}</h2>
          <p id="promotion-description">
            {pendingPromotion.export_status.publish_failed ? "Retry publishing" : "Publish"} <strong>V{pendingPromotion.export_status.latest_version}</strong> for{" "}
            <strong>{parseClientLabel(pendingPromotion.name).name.toUpperCase()}</strong> to 04_FINAL.
          </p>
          {(() => {
            const cleanVersion = pendingPromotion.export_status.versions.find(
              (version) => version.version === pendingPromotion.export_status.latest_version,
            );
            if (!cleanVersion) return <p className="promotion-preview-empty">The clean master preview is unavailable. Refresh exports before publishing.</p>;
            const cleanPath = `${pendingPromotion.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${cleanVersion.relative_path.replace(/[\\/]+/g, "\\")}`;
            return (
              <article className="export-preview promotion-preview">
                <div className="export-preview-heading">
                  <div className="export-preview-title">
                    <span className="version-label">Clean V{cleanVersion.version}</span>
                    <strong>{cleanVersion.filename}</strong>
                  </div>
                  <span className="promotion-clean-label">Exact file sent to FINAL</span>
                </div>
                <InlineVideoPlayer className="promotion-video-player" src={convertFileSrc(cleanPath)} />
              </article>
            );
          })()}
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
            <button
              type="button"
              className="primary"
              disabled={!pendingPromotion.export_status.versions.some((version) => version.version === pendingPromotion.export_status.latest_version)}
              onClick={() => void handlePromoteLatest(pendingPromotion)}
            >
              {pendingPromotion.export_status.publish_failed ? "Retry publish" : "Publish"}
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
                    showToast("Could not install update.", "error");
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

      {showProjectCreate && (
        <div className="modal-backdrop" onClick={() => !projectCreateBusy && setShowProjectCreate(false)}>
          <div className="modal project-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-create-title" onClick={(event) => event.stopPropagation()}>
            <button className="project-create-close" type="button" aria-label="Close" onClick={() => setShowProjectCreate(false)} disabled={projectCreateBusy}><X size={17} /></button>
            <h2 id="project-create-title">New Project</h2>
            <span className="project-year-label">Show</span>
            <div className="project-show-grid" role="group" aria-label="Choose a show">
              {(projectShowCatalog?.shows ?? []).map((show) => (
                <button key={show.name} type="button" className={`project-show-option type-chip ${selectedProjectShow === show.name && !customProjectShowSelected ? "selected" : ""}`} aria-pressed={selectedProjectShow === show.name && !customProjectShowSelected} onClick={() => { setSelectedProjectShow(show.name); setCustomProjectShowSelected(false); }}>
                  {show.name}
                </button>
              ))}
              <button type="button" className={`project-show-option type-chip custom ${customProjectShowSelected ? "selected" : ""}`} aria-pressed={customProjectShowSelected} onClick={() => setCustomProjectShowSelected(true)}>CUSTOM</button>
            </div>
            {customProjectShowSelected && <input className="inline-input project-custom-show" autoFocus aria-label="Custom show name" placeholder="Custom show name" value={customProjectShow} onChange={(event) => setCustomProjectShow(event.target.value)} />}
            <div className="project-create-controls">
              <span className="project-year-label">Year</span>
              <div className="project-year-grid" role="group" aria-label="Choose a year">
                {Array.from({ length: 2 }, (_, offset) => new Date().getFullYear() + offset).map((year) => (
                  <button key={year} type="button" className={`project-year-option type-chip ${projectYear === year ? "selected" : ""}`} aria-pressed={projectYear === year} onClick={() => setProjectYear(year)}>{year}</button>
                ))}
              </div>
            </div>
            <div className="project-create-preview">Folder: <strong>{String(Math.max(0, ...projectRoots.map((project) => project.number)) + 1).padStart(2, "0")}_{(customProjectShowSelected ? customProjectShow.trim() : selectedProjectShow) || "Show"} {projectYear}</strong></div>
            {projectCreateError && <p className="project-create-error" role="alert">{projectCreateError}</p>}
            <div className="modal-actions">
              <button className="ghost" type="button" onClick={() => setShowProjectCreate(false)} disabled={projectCreateBusy}>Cancel</button>
              <button className="primary" type="button" onClick={() => void createProject()} disabled={projectCreateBusy || !(customProjectShowSelected ? customProjectShow.trim() : selectedProjectShow) || !projectShowCatalog}>{projectCreateBusy ? "Creating…" : "Create Project"}</button>
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
