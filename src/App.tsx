import { NotificationActivities } from "./components/NotificationActivities";
import { activityPercent, type NotificationActivity } from "./components/notificationActivity";
import { useBackgroundActivities } from "./components/useBackgroundActivities";
import { createCloseRequestHandler } from "./components/closeRequest";
import { ClientDropConfirm, type DropPreview, type DropChoices } from "./components/ClientDropConfirm";
import { ClientIssuesDialog, type ClientIssue } from "./components/ClientIssuesDialog";
import { ClientRowTransfer } from "./components/ClientRowTransfer";
import { ClientMediaDrop } from "./components/ClientMediaDrop";
import { mediaDropTarget } from "./components/clientMediaDropTarget";
import { clientTypeLabel, isHuddleClientType } from "./components/clientTypes";
import { InterviewTypeSelect, type HuddleTemplate } from "./components/InterviewTypeSelect";
import { memo, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent, ReactNode, RefObject, Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { cursorPosition, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type DragDropEvent } from "@tauri-apps/api/webview";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import type { PepperUpdate } from "./components/updateProgress";
import { UpdateDialog } from "./components/UpdateDialog";
import { InlineVideoPlayer } from "./components/InlineVideoPlayer";
import { Video as VideoIcon } from "lucide-react";
import { ArrowUpDown, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, ChevronsUpDown, CirclePlay, Clapperboard, CloudUpload, Copy, FileCheck2, FolderInput, FolderKanban, FolderOpen, Link2, LoaderCircle, Minus, Plus, RefreshCw, Search, Settings, Settings2, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { ProjectSeasonSelect, useProjectSeasons } from "./components/MariyaSeasonSelect";
import { IngestWorkspace } from "./components/IngestWorkspace";
import { isNativeFileDragActive } from "./components/nativeFileDrag";
import { ClientWorkspace } from "./components/ClientWorkspace";
import { createStudioSession, type StudioSession } from "./components/studioSessions";
import { ClientScrollArea } from "./components/ClientScrollArea";
import { ClientDetails } from "./components/ClientDetails";
import { useClientScrollPosition } from "./components/useClientScrollPosition";
import { CopyReviewLinkButton } from "./components/CopyReviewLinkButton";
import type { ClientClip } from "./components/useClientClips";
import { ClipReviewList } from "./components/ClipReviewList";
import { VersionHistory } from "./components/VersionHistory";
import { ClientLabel, parseClientLabel } from "./components/ClientLabel";
import pepperIcon from "../src-tauri/icons/128x128.png";
import "./App.css";
import "./components/ClientStatus.css";
import { IntegrationBrand } from "./components/IntegrationBrand";
import { SettingsDialog, type SettingsSection } from "./components/SettingsDialog";
import { StudioMailPeopleSettings, StudioMailSettings } from "./components/StudioMailSettings";
import { WorkspaceSettings } from "./components/WorkspaceSettings";
import type { WorkspaceConfig, WorkspaceDiscovery } from "./components/workspaceTypes";

type ClientStatus = "OK" | "Missing folders" | "Not a client";
type ClientSort = { column: "name" | "status"; direction: "asc" | "desc" };
type PromotionClip = { name:string; path:string; size:number; modified_ms:number; sha256:string; published:boolean; current:boolean };
type IngestProgress = { project_root:string; phase:string; source:string; completed:number; total:number };
type PepperMenuItem = { label: string; action: () => void; disabled?: boolean; separatorBefore?: boolean };
type PepperContextMenu = { x: number; y: number; title: string; items: PepperMenuItem[] };

function ExportStatusTooltip({
  id,
  details,
  versions,
  label,
  onActivate,
  children,
}: {
  id: string;
  details: string[];
  versions: number[];
  label: string;
  onActivate: () => void;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = () => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const tooltip = tooltipRef.current?.getBoundingClientRect();
    if (!anchor || !tooltip) return;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - tooltip.width / 2, window.innerWidth - tooltip.width - 8));
    const below = anchor.bottom + 7;
    const top = below + tooltip.height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - tooltip.height - 7);
    setPosition({ left, top });
  };

  const scheduleOpen = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      updatePosition();
      setOpen(true);
    }, 600);
  };

  const close = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      type="button"
      ref={anchorRef}
      className="export-status-tooltip-anchor export-status-control"
      aria-label={label}
      onClick={event => { event.stopPropagation(); close(); onActivate(); }}
      aria-describedby={open ? id : undefined}
      onMouseEnter={scheduleOpen}
      onMouseLeave={close}
      onFocus={scheduleOpen}
      onBlur={close}
      onKeyDown={event => { if (event.key === "Escape") close(); }}
    >
      {children}
      {open && createPortal(
        <span
          ref={tooltipRef}
          className="export-status-tooltip"
          id={id}
          role="tooltip"
          style={{ left: position.left, top: position.top }}
        >
          {details.map((detail) => (
            <span className="export-status-tooltip-detail" key={detail}>{detail}</span>
          ))}
          {versions.length > 0 && <span className="export-status-tooltip-versions">
            <span>Versions:</span>
            <span className="export-status-tooltip-version-list">
              {versions.map((version) => <span className="version-label" key={version}>V{version}</span>)}
            </span>
          </span>}
        </span>,
        document.body
      )}
    </button>
  );
}

type ClientInfo = {
  name: string;
  path: string;
  client_type?: string | null;
  huddle_template?: string | null;
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
type ApprovalProgressStatus = { client_name: string; phase: string | null; pending_version: number | null };

type ExportVersion = {
  size?: number | null;
  version: number;
  filename: string;
  relative_path: string;
  added_at: string;
  frameio: FrameIoRecord | null;
};

type FrameIoRecord = { state: string; file_id: string | null; share_url: string | null; last_error: string | null; updated_at: string; destination_account_id: string; destination_project_id: string };
type FrameIoProgress = { approval_path: string; state: string; uploaded: number; total: number; message: string | null; share_url: string | null };
type PublishProgress = { client_path: string; stage: "main" | "clips"; completed: number; total: number };
type FrameIoOption = { id: string; name: string; workspace_name: string | null };
type FrameIoStorage = { usedBytes: number; limitBytes: number };
type FrameIoStorageSnapshot = FrameIoStorage & { accountId: string; clientId: string };
type NotificationEntry = { id: string; message: string; tone: "info" | "success" | "error"; createdAt: number; unread: boolean };

type ExportStatus = {
  versions: ExportVersion[];
  approval_versions: ExportVersion[];
  latest_version: number | null;
  latest_filename: string | null;
  approval_ready: boolean;
  approval_in_progress: boolean;
  approval_progress_phase: string | null;
  approval_progress_version: number | null;
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
  approval_progress_version: null,
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
  bytes_done: number;
  bytes_total: number;
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

const CURSOR_Y_OFFSET = -20;
const DEBUG_ENABLED = false;

const normalizeClientInput = (value: string) =>
  value.trim().replace(/\s+/g, "_");

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

type PendingClientDrop = { id: string; client: ClientInfo; projectRoot: string; paths: string[]; folder: string; preview: DropPreview | null; error: string | null; choices: DropChoices };

type ClientRowActions = {
  confirmClientDrop: (clientPath: string, choices: DropChoices) => void;
  updateClientDropChoices: (clientPath: string, choices: DropChoices) => void;
  cancelClientDrop: (clientPath: string) => void;
  toggleClientExpanded: (name: string) => void;
  openPepperContextMenu: (event: MouseEvent, title: string, items: PepperMenuItem[]) => void;
  handleOpenFolder: (path: string) => Promise<void>;
  copyFromContextMenu: (value: string, description: string) => void;
  handleQuickCreateSession: (client: ClientInfo) => Promise<void>;
  refreshClients: (rootOverride?: string | undefined, showLoading?: boolean, force?: boolean, replaceExisting?: boolean, clientNames?: string[] | undefined) => Promise<void>;
  handleUnpublish: (client: ClientInfo) => Promise<void>;
  handlePublishClip: (client: ClientInfo, clip: ClientClip) => Promise<void>;
  showToast: (message: string, tone?: "info" | "success" | "error", duration?: number | null) => void;
  toggleManualPublished: (client: ClientInfo) => Promise<void>;
  toggleStatusWarnings: (client: ClientInfo) => Promise<void>;
  handleSortDragOver: (event: DragEvent<HTMLDivElement>) => Promise<void>;
  setDragTarget: Dispatch<SetStateAction<string | null>>;
  handleDropEvent: (event: DragEvent<HTMLDivElement>, client: ClientInfo) => void;
  setPendingPromotion: Dispatch<SetStateAction<ClientInfo | null>>;
  handleFixClient: (client: ClientInfo) => Promise<void>;
  handleOpenFinal: (client: ClientInfo) => Promise<void>;
  handleOpenFileLocation: (path: string) => Promise<void>;
  setSelectedVersionByClient: Dispatch<SetStateAction<Record<string, string>>>;
  openFrameIoSettings: () => void;
  setPendingFrameIoUpload: Dispatch<SetStateAction<{ path: string; clientKey: string; version: number; projectName: string; projectPath: string; } | null>>;
  uploadApprovalToFrameIo: (path: string, clientKey: string, productionProjectName: string, productionProjectPath: string) => Promise<void>;
  copyFrameIoShareLink: (url: string) => Promise<boolean>;
  removeFrameIoUpload: (path: string, clientKey: string, productionProjectPath: string, version: number) => void;
};

// Keep event handlers stable across menu/poll updates, while calling the latest
// committed implementation so actions never use stale project or status state.
function useClientRowActions(actions: ClientRowActions): ClientRowActions {
  const latest = useRef(actions);
  useLayoutEffect(() => { latest.current = actions; });
  const [stable] = useState(() => Object.fromEntries(
    Object.keys(actions).map((key) => [key, (...args: never[]) => {
      const action = latest.current[key as keyof ClientRowActions] as (...values: never[]) => unknown;
      return action(...args);
    }]),
  ) as ClientRowActions);
  return stable;
}

type ClientListRowProps = {
  client: ClientInfo;
  index: number;
  screen: "sort" | "home";
  frameIoProgress: Record<string, FrameIoProgress>;
  frameIoConfig: { accountId: string; projectId: string };
  frameIoBusyPath: string | null;
  busy: boolean;
  projectRoot: string;
  advancedMode: boolean;
  publishingClientPath: string | null;
  clipPublishStates: Record<string, "Queued" | "Publishing">;
  publishProgress: PublishProgress | null;
  hoverClientRef: RefObject<string | null>;
  workspaceTypeNames: Record<string, string>;
  frameIoConfigured: boolean;
  activeProject: ProjectRootOption | undefined;
  clientIsCached: boolean;
  expanded: boolean;
  manuallyPublished: boolean;
  warningsSuppressed: boolean;
  publishFailedOverride: boolean;
  selectedVersion: string | undefined;
  dragOver: boolean;
  dragKinds: string[] | null;
  transferProgress: SortProgress | null;
  pendingDrop: PendingClientDrop | null;
  creatingStudio: boolean;
  studioRequest: number;
  actions: ClientRowActions;
};

const ClientListRow = memo(function ClientListRow({
  client, index, screen, frameIoProgress, frameIoConfig, frameIoBusyPath, busy, projectRoot, advancedMode, publishingClientPath, clipPublishStates, publishProgress, hoverClientRef, workspaceTypeNames, frameIoConfigured, activeProject, clientIsCached, expanded, manuallyPublished, warningsSuppressed, publishFailedOverride, selectedVersion, dragOver, dragKinds, transferProgress, pendingDrop, creatingStudio, studioRequest, actions,
}: ClientListRowProps) {
  const { confirmClientDrop, updateClientDropChoices, cancelClientDrop, toggleClientExpanded, openPepperContextMenu, handleOpenFolder, copyFromContextMenu, handleQuickCreateSession, refreshClients, handleUnpublish, handlePublishClip, showToast, toggleManualPublished, toggleStatusWarnings, handleSortDragOver, setDragTarget, handleDropEvent, setPendingPromotion, handleFixClient, handleOpenFinal, handleOpenFileLocation, setSelectedVersionByClient, openFrameIoSettings, setPendingFrameIoUpload, uploadApprovalToFrameIo, copyFrameIoShareLink, removeFrameIoUpload } = actions;

  const [showIssues, setShowIssues] = useState(false);
  const label = parseClientLabel(client.name);

  const droppable = screen === "sort" && client.status !== "Not a client" && !clientIsCached && !pendingDrop && !transferProgress;
  const exports = client.export_status;
  const version = exports.latest_version ?? exports.final_version;
  const sortedApprovalVersions = useMemo(() => [...exports.approval_versions].sort((left, right) => {
    const leftSuperseded = left.relative_path.split(/[\\/]/).some((part) => part.toLowerCase() === "superseded");
    const rightSuperseded = right.relative_path.split(/[\\/]/).some((part) => part.toLowerCase() === "superseded");
    return right.version - left.version
      || Number(leftSuperseded) - Number(rightSuperseded)
      || Date.parse(right.added_at) - Date.parse(left.added_at)
      || right.filename.localeCompare(left.filename);
  }), [exports.approval_versions]);
  const latestApprovalVersion = sortedApprovalVersions[0];
  const creatingApprovalVersion = exports.approval_in_progress
    && exports.approval_progress_version !== null
    && !sortedApprovalVersions.some((approval) => approval.version === exports.approval_progress_version);
  const latestApprovalIsRendering = exports.approval_in_progress
    && exports.approval_progress_version !== null
    && latestApprovalVersion?.version === exports.approval_progress_version;
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
    : latestFrameIoBusy || latestFrameIoState !== "ready" ? null : latestFrameIoProgress?.share_url ?? (latestFrameIoRecordMatchesDestination ? latestFrameIoRecord?.share_url : null);
  const latestFrameIoShareRetryAvailable = latestFrameIoState === "share_needs_reconciliation"
    || latestFrameIoState === "creating_share"
    || latestFrameIoState === "updating_share"
    || latestFrameIoState === "share_asset_added"
    || (latestFrameIoState === "ready" && latestFrameIoRecordMatchesDestination && !latestFrameIoRecord?.share_url);
  const latestFrameIoHasUnfinishedJob = Boolean(latestFrameIoState && !["ready", "removed", "updating_share", "share_asset_added"].includes(latestFrameIoState)
    && !latestFrameIoBusy && !latestFrameIoShareRetryAvailable);
  const uploadPercent = latestFrameIoProgress && latestFrameIoProgress.total > 0
    ? Math.max(0, Math.min(100, Math.floor(latestFrameIoProgress.uploaded / latestFrameIoProgress.total * 100)))
    : null;
  const approvalProgressPercent = latestFrameIoState === "uploading" && uploadPercent !== null
    ? Math.floor(uploadPercent * 0.8)
    : latestFrameIoState === "finalizing_review" ? 84
      : latestFrameIoState === "creating_version_stack" ? 88
        : latestFrameIoState === "updating_share" || latestFrameIoState === "share_asset_added" ? 92
          : latestFrameIoState === "creating_share" ? 96
            : latestFrameIoState === "ready" ? 100 : 0;
  const publishingThisClient = publishingClientPath === client.path;
  const publishingProgressPercent = publishingThisClient && publishProgress?.client_path === client.path && publishProgress.total > 0
    ? Math.max(0, Math.min(100, Math.floor(publishProgress.completed / publishProgress.total * 100)))
    : null;
  const operationProgressActive = publishingThisClient || latestFrameIoBusy;
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

  const published = manuallyPublished || isFinalised(client);
  const publishFailed = exports.publish_failed || publishFailedOverride;
  const cleanExportInProgress = exports.approval_in_progress
    && exports.approval_progress_phase?.toLowerCase() === "waiting for export to stabilize";
  const exportProgressLabel = cleanExportInProgress
    ? "Clean export in progress"
    : "Approval export in progress";
  const exportLabel = manuallyPublished
    ? "FINAL"
    : client.exportStatusLoading
    ? "Loading exports…"
    : exports.approval_in_progress
      ? exportProgressLabel
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
        : "Awaiting export";
  const exportNeedsAttention = Boolean(
    exports.issue || exportLabel === "FINAL outdated" || exportLabel === "FINAL unverified"
  );
  const issues: ClientIssue[] = [];
  if (client.status === "Missing folders") issues.push({
    id: "folders", title: "Missing folders", details: client.missing,
    actionLabel: "Create missing folders", action: () => handleFixClient(client), disabled: busy,
  });
  if (exports.issue) issues.push({
    id: "exports", title: "Check exports", details: [exports.issue],
    actionLabel: "Open exports folder", action: () => handleOpenFolder(`${client.path}/03_EXPORTS`),
  });
  if (!exports.issue && !publishFailed && (exportLabel === "FINAL outdated" || exportLabel === "FINAL unverified")) issues.push({
    id: "final", title: exportLabel,
    details: [exportLabel === "FINAL outdated" ? "A newer export is available to publish." : "The final file could not be matched to the latest export."],
    actionLabel: "Review publish", disabled: Boolean(busy || publishingClientPath || !exports.latest_filename),
    action: () => { setShowIssues(false); setPendingPromotion({ ...client, export_status: { ...exports, publish_failed: publishFailed } }); },
  });
  if (publishFailed) issues.push({
    id: "publish", title: "Publish failed", details: ["The last publish did not complete."],
    actionLabel: "Retry publish", disabled: Boolean(busy || publishingClientPath || !exports.latest_filename || exports.issue),
    action: () => { setShowIssues(false); setPendingPromotion({ ...client, export_status: { ...exports, publish_failed: true } }); },
  });
  const exportDisplayVersion = exports.approval_in_progress
    ? exports.approval_progress_version ?? version
    : latestApprovalVersion?.version ?? version;
  const statusLabel = exportLabel === "FINAL" ? "Published" : exportLabel;
  const StatusIcon = exportLabel === "FINAL" ? Check
    : exportLabel === "Shared" ? Link2
      : exportLabel === "Approval ready" ? CirclePlay
        : exportLabel === "Awaiting export" ? Clapperboard : FileCheck2;
  const tooltipVersionNumbers = Array.from(new Set([
    ...sortedApprovalVersions.map((approval) => approval.version),
    ...(creatingApprovalVersion && exports.approval_progress_version !== null
      ? [exports.approval_progress_version]
      : []),
  ])).sort((left, right) => right - left);
  const versionCreatedAt = exports.versions
    .map((item) => Date.parse(item.added_at))
    .filter(Number.isFinite);
  const firstVersionAt = versionCreatedAt.length ? Math.min(...versionCreatedAt) : null;
  const finalPublishedAt = exports.final_published_at ? Date.parse(exports.final_published_at) : Number.NaN;
  const timeToFinal = firstVersionAt !== null
    && Number.isFinite(finalPublishedAt)
    && finalPublishedAt >= firstVersionAt
    ? formatAverageDuration(finalPublishedAt - firstVersionAt)
    : null;
  const publishedVersionDetails = !manuallyPublished && isFinalised(client)
    ? [timeToFinal && `Time from first version to FINAL: ${timeToFinal}`]
    : [];
  const exportTooltipDetails = manuallyPublished
    ? ["Manually marked as published in Advanced mode"]
    : client.exportStatusLoading
      ? ["Checking this client's exports…"]
      : isFinalised(client)
        ? publishedVersionDetails.filter((detail): detail is string => Boolean(detail))
      : [
        exports.issue,
        exports.approval_in_progress && (cleanExportInProgress
          ? "Clean export is being written and checked for stability"
          : `Approval copy is being rendered and validated${exports.approval_progress_phase ? ` (${exports.approval_progress_phase})` : ""}`),
        exports.final_filename && `FINAL: ${exports.final_filename}`,
      ].filter((detail): detail is string => Boolean(detail));
  const lastApprovalVersion = sortedApprovalVersions[0];
  const pendingVersion = exports.approval_progress_version;
  const playableApprovalVersions = sortedApprovalVersions.filter((approval) =>
    !exports.approval_in_progress || approval.version !== pendingVersion,
  );
  const selectedApprovalVersion = playableApprovalVersions.find(
    (item) => item.relative_path === selectedVersion,
  ) ?? playableApprovalVersions[0];
  const selectedApprovalPath = selectedApprovalVersion
    ? `${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${selectedApprovalVersion.relative_path.replace(/[\\/]+/g, "\\")}`
    : null;
  const pendingApprovalEntry = creatingApprovalVersion && exports.approval_progress_version !== null
    ? (
      <div
        className="version-entry version-pending"
        aria-label={`V${exports.approval_progress_version} ${exportProgressLabel.toLowerCase()}`}
        title={exportProgressLabel}
      >
        <div className="version-option" aria-disabled="true">
          <span className="version-option-heading">
            <span className="version-option-number version-label">V{exports.approval_progress_version}</span>
            <LoaderCircle className="approval-progress-spinner" size={15} aria-hidden="true" />
          </span>
          <span className="version-state">{cleanExportInProgress ? "Exporting" : "Rendering"}</span>
        </div>
      </div>
    )
    : null;
  return (
    <Fragment key={client.path}>
    <div
      className={`table-row client-row ${pendingDrop ? "client-drop-confirm-active" : ""} ${transferProgress ? "client-row-transfer-active" : ""} ${clientIsCached ? "cached-client-row" : ""} ${droppable ? "droppable-row" : ""} ${
        dragOver ? "drag-over media-drop-hover" : ""
      } ${published ? "published-row" : ""} ${expanded ? "expanded-row" : ""}`}
      style={{ animationDelay: `${Math.min(index * 18, 180)}ms` }}
      data-client-name={client.name}
      data-client={droppable ? client.name : undefined}
      onClick={() => { if (!dragOver && !pendingDrop) toggleClientExpanded(client.name); }}
      onContextMenu={(event) => openPepperContextMenu(event, label.name, [
        { label: "Open client folder", action: () => void handleOpenFolder(client.path) },
        { label: "Copy client name", action: () => copyFromContextMenu(client.name, "Client name") },
        ...(isHuddleClientType(client.client_type) && client.huddle_template === "VIDEO_CALL" && client.status !== "Not a client" ? [{ label: creatingStudio ? "Creating session?" : "Create session", action: () => void handleQuickCreateSession(client), disabled: creatingStudio || clientIsCached || busy, separatorBefore: true }] : []),
        { label: "Refresh project", action: () => void refreshClients(projectRoot, true, true, true) },
        ...(advancedMode && client.status !== "Not a client" ? [
          ...(published ? [{ label: "Unpublish and return to pending", action: () => void handleUnpublish(client), separatorBefore: true, disabled: Boolean(busy || publishingClientPath) }] : []),
          ...(label.type === "HUDDLE" ? [{ label: client.huddle_template === "VIDEO_CALL" ? "Interview type: Video Call" : "Set interview type: Video Call", action: () => { void invoke("set_client_huddle_template", { clientPath: client.path, huddleTemplate: "VIDEO_CALL" }).then(() => { showToast("Huddle interview type saved as Video Call.", "success"); void refreshClients(projectRoot, true, true, true); }).catch(error => showToast(`Could not save interview type: ${String(error)}`, "error", 7000)); }, separatorBefore: true, disabled: client.huddle_template === "VIDEO_CALL" }] : []),
          { label: manuallyPublished ? "Remove published override" : "Mark as published", action: () => void toggleManualPublished(client), separatorBefore: true, disabled: !manuallyPublished && isFinalised(client) },
          { label: warningsSuppressed ? "Show status warnings" : "Hide status warnings", action: () => void toggleStatusWarnings(client) },
        ] : []),
      ])}
      onDragOver={
        droppable
          ? (event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              handleSortDragOver(event);
              mediaDropTarget(event.clientX, event.clientY);
              hoverClientRef.current = client.name;
              setDragTarget(client.name);
            }
          : undefined
      }
      onDragEnter={
        droppable
          ? (event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              hoverClientRef.current = client.name;
              setDragTarget(client.name);
            }
          : undefined
      }
      onDragLeave={
        droppable
          ? (event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (event.clientX >= bounds.left && event.clientX < bounds.right
                && event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
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
      {pendingDrop && <ClientDropConfirm folder={pendingDrop.folder} clientName={label.name} preview={pendingDrop.preview} error={pendingDrop.error} disabled={busy} choices={pendingDrop.choices} onChoicesChange={choices => updateClientDropChoices(client.path, choices)} onConfirm={choices => confirmClientDrop(client.path, choices)} onCancel={() => cancelClientDrop(client.path)} />}
      {transferProgress && <ClientRowTransfer progress={transferProgress} />}
      {droppable && <ClientMediaDrop key={client.path} clientPath={client.path} kinds={dragKinds} active={dragOver} />}
      <button
        type="button"
        className="client-row-disclosure"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label.name} client workspace`}
      />
      <div>
        <div className="client-title">
          <span className="client-expand-icon" aria-hidden="true">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <ClientLabel name={client.name} type={client.client_type} typeNames={workspaceTypeNames} season={client.season}/>
        </div>
      </div>
      <div className={`client-statuses ${clientIsCached ? "" : !client.exportStatusLoading ? "client-status-enter" : ""}`}>
        {operationProgressActive || exports.approval_in_progress ? (
          <span className="client-operation-progress">
            <progress
              className="frameio-upload-progress"
              value={publishingThisClient ? publishingProgressPercent ?? 0 : latestFrameIoBusy ? approvalProgressPercent : undefined}
              max={100}
              aria-label={publishingThisClient ? "Publishing export" : latestFrameIoBusy ? "Uploading approval to Frame.io" : exportProgressLabel}
            />
          </span>
        ) : <>
        {!clientIsCached && issues.length > 0 && !warningsSuppressed && (
          <button type="button" className="client-status-warning"
            aria-label={`${issues.length} ${issues.length === 1 ? "issue" : "issues"} for ${label.name}`}
            title={`${issues.length} ${issues.length === 1 ? "issue" : "issues"}`} aria-haspopup="dialog"
            onClick={event => { event.stopPropagation(); setShowIssues(true); }}>
            <TriangleAlert size={17} aria-hidden="true" />
          </button>
        )}
        {!clientIsCached && client.status === "Not a client" && <span className="badge not-a-client">Not a client</span>}
        {!clientIsCached && client.status !== "Not a client" && (!exportNeedsAttention || exports.approval_in_progress) && (
          <>
            {client.exportStatusLoading ? (
              <span className="client-status-space" aria-hidden="true" />
            ) : (
              <span className="client-export-status">
                <ExportStatusTooltip
                  id={`export-versions-tooltip-${index}`}
                  details={[statusLabel, ...exportTooltipDetails]}
                  versions={tooltipVersionNumbers}
                  label={`${statusLabel}${exportDisplayVersion !== null && exportLabel !== "FINAL" ? `, version ${exportDisplayVersion}` : ""}`}
                  onActivate={() => {
                    if (exportLabel === "FINAL" && exports.final_filename) void handleOpenFinal(client);
                    else if (!expanded) toggleClientExpanded(client.name);
                  }}
                >
                  <span className={`client-status-icon ${exportLabel === "FINAL" ? "final-state" : exportLabel === "Shared" ? "shared-state" : exportLabel === "Awaiting export" ? "empty-state" : ""}`}>
                    <StatusIcon size={16} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  {exportDisplayVersion !== null && exportLabel !== "FINAL" && exportLabel !== "Awaiting export" && (
                    <span className="version-label export-status-version" aria-hidden="true">V{exportDisplayVersion}</span>
                  )}
                </ExportStatusTooltip>
              </span>
            )}
          </>
        )}
        </>}
      </div>
      <div className="actions" onClick={(event) => event.stopPropagation()}>
        {client.status !== "Not a client" && exports.latest_filename && !exports.issue && (!published || publishFailed || publishingClientPath === client.path) && (
          <button
            type="button"
            className="ghost promote-button"
            onClick={() => setPendingPromotion({ ...client, export_status: { ...exports, publish_failed: publishFailed } })}
            disabled={Boolean(busy || publishingClientPath || !exports.latest_filename || exports.issue)}
            title={`${publishFailed ? "Retry failed publish" : "Publish"} ${exports.latest_filename}`}
          >
            <span>Publish</span><ArrowUpRight size={13} aria-hidden="true" />
          </button>
        )}
        {exports.final_filename && !exports.issue && (
          <button
            type="button"
            className="ghost icon-button"
            onClick={() => void handleOpenFinal(client)}
            aria-label="Open FINAL folder"
            title="Open FINAL folder"
          >
            <FolderOpen size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>
  </div>
  <ClientDetails open={expanded && !client.exportStatusLoading}>{() => (
      <ClientWorkspace studioRequest={studioRequest} key={client.path} projectRoot={projectRoot} clientPath={client.path} clientType={client.client_type} huddleTemplate={client.huddle_template} advancedMode={advancedMode && client.status !== "Not a client"} onContextMenu={openPepperContextMenu} reviewDefault={sortedApprovalVersions.length>0||published} hasApprovals={sortedApprovalVersions.length>0} clipPublishStates={clipPublishStates} publishDisabled={Boolean(busy || (publishingClientPath && !Object.keys(clipPublishStates).length))} onPublishClip={clip=>handlePublishClip(client,clip)} mainPublished={Boolean(exports.final_filename)} finalPath={published&&exports.final_filename?`${client.path.replace(/[\\/]+$/, "")}\\04_FINAL\\${exports.final_filename}`:null}>
      {sortedApprovalVersions.length === 0 ? (
        pendingApprovalEntry
          ? <VersionHistory label={`${label.name} approval versions`}>{pendingApprovalEntry}</VersionHistory>
          : <div className="versions-empty">No approval copies available.</div>
      ) : selectedApprovalVersion && selectedApprovalPath && (
        <div className="version-browser">
          <article className="export-preview" aria-label={`V${selectedApprovalVersion.version} preview: ${selectedApprovalVersion.filename}`}>
            <InlineVideoPlayer
              className="approval-video-player"
              src={convertFileSrc(selectedApprovalPath)}
              onContextMenu={(event) => {
                const player = event.currentTarget.querySelector("video");
                const video = ((event.target as HTMLElement).closest("video") ?? player) as HTMLVideoElement | null;
                const currentSeconds = video?.currentTime ?? 0;
                const wholeSeconds = Math.floor(currentSeconds);
                const hours = Math.floor(wholeSeconds / 3600);
                const minutes = Math.floor((wholeSeconds % 3600) / 60);
                const seconds = wholeSeconds % 60;
                const milliseconds = Math.floor((currentSeconds - wholeSeconds) * 1000);
                const playbackTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
                openPepperContextMenu(event, `V${selectedApprovalVersion.version} video`, [
                  { label: video?.paused ? "Play" : "Pause", action: () => video?.paused ? void video.play() : video?.pause() },
                  { label: video?.muted ? "Unmute" : "Mute", action: () => { if (video) video.muted = !video.muted; } },
                  { label: `Copy timecode  ${playbackTime}`, action: () => copyFromContextMenu(playbackTime, "Timecode"), separatorBefore: true },
                  { label: "Copy file name", action: () => copyFromContextMenu(selectedApprovalVersion.filename, "File name") },
                  { label: "Copy video path", action: () => copyFromContextMenu(selectedApprovalPath, "Video path") },
                  { label: "Open containing folder", action: () => void handleOpenFileLocation(selectedApprovalPath) },
                ]);
              }}
            />
          </article>
          <VersionHistory label={`${label.name} approval versions`}>
            {pendingApprovalEntry}
            {sortedApprovalVersions.map((approvalVersion) => {
              const approvalIsBeingRendered = exports.approval_in_progress
                && approvalVersion.version === exports.approval_progress_version;
              const isLatest = approvalVersion.relative_path === lastApprovalVersion?.relative_path;
              const versionRecord = approvalVersion.frameio?.state === "ready"
                && approvalVersion.frameio?.file_id
                && approvalVersion.frameio?.destination_account_id === frameIoConfig.accountId
                && approvalVersion.frameio?.destination_project_id === frameIoConfig.projectId
                ? approvalVersion.frameio : null;
              const versionShareUrl = approvalIsBeingRendered ? null : isLatest ? latestFrameIoShareUrl : versionRecord?.share_url;
              const versionLinkDuplicatesLatest = !isLatest
                && Boolean(versionShareUrl && latestFrameIoShareUrl && versionShareUrl === latestFrameIoShareUrl);
              const hasEarlierApproval = isLatest && sortedApprovalVersions.some((version) => version.version < approvalVersion.version);
              const hasEarlierReviewLinkForDestination = hasEarlierApproval && sortedApprovalVersions.some((version) =>
                version.version < approvalVersion.version
                && version.frameio?.state === "ready"
                && Boolean(version.frameio.share_url)
                && version.frameio.destination_account_id === frameIoConfig.accountId
                && version.frameio.destination_project_id === frameIoConfig.projectId);
              const versionBusy = isLatest && latestFrameIoBusy;
              const versionError = versionRecord?.last_error
                ?? (isLatest && /fail|error/.test(latestFrameIoState ?? "") ? latestFrameIoProgress?.message : null);
              const versionFailed = !approvalIsBeingRendered && !versionBusy && !versionShareUrl
                && Boolean(versionError || /fail|error/.test(versionRecord?.state ?? ""));
              const versionStatus = approvalIsBeingRendered ? cleanExportInProgress ? "Exporting" : "Rendering"
                : versionBusy ? frameIoUploadLabel
                  : versionFailed ? "Failed"
                    : versionShareUrl && !versionLinkDuplicatesLatest ? "Shared"
                      : isLatest && latestFrameIoShareRetryAvailable ? "Link needed"
                        : isLatest && latestFrameIoHasUnfinishedJob ? "Needs attention" : null;
              const selected = !approvalIsBeingRendered
                && approvalVersion.relative_path === selectedApprovalVersion?.relative_path;
              return (
                <div
                  className={`version-entry ${selected ? "selected" : ""} ${isLatest && !approvalIsBeingRendered ? "latest-version" : ""} ${approvalIsBeingRendered ? "version-pending" : ""}`}
                  key={`${approvalVersion.version}-${approvalVersion.filename}`}
                  onContextMenu={(event) => openPepperContextMenu(event, `V${approvalVersion.version}`, approvalIsBeingRendered ? [
                    { label: "Creating approval copy", action: () => undefined, disabled: true },
                  ] : [
                    { label: "Select version", action: () => setSelectedVersionByClient((current) => ({ ...current, [client.name]: approvalVersion.relative_path })) },
                    ...(versionRecord && activeProject ? [{
                      label: "Remove from Frame.io",
                      separatorBefore: true,
                      action: () => removeFrameIoUpload(`${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${approvalVersion.relative_path.replace(/[\\/]+/g, "\\")}`, client.name, activeProject.path, approvalVersion.version),
                    }] : []),
                    { label: "Copy version name", action: () => copyFromContextMenu(`V${approvalVersion.version}`, "Version name") },
                    { label: "Copy file name", action: () => copyFromContextMenu(approvalVersion.filename, "File name") },
                    { label: "Copy file path", action: () => copyFromContextMenu(`${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${approvalVersion.relative_path.replace(/[\\/]+/g, "\\")}`, "File path") },
                    { label: "Open file location", action: () => void handleOpenFileLocation(`${client.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${approvalVersion.relative_path.replace(/[\\/]+/g, "\\")}`) },
                  ])}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Preview V${approvalVersion.version}${isLatest ? ", latest version" : ""}`}
                    aria-disabled={approvalIsBeingRendered}
                    title={approvalVersion.filename}
                    className={`version-option ${approvalIsBeingRendered ? "version-option-rendering" : ""}`}
                    disabled={approvalIsBeingRendered}
                    onClick={() => setSelectedVersionByClient((current) => ({
                      ...current,
                      [client.name]: approvalVersion.relative_path,
                    }))}
                  >
                    <span className="version-option-heading">
                      <span className="version-option-number version-label">V{approvalVersion.version}</span>
                      {approvalIsBeingRendered ? (
                        <span role="img" aria-label={exportProgressLabel} title={exportProgressLabel}>
                          <LoaderCircle className="approval-progress-spinner" size={15} aria-hidden="true" />
                        </span>
                      ) : (
                        isLatest && <span className="version-latest">Latest</span>
                      )}
                    </span>
                    {!approvalIsBeingRendered && <time dateTime={approvalVersion.added_at} title={formatUiDateTime(approvalVersion.added_at)}>
                      {new Date(approvalVersion.added_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </time>}
                    {versionStatus && <span className={`version-state ${versionFailed ? "failed" : ""}`} title={versionError ?? undefined}>{versionStatus}</span>}
                  </button>
                  {isLatest && latestApprovalPath && !approvalIsBeingRendered && (
                    <div className="frameio-inline-row">
                      {latestFrameIoShareUrl ? (
                        <button
                          type="button"
                          className="frameio-icon-button"
                          title="Open review"
                          aria-label={`Open V${approvalVersion.version} review`}
                          onClick={() => void invoke("frameio_open_external_url", { url: latestFrameIoShareUrl }).catch((err) => showToast(String(err), "error", 7000))}
                        >
                          <Link2 size={15} aria-hidden="true" />
                        </button>
                      ) : latestFrameIoHasUnfinishedJob ? null : !frameIoConfigured ? (
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
                            : latestFrameIoBusy ? frameIoUploadLabel : "Send for review"}
                          aria-label={latestApprovalIsRendering
                            ? "Approval export in progress"
                            : latestFrameIoBusy ? frameIoUploadLabel : "Send for review"}
                          disabled={client.exportStatusLoading || !activeProject || frameIoBusyPath === latestApprovalPath || latestApprovalIsRendering}
                          onClick={() => {
                            if (!activeProject) return;
                            if (hasEarlierApproval && !hasEarlierReviewLinkForDestination) {
                              setPendingFrameIoUpload({ path: latestApprovalPath, clientKey: client.name, version: approvalVersion.version, projectName: activeProject.name, projectPath: activeProject.path });
                            } else {
                              void uploadApprovalToFrameIo(latestApprovalPath, client.name, activeProject.name, activeProject.path);
                            }
                          }}
                        >
                          {frameIoBusyPath === latestApprovalPath
                            ? <LoaderCircle className="approval-progress-spinner" size={16} aria-hidden="true" />
                            : <CloudUpload size={16} aria-hidden="true" />}
                        </button>
                      )}
                      {latestFrameIoShareUrl ? (
                        <CopyReviewLinkButton url={latestFrameIoShareUrl} version={approvalVersion.version} onCopy={copyFrameIoShareLink} />
                      ) : null}
                    </div>
                  )}
                  {!isLatest && versionShareUrl && !versionLinkDuplicatesLatest && <div className="frameio-inline-row">
                    <button type="button" className="frameio-icon-button" title="Open review" aria-label={`Open V${approvalVersion.version} review`}
                      onClick={() => void invoke("frameio_open_external_url", { url: versionShareUrl }).catch((err) => showToast(String(err), "error", 7000))}>
                      <Link2 size={15} aria-hidden="true" />
                    </button>
                    <CopyReviewLinkButton url={versionShareUrl} version={approvalVersion.version} onCopy={copyFrameIoShareLink} />
                  </div>}
                  {versionFailed && versionError && <span className="version-delivery-message" title={versionError}>{versionError}</span>}
                </div>
              );
            })}
          </VersionHistory>
        </div>
      )}
      </ClientWorkspace>
  )}</ClientDetails>
  {showIssues && <ClientIssuesDialog clientName={label.name} issues={issues}
    onRefresh={() => refreshClients(projectRoot, true, true, true)} onClose={() => setShowIssues(false)} />}
  </Fragment>
              );
});

export default function App() {
  const backgroundActivities = useBackgroundActivities();
  const [screen] = useState<"home" | "sort">("sort");
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestOperationBusy, setIngestOperationBusy] = useState(false);
  const [ingestProgress,setIngestProgress]=useState<IngestProgress|null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  const workspaceRootRef = useRef(workspaceRoot);
  const [workspaceDiscovery, setWorkspaceDiscovery] = useState<WorkspaceDiscovery | null>(null);
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  const [workspaceSetupRequired, setWorkspaceSetupRequired] = useState(false);
  const [workspaceLocalMappings, setWorkspaceLocalMappings] = useState<Record<string, string>>({});
  const ingestOpenRef=useRef(ingestOpen);ingestOpenRef.current=ingestOpen;
  useEffect(() => {
    if (!projectRoot) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await invoke<IngestProgress | null>("ingest_progress", { projectRoot });
        if (active) setIngestProgress(current =>
          current?.project_root === next?.project_root && current?.phase === next?.phase
            && current?.source === next?.source && current?.completed === next?.completed
            && current?.total === next?.total ? current : next);
      } catch { /* Keep the last known state during a temporary disconnect. */ }
      finally { if (active) timer = window.setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [projectRoot]);

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
  const [pepperContextMenu, setPepperContextMenu] = useState<PepperContextMenu | null>(null);
  const [studioRequests, setStudioRequests] = useState<Record<string, number>>({});
  const [creatingStudioClients, setCreatingStudioClients] = useState<Set<string>>(() => new Set());
  const creatingStudioClientsRef = useRef(new Set<string>());
  const [expandedClients, setExpandedClients] = useState<Set<string>>(() => new Set());
  const [selectedVersionByClient, setSelectedVersionByClient] = useState<Record<string, string>>({});
  const [frameIoConfig, setFrameIoConfig] = useState({
    clientId: import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "",
    scopes: import.meta.env.VITE_FRAMEIO_SCOPES ?? "",
    accountId: import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "",
    projectId: import.meta.env.VITE_FRAMEIO_PROJECT_ID ?? "",
  });
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [frameIoStorageSnapshot, setFrameIoStorageSnapshot] = useState<FrameIoStorageSnapshot | null>(null);
  const frameIoStorage = frameIoStorageSnapshot?.accountId === frameIoConfig.accountId && frameIoStorageSnapshot?.clientId === frameIoConfig.clientId ? frameIoStorageSnapshot : null;
  const frameIoStorageRequestRef = useRef(0);
  const [frameIoStorageLoading, setFrameIoStorageLoading] = useState(false);
  const [frameIoStorageError, setFrameIoStorageError] = useState<string | null>(null);
  const [frameIoAccounts, setFrameIoAccounts] = useState<FrameIoOption[]>([]);
  const [frameIoProjects, setFrameIoProjects] = useState<FrameIoOption[]>([]);
  const [frameIoLoadingChoices, setFrameIoLoadingChoices] = useState(false);
  const [frameIoSetupError, setFrameIoSetupError] = useState<string | null>(null);
  const [frameIoAuthBusy, setFrameIoAuthBusy] = useState(false);
  const [restreamStatus, setRestreamStatus] = useState<"connected"|"disconnected">("disconnected");
  const [restreamBusy, setRestreamBusy] = useState(false);
  const [restreamError, setRestreamError] = useState("");
  const [frameIoProgress, setFrameIoProgress] = useState<Record<string, FrameIoProgress>>({});
  const [frameIoBusyPath, setFrameIoBusyPath] = useState<string | null>(null);
  const [publishProgress, setPublishProgress] = useState<PublishProgress | null>(null);
  const [pendingFrameIoUpload, setPendingFrameIoUpload] = useState<{ path: string; clientKey: string; version: number; projectName: string; projectPath: string } | null>(null);
  const [pendingFrameIoRemoval, setPendingFrameIoRemoval] = useState<{ path: string; clientKey: string; productionProjectPath: string; version: number } | null>(null);
  const pendingFrameIoVersion = pendingFrameIoUpload?.version
    ?? pendingFrameIoUpload?.path.match(/_V(\d+)(?=[_.\s-]|$)/i)?.[1];
  const frameIoUploadDialogRef = useRef<HTMLDialogElement | null>(null);
  const frameIoRemoveDialogRef = useRef<HTMLDialogElement | null>(null);
  const [clientSort, setClientSort] = useState<ClientSort>({ column: "name", direction: "asc" });
  const [activePublishingClientPath, setPublishingClientPath] = useState<string | null>(null);
  const [clipPublishQueue, setClipPublishQueue] = useState<{clientPath:string;clip:ClientClip}[]>([]);
  const queuedClipPaths = useRef(new Set<string>());
  const processingClip = useRef(false);
  const publishingClientPath = activePublishingClientPath ?? clipPublishQueue[0]?.clientPath ?? null;
  const clipPublishStates = useMemo(() => Object.fromEntries(clipPublishQueue.map((job,index) =>
    [job.clip.path, index === 0 && activePublishingClientPath === job.clientPath ? "Publishing" : "Queued"]
  )) as Record<string, "Queued" | "Publishing">, [clipPublishQueue, activePublishingClientPath]);
  const [publishFailedClientPaths, setPublishFailedClientPaths] = useState<Set<string>>(new Set());
  const [pendingPromotion, setPendingPromotion] = useState<ClientInfo | null>(null);
  const [promotionClips, setPromotionClips] = useState<PromotionClip[]>([]);
  const [promotionClipSelection, setPromotionClipSelection] = useState<Set<string>>(new Set());
  const [promotionClipPreview, setPromotionClipPreview] = useState<string | null>(null);
  const [promotionTab, setPromotionTab] = useState<'main'|'clips'>('main');
  const [promotionError, setPromotionError] = useState("");
  const promotionDialogRef = useRef<HTMLDialogElement | null>(null);
  const pepperContextMenuRef = useRef<HTMLDivElement | null>(null);
  const openPepperContextMenu = (event: MouseEvent, title: string, items: PepperMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 230;
    const menuHeight = items.length * 34 + 42;
    setPepperContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      title,
      items,
    });
  };
  const copyFromContextMenu = (value: string, description: string) => {
    void writeText(value).then(() => showToast(`${description} copied to clipboard.`, "success"))
      .catch((error) => showToast(`Could not copy ${description.toLowerCase()}: ${String(error)}`, "error", 6000));
  };
  useEffect(() => {
    if (!pepperContextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!pepperContextMenuRef.current?.contains(event.target as Node)) setPepperContextMenu(null);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPepperContextMenu(null);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnKeyDown);
      return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnKeyDown);
    };
  }, [pepperContextMenu]);
  useEffect(() => {
    if (pendingPromotion && !promotionDialogRef.current?.open) {
      promotionDialogRef.current?.showModal();
    }
  }, [pendingPromotion]);
  useEffect(() => {
    if (!pendingPromotion) { setPromotionClips([]); setPromotionClipSelection(new Set()); setPromotionClipPreview(null); setPromotionTab('main'); setPromotionError(""); return; }
    let active=true;
    void invoke<PromotionClip[]>("list_client_clips",{clientPath:pendingPromotion.path}).then((clips)=>{
      if(!active)return; setPromotionClips(clips); setPromotionClipSelection(new Set(clips.map(clip=>clip.name))); setPromotionClipPreview(null);
    }).catch(()=>{if(active){setPromotionClips([]);setPromotionClipSelection(new Set());setPromotionClipPreview(null);setPromotionTab('main');}});
    return()=>{active=false;};
  },[pendingPromotion?.path]);
  useEffect(() => {
    if (pendingFrameIoUpload && !frameIoUploadDialogRef.current?.open) {
      frameIoUploadDialogRef.current?.showModal();
    }
  }, [pendingFrameIoUpload]);
  useEffect(() => {
    if (pendingFrameIoRemoval && !frameIoRemoveDialogRef.current?.open) {
      frameIoRemoveDialogRef.current?.showModal();
    }
  }, [pendingFrameIoRemoval]);
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
  const [sortingClientPath, setSortingClientPath] = useState<string | null>(null);
  const [pendingClientDrops, setPendingClientDrops] = useState<Record<string, PendingClientDrop>>({});
  const pendingClientDropsRef = useRef<Record<string, PendingClientDrop>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>("");
  const [lastBatch, setLastBatch] = useState<UndoEntry[]>([]);
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(import.meta.env.DEV);
  const [advancedModeRequested, setAdvancedModeRequested] = useState(false);
  const [advancedPassword, setAdvancedPassword] = useState("");
  const [advancedPasswordError, setAdvancedPasswordError] = useState("");
  const [manualPublishedPaths, setManualPublishedPaths] = useState<Record<string, boolean>>({});
  const [suppressedStatusPaths, setSuppressedStatusPaths] = useState<Record<string, boolean>>({});
  const [newClientName, setNewClientName] = useState("");
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClientType, setNewClientType] = useState<string>("exhibitor");
  const [creatingClient, setCreatingClient] = useState(false);
  const closeOperationActiveRef = useRef(false);
  const updateInProgressRef = useRef(false);
  closeOperationActiveRef.current = Boolean(busy || publishingClientPath || frameIoBusyPath || creatingClient || ingestOperationBusy || backgroundActivities.length > 0);
  useEffect(() => {
    let active = true;
    const handler = createCloseRequestHandler({
      shouldWarn: () => closeOperationActiveRef.current || updateInProgressRef.current,
      confirmClose: async () => {
        const shouldClose = await confirm("An operation is still running. Closing Pepper may interrupt it. Close Pepper anyway?", { title: "Pepper is busy", kind: "warning" });
        return active && shouldClose;
      },
      onError: error => showToast(`Could not confirm closing Pepper: ${String(error)}`, "error"),
    });
    const unlistenPromise = getCurrentWindow().onCloseRequested(handler);
    void unlistenPromise.catch(error => console.error("Could not register Pepper close handler", error));
    return () => { active = false; void unlistenPromise.then(unlisten => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const pending = listen<PublishProgress>("publish-progress", (event) => setPublishProgress(event.payload));
    return () => { pending.then((unlisten) => unlisten()).catch(() => undefined); };
  }, []);
  const [huddleTemplate, setHuddleTemplate] = useState<HuddleTemplate>("VIDEO_CALL");
  const projectRootRef = useRef(projectRoot);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  useClientScrollPosition(tableScrollRef, expandedClients.values().next().value as string | undefined);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragKinds, setDragKinds] = useState<string[] | null>(null);
  const dragSessionRef = useRef(0);
  const nativeDragEventRef = useRef(0);
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
  const [settingsUpdateStatus, setSettingsUpdateStatus] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState<PepperUpdate | null>(null);

  const dismissUpdate = () => {
    if (updateInProgressRef.current) return;
    void pendingUpdate?.close().catch(err => console.warn("Could not release update", err));
    setPendingUpdate(null);
  };

  const checkForUpdates = async (showResult = true) => {
    if (checkingForUpdates || pendingUpdate || updateInProgressRef.current) return;
    setCheckingForUpdates(true);
    if (showResult) setSettingsUpdateStatus("");
    try {
      const update = import.meta.env.DEV
        ? (await import("./components/devUpdate")).createDevUpdate()
        : await check();
      if (!update) {
        if (showResult) {
          setSettingsUpdateStatus("Pepper is up to date.");
          showToast("Pepper is up to date.", "info");
        }
        return;
      }

      setShowAdvancedMenu(false);
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
        setSettingsUpdateStatus(noReleasePublished ? "No Pepper release has been published yet." : "Could not check for updates. Try again.");
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
      void invoke<ProjectShowCatalog>("get_project_show_catalog")
        .then((catalog) => {
          const sortedCatalog = { ...catalog, shows: alphabetizeProjectShows(catalog.shows) };
          setProjectShowCatalog(sortedCatalog);
          setSelectedProjectShow((current) => current || sortedCatalog.shows[0]?.name || "");
        })
        .catch((err) => setProjectCreateError(`Could not load the local show list: ${String(err)}`));
      await CONFIG_STORE.init();
      const savedRoot = await CONFIG_STORE.get<string>("projectRoot");
      const savedWorkspaceRoot = await CONFIG_STORE.get<string>("workspaceRoot");
      const savedShowNonClients = await CONFIG_STORE.get<boolean>("showNonClients");
      const savedMode = await CONFIG_STORE.get<string>("lastMode");
      const savedAlwaysOnTop = await CONFIG_STORE.get<boolean>("alwaysOnTop");
      const savedFrameIo = await CONFIG_STORE.get<typeof frameIoConfig>("frameIoConfig");
      const savedManualPublished = await CONFIG_STORE.get<Record<string, boolean>>("manualPublishedClients");
      if (savedManualPublished && typeof savedManualPublished === "object") setManualPublishedPaths(savedManualPublished);
      const savedSuppressedStatus = await CONFIG_STORE.get<Record<string, boolean>>("suppressedClientStatusWarnings");
      if (savedSuppressedStatus && typeof savedSuppressedStatus === "object") setSuppressedStatusPaths(savedSuppressedStatus);
      if (savedFrameIo) setFrameIoConfig({
        clientId: savedFrameIo.clientId ?? import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "",
        scopes: savedFrameIo.scopes ?? import.meta.env.VITE_FRAMEIO_SCOPES ?? "",
        accountId: savedFrameIo.accountId ?? import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "",
        projectId: savedFrameIo.projectId ?? import.meta.env.VITE_FRAMEIO_PROJECT_ID ?? "",
      });
      const savedFrameIoClientId = savedFrameIo?.clientId ?? import.meta.env.VITE_FRAMEIO_CLIENT_ID ?? "";
      const savedFrameIoAccountId = savedFrameIo?.accountId ?? import.meta.env.VITE_FRAMEIO_ACCOUNT_ID ?? "";
      const savedStorage = await CONFIG_STORE.get<FrameIoStorageSnapshot>("frameIoStorageSnapshot").catch(() => null);
      if (savedStorage?.accountId === savedFrameIoAccountId && savedStorage?.clientId === savedFrameIoClientId
        && Number.isFinite(savedStorage.usedBytes) && savedStorage.usedBytes >= 0
        && Number.isFinite(savedStorage.limitBytes) && savedStorage.limitBytes >= 0) {
        setFrameIoStorageSnapshot(savedStorage);
      }
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
      const defaultWorkspaceRoot = await invoke<string>("default_workspace_root").catch(() => "");
      const legacyParent = typeof savedRoot === "string" ? savedRoot.replace(/[\\/][^\\/]+$/, "") : "";
      const workspaceRootValue = typeof savedWorkspaceRoot === "string" && savedWorkspaceRoot
        ? savedWorkspaceRoot
        : legacyParent || defaultWorkspaceRoot;
      setWorkspaceRoot(workspaceRootValue);
      workspaceRootRef.current = workspaceRootValue;
      if (workspaceRootValue && workspaceRootValue !== savedWorkspaceRoot) {
        await CONFIG_STORE.set("workspaceRoot", workspaceRootValue);
        await CONFIG_STORE.save();
      }
      const projectRootsPromise = invoke<ProjectRootOption[]>("list_project_roots", { workspaceRoot: workspaceRootValue })
        .then((roots) => { setProjectRoots(roots); return roots; })
        .catch((err) => {
          console.error("Unable to load project folders", err);
          setError(`Unable to load project folders: ${String(err)}`);
          return null;
        });
      const workspaceStatePromise = invoke<WorkspaceDiscovery>("workspace_discover", { root: workspaceRootValue })
        .catch((err) => ({ status: "unavailable", root: workspaceRootValue, config: null, writable: false, message: String(err), lock: null } as WorkspaceDiscovery));
      const [discovery, cachedWorkspace] = await Promise.all([
        workspaceStatePromise,
        CONFIG_STORE.get<WorkspaceConfig>(`workspaceCache:${workspaceRootValue.toLowerCase()}`).catch(() => null),
      ]);
      setWorkspaceDiscovery(discovery);
      if (discovery.status === "valid" && discovery.config) {
        setWorkspaceConfig(discovery.config);
        setProjectShowCatalog({ path: "Shared workspace", shows: discovery.config.projectShowNames.map((name) => ({ name })) });
        setWorkspaceSetupRequired(false);
        await CONFIG_STORE.set(`workspaceCache:${workspaceRootValue.toLowerCase()}`, discovery.config);
        const mappings = await CONFIG_STORE.get<Record<string, string>>(`workspaceResourceMappings:${discovery.config.workspaceId}`).catch(() => ({}));
        setWorkspaceLocalMappings(mappings ?? {});
      } else if (discovery.status === "absent") {
        setWorkspaceConfig(null);
        setWorkspaceSetupRequired(true);
        setShowAdvancedMenu(true);
        setSettingsSection("workspace");
      } else {
        setWorkspaceConfig(cachedWorkspace ?? null);
        setWorkspaceSetupRequired(false);
        if (cachedWorkspace) {
          const mappings = await CONFIG_STORE.get<Record<string, string>>(`workspaceResourceMappings:${cachedWorkspace.workspaceId}`).catch(() => ({}));
          setWorkspaceLocalMappings(mappings ?? {});
        }
        setError(discovery.message ?? "Workspace settings are unavailable.");
      }
      const roots = await projectRootsPromise;
      const savedRootValue = typeof savedRoot === "string" ? savedRoot : "";
      const savedRootPath = savedRootValue.replace(/[\\/]+$/, "").toLowerCase();
      const savedRootParts = savedRootValue.split(/[\\/]/).filter(Boolean);
      const savedProjectName = savedRootParts[savedRootParts.length - 1]?.toLowerCase();
      const matchingRoot = roots?.find((project) => project.path.replace(/[\\/]+$/, "").toLowerCase() === savedRootPath)
        ?? roots?.find((project) => project.name.toLowerCase() === savedProjectName);
      // Preserve a saved selection if it is absent from enumeration. It may be
      // temporarily unavailable or renamed, and choosing another project
      // silently could expose the wrong project as the active workspace.
      const startupRoot = roots === null
        ? savedRootValue
        : matchingRoot?.path ?? (savedRootValue.startsWith(workspaceRootValue) ? savedRootValue : roots[0]?.path || "");
      if (roots !== null && savedRootValue && !matchingRoot) {
        setError("The saved project folder is unavailable. Pepper kept the saved selection; reconnect it or choose another project.");
      }
      if (roots !== null && startupRoot !== savedRoot) {
        await saveConfigValue("projectRoot", startupRoot);
      }

      if (startupRoot) {
        setProjectRoot(startupRoot);
        projectRootRef.current = startupRoot;
        setLoading(true);
        setScanProgress({ phase: "clients", completed: 0, total: 0 });
        scanProgressVisibleRef.current = true;
        await loadClientCache(startupRoot);
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

      if (startupRoot) {
        await unlistenClientScanPromise;
        if (!migratedRoots.includes(startupRoot)) {
          try {
            const count = await invoke<number>("migrate_project_finals", { projectRoot: startupRoot });
            await CONFIG_STORE.set("legacyFinalMigrationRoots", [...migratedRoots, startupRoot]);
            if (count > 0) console.info(`Marked ${count} existing FINAL files as published.`);
          } catch (error) {
            console.error("Could not migrate existing FINAL status", error);
          }
        }
        await refreshClients(startupRoot);
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
        setClients((current) => {
          let changed = false;
          const next = current.map((client) => {
          const update = scan.export_updates.find((item) => item.name === client.name);
          if (!update) return client;
          const keepProgress = approvalProgressActiveRef.current.has(client.name);
          const exportStatus = keepProgress
            ? {
              ...update.export_status,
              approval_in_progress: true,
              approval_progress_phase: update.export_status.approval_progress_phase
                ?? client.export_status.approval_progress_phase
                ?? "Waiting for export to stabilize",
              approval_progress_version: update.export_status.approval_progress_version
                ?? client.export_status.approval_progress_version,
            }
            : update.export_status;
          const unchanged = JSON.stringify(client.export_status) === JSON.stringify(exportStatus);
          if (unchanged && !client.exportStatusLoading) return client;
          changed = true;
          return { ...client, export_status: exportStatus, exportStatusLoading: false };
          });
          return changed ? next : current;
        });
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
    const request = ++frameIoStorageRequestRef.current;
    if (!accountId || !frameIoConfig.clientId) {
      setFrameIoStorageError(null);
      setFrameIoStorageLoading(false);
      return;
    }
    setFrameIoStorageLoading(true);
    setFrameIoStorageError(null);
    try {
      const storage = await invoke<FrameIoStorage>("frameio_get_storage", { clientId: frameIoConfig.clientId, accountId });
      if (request !== frameIoStorageRequestRef.current) return;
      const snapshot = { ...storage, accountId, clientId: frameIoConfig.clientId };
      setFrameIoStorageSnapshot(snapshot);
      // Cache failures must not discard a successful refresh.
      void CONFIG_STORE.set("frameIoStorageSnapshot", snapshot).then(() => CONFIG_STORE.save()).catch(() => undefined);
    } catch (err) {
      if (request === frameIoStorageRequestRef.current) setFrameIoStorageError(String(err));
    } finally {
      if (request === frameIoStorageRequestRef.current) setFrameIoStorageLoading(false);
    }
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
    setSettingsSection("integrations");
    setShowAdvancedMenu(true);
    void invoke<"connected"|"disconnected">("restream_connection_status").then(setRestreamStatus).catch(()=>{});
    if (frameIoConfig.clientId) void loadFrameIoChoices().catch(() => undefined);
  };
  useEffect(() => {
    const open = () => openFrameIoSettings();
    window.addEventListener('pepper-open-restream-settings', open);
    return () => window.removeEventListener('pepper-open-restream-settings', open);
  }, [frameIoConfig.clientId]);

  const connectRestream = async () => {
    setRestreamBusy(true); setRestreamError("");
    try {
      const url = await invoke<string>("restream_start_auth");
      await openUrl(url);
      await invoke("restream_finish_auth");
      setRestreamStatus("connected");
      showToast("Restream connected on this computer.", "success");
    } catch (error) { await invoke("restream_cancel_auth").catch(()=>undefined); setRestreamError(String(error)); }
    finally { setRestreamBusy(false); }
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
        showToast(`Video uploaded; the review link still needs verification. Use Send for review again to retry without uploading the video again. ${detail}`, "error", null);
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
      return true;
    } catch (err) {
      showToast(`Could not copy Frame.io share link: ${String(err)}`, "error", 7000);
      return false;
    }
  };

  const removeFrameIoUpload = (path: string, clientKey: string, productionProjectPath: string, version: number) => {
    if (frameIoBusyPath === path) return;
    setPendingFrameIoRemoval({ path, clientKey, productionProjectPath, version });
  };

  const confirmRemoveFrameIoUpload = async () => {
    const removal = pendingFrameIoRemoval;
    if (!removal || frameIoBusyPath === removal.path) return;
    setPendingFrameIoRemoval(null);
    const { path, clientKey, productionProjectPath } = removal;
    setFrameIoBusyPath(path);
    try {
      await invoke("frameio_remove_upload", {
        approvalPath: path,
        clientId: frameIoConfig.clientId,
        accountId: frameIoConfig.accountId,
        projectId: frameIoConfig.projectId,
        productionProjectPath,
      });
      setFrameIoProgress((current) => ({ ...current, [path]: { approval_path: path, state: "removed", uploaded: 0, total: 0, message: null, share_url: null } }));
      showToast("Uploaded version removed from Frame.io. The local approval copy is unchanged.", "success");
    } catch (error) {
      showToast(String(error), "error", 8000);
    } finally {
      setFrameIoBusyPath(null);
      if (projectRootRef.current === productionProjectPath) {
        void refreshClients(productionProjectPath, false, false, false, [clientKey]).catch(console.error);
      }
    }
  };

  function recordNotification(message: string, tone: "info" | "success" | "error" = "info", _duration?: number | null) {
    setNotificationHistory(current => [{ id: crypto.randomUUID(), message, tone, createdAt: Date.now(), unread: true }, ...current].slice(0, 100));
  }

  function showToast(
    message: string,
    tone: "info" | "success" | "error" = "info",
    duration: number | null = 3000
  ) {
    setToast({ message, tone });
    recordNotification(message, tone);
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

  const activeNotifications: NotificationActivity[] = [...backgroundActivities];
  const clientContext = (path: string) => parseClientLabel(path.split(/[\\/]/).filter(Boolean).pop() || path).name;
  const fileContext = (path: string) => path.split(/[\\/]/).pop() || path;
  if (sortingClientPath) activeNotifications.unshift({
    id: `copy:${sortingClientPath}`, kind: 'copy', title: 'Copying files', context: clientContext(sortingClientPath),
    detail: progress?.current ? `${progress.processed} / ${progress.total} files \u00b7 ${fileContext(progress.current)}` : 'Preparing files\u2026',
    percent: activityPercent(progress?.bytes_done, progress?.bytes_total),
  });
  if (publishingClientPath) {
    const current = publishProgress?.client_path === publishingClientPath ? publishProgress : null;
    activeNotifications.push({ id:`publish:${publishingClientPath}`,kind:'publish',title:'Publishing final',context:clientContext(publishingClientPath),
      detail:current?.stage === 'clips' ? 'Copying and verifying clips' : 'Copying and verifying video',percent:activityPercent(current?.completed,current?.total) });
  }
  const reviewStates: Record<string,string> = {preparing:'Preparing upload',uploading:'Uploading approval',processing:'Processing on Frame.io',creating_version_stack:'Adding version',updating_share:'Updating review link',creating_share:'Creating review link',finalizing_review:'Preparing review link'};
  const reviewPaths = new Set(Object.entries(frameIoProgress).filter(([,value])=>Boolean(reviewStates[value.state])).map(([path])=>path));
  if (frameIoBusyPath) reviewPaths.add(frameIoBusyPath);
  reviewPaths.forEach(path => {
    const current=frameIoProgress[path];
    const client=clients.find(client=>path.replace(/\\/g,'/').toLowerCase().startsWith(`${client.path.replace(/\\/g,'/').toLowerCase()}/`));
    activeNotifications.push({id:`review:${path}`,kind:'review',title:reviewStates[current?.state] || 'Updating Frame.io',context:client ? clientContext(client.path) : 'Frame.io',detail:fileContext(path),percent:current?.state==='uploading'?activityPercent(current.uploaded,current.total):null});
  });
  const importing = ['collecting','inventorying','filing'].includes(ingestProgress?.phase || '');
  if (importing || ingestOperationBusy) activeNotifications.push({id:'import',kind:'import',title:ingestProgress?.phase==='inventorying'?'Finding media':ingestProgress?.phase==='filing'?'Organising media':'Importing media',context:ingestProgress?.project_root ? fileContext(ingestProgress.project_root) : '',detail:ingestProgress?.source ? fileContext(ingestProgress.source) : 'Preparing media\u2026',percent:importing?activityPercent(ingestProgress?.completed,ingestProgress?.total):null});
  if (busy && !sortingClientPath) activeNotifications.push({id:'undo',kind:'other',title:'Undoing transfer',context:'',detail:'Restoring the previous file operation',percent:null});
  if (creatingClient) activeNotifications.push({id:'create-client',kind:'other',title:'Creating client',context:newClientName,detail:'Preparing client folders',percent:null});

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);
  useEffect(() => { workspaceRootRef.current = workspaceRoot; }, [workspaceRoot]);

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
    if (!showProjectMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowProjectMenu(false);
        setProjectSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [showProjectMenu]);

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
  const frameIoIssues = [...new Set([frameIoSetupError, frameIoStorageError].filter((issue): issue is string => Boolean(issue)))];
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

  const normalizeProjectPath = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
  const normalizedWorkspacePath = normalizeProjectPath(workspaceRoot);
  const normalizedProjectPath = normalizeProjectPath(projectRoot);
  const projectPathPrefix = normalizedWorkspacePath ? `${normalizedWorkspacePath}\\` : "";
  const currentProjectRelativePath = projectPathPrefix && normalizedProjectPath.startsWith(projectPathPrefix)
    ? normalizedProjectPath.slice(projectPathPrefix.length).replace(/\\/g, "/")
    : normalizedProjectPath.split("\\").pop() ?? "";
  const currentProjectFolderName = normalizedProjectPath.split("\\").pop() ?? "";
  const currentWorkspaceProject = workspaceConfig?.projects.find((item) => item.relativePath.replace(/[\\/]+/g, "/").toLowerCase() === currentProjectRelativePath)
    ?? workspaceConfig?.projects.find((item) => item.name.toLowerCase() === currentProjectFolderName);
  const projectProfile = workspaceConfig?.profiles.find((profile) => currentWorkspaceProject && profile.projectIds.some((id) => id.toLowerCase() === currentWorkspaceProject.id.toLowerCase()));
  const profileClientTypes = projectProfile?.allowedClientTypeIds.map((id) => workspaceConfig?.clientTypes.find((type) => type.id.toLowerCase() === id.toLowerCase())).filter((type): type is NonNullable<typeof type> => Boolean(type)) ?? [];
  const projectClientTypes = projectProfile ? profileClientTypes : [];
  const defaultProjectClientType = projectClientTypes.find((type) => type.id.toLowerCase() === projectProfile?.defaultClientTypeId.toLowerCase())?.id ?? "";
  const selectedWorkspaceClientType = projectClientTypes.find((type) => type.id.toLowerCase() === newClientType.toLowerCase());
  const workspaceTypeNames = useMemo(() => Object.fromEntries((workspaceConfig?.clientTypes ?? []).map((type) => [type.id.toLowerCase(), type.name])), [workspaceConfig?.clientTypes]);
  const clientSections = useMemo(() => {
    const sections: { season: string | null; start: number; clients: ClientInfo[] }[] = [];
    visibleClients.forEach((client, index) => {
      const season = client.season ?? null;
      const last = sections[sections.length - 1];
      if (last && last.season === season) last.clients.push(client);
      else sections.push({ season, start: index, clients: [client] });
    });
    return sections;
  }, [visibleClients]);
  useEffect(() => {
    setShowNewClientForm(false);
    setNewClientName("");
    setNewClientType(defaultProjectClientType);
    setHuddleTemplate("VIDEO_CALL");
  }, [projectRoot, defaultProjectClientType]);
  const needsProjectSeason = Boolean(selectedWorkspaceClientType?.features.includes("seasons"));
  const projectSeasons = useProjectSeasons(projectRoot, showNewClientForm && needsProjectSeason);

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
    return <ArrowUpDown size={14} strokeWidth={1.8} aria-hidden="true" data-direction={clientSort.column === column ? clientSort.direction : undefined} />;
  };

  const sortableClients = useMemo(
    () => clients.filter((client) => client.status !== "Not a client"),
    [clients]
  );

  useEffect(() => {
    sortableClientsRef.current = sortableClients;
  }, [sortableClients]);

  const sortDropRef = useRef(queueClientDrop);
  useLayoutEffect(() => { sortDropRef.current = queueClientDrop; });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const attach = async () => {
      const appWindow = getCurrentWindow();
      const unlistenFn = await appWindow.onDragDropEvent(async (event) => {
        if(isNativeFileDragActive())return;
        const payload = event.payload as DragDropEvent;
        if(ingestOpenRef.current){
          if(payload.type==="drop"&&payload.paths.length)window.dispatchEvent(new CustomEvent("pepper-ingest-drop",{detail:payload.paths}));
          return;
        }
        if (screen !== "sort") return;
        const dragEvent = ++nativeDragEventRef.current;
        if (payload.type === "leave") {
          dragSessionRef.current++;
          setDragKinds(null);
          setDragTarget(null);
          hoverClientRef.current = null;
          setDragActive(false);
          return;
        }

        if (payload.type === "enter") {
          const session = ++dragSessionRef.current;
          setDragKinds(null);
          void invoke<string[]>("media_drop_kinds", { paths: payload.paths }).then(kinds => {
            if (session === dragSessionRef.current) setDragKinds(kinds);
          }).catch(error => {
            if (session === dragSessionRef.current) {
              setDragKinds([]);
              showToast(`Could not inspect dropped files: ${String(error)}`, "error");
            }
          });
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

        const scale = await appWindow.scaleFactor();
        if (dragEvent !== nativeDragEventRef.current) return;
        const point = { x: payload.position.x / scale, y: payload.position.y / scale };
        const target = mediaDropTarget(point.x, point.y);
        hoverClientRef.current = target.client ?? null;
        setDragTarget(target.client ?? null);
        if (payload.type === "drop") {
          dragSessionRef.current++;
          setDragTarget(null);
          hoverClientRef.current = null;
          setDragActive(false);
          if (!target.client || (!target.folder && !target.mixed)) {
            showToast("Drop files on a media folder.", "info");
            return;
          }
          const client = sortableClientsRef.current.find(entry => entry.name === target.client);
          if (client && payload.paths.length) {
            void sortDropRef.current(client, payload.paths, undefined, target.folder);
          }
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
        if (cancelled) return;
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
        const drop = mediaDropTarget(local.x, local.y);
        hoverClientRef.current = drop.client ?? null;
        setDragTarget(drop.client ?? null);
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
    window.dispatchEvent(new Event('pepper-refresh-notes'));
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
      if (cancelled || approvalProgressPollInFlightRef.current) return;
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
        setClients((current) => {
          let changed = false;
          const next = current.map((client) => {
          const progress = byClient.get(client.name);
          const completing = approvalProgressCompletionPendingRef.current.has(client.name);
          const inProgress = Boolean(progress) || completing;
          const phase = progress?.phase ?? (completing
            ? "Finishing approval copy"
            : inProgress ? "Preparing approval copy" : null);
          const pendingVersion = progress?.pending_version
            ?? (completing ? client.export_status.approval_progress_version : null);
          if (client.export_status.approval_in_progress === inProgress
            && client.export_status.approval_progress_phase === phase
            && client.export_status.approval_progress_version === pendingVersion) return client;
          changed = true;
          return {
            ...client,
            export_status: {
              ...client.export_status,
              approval_in_progress: inProgress,
              approval_progress_phase: phase,
              approval_progress_version: pendingVersion,
            },
          };
          });
          return changed ? next : current;
        });
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
        workspaceRoot,
        showName,
        year: projectYear,
      });
      if (workspaceConfig) {
        try {
          const updatedConfig = await invoke<WorkspaceConfig>("workspace_register_project", { workspaceRoot, projectPath: created.path, name: created.name });
          await handleWorkspaceSaved(workspaceRoot, updatedConfig);
        } catch (registrationError) {
          setError(`Project folder created, but it could not be added to shared workspace settings: ${String(registrationError)}`);
        }
      }
      const roots = await invoke<ProjectRootOption[]>("list_project_roots", { workspaceRoot });
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

  const handleWorkspaceSaved = async (root: string, config: WorkspaceConfig) => {
    if (root.replace(/[\\/]+$/, "").toLowerCase() !== workspaceRootRef.current.replace(/[\\/]+$/, "").toLowerCase()) return;
    const firstSetup = workspaceSetupRequired;
    setWorkspaceConfig(config);
    setProjectShowCatalog({ path: "Shared workspace", shows: config.projectShowNames.map((name) => ({ name })) });
    setWorkspaceSetupRequired(false);
    setWorkspaceDiscovery({ status: "valid", root, config, writable: workspaceDiscovery?.writable ?? true, message: null, lock: null });
    await CONFIG_STORE.set(`workspaceCache:${root.toLowerCase()}`, config);
    await CONFIG_STORE.set(`workspaceResourceMappings:${config.workspaceId}`, workspaceLocalMappings);
    await CONFIG_STORE.save();
    if (firstSetup) setShowAdvancedMenu(false);
  };

  const handleWorkspaceRootSelected = async (nextRoot: string) => {
    const root = nextRoot.trim().replace(/[\\/]+$/, "");
    if (!root || root.replace(/[\\/]+$/, "").toLowerCase() === workspaceRootRef.current.replace(/[\\/]+$/, "").toLowerCase()) return;
    setWorkspaceRoot(root);
    workspaceRootRef.current = root;
    setWorkspaceDiscovery(null);
    setWorkspaceConfig(null);
    setWorkspaceLocalMappings({});
    await CONFIG_STORE.set("workspaceRoot", root);
    await CONFIG_STORE.save();
    const [discovery, roots] = await Promise.all([
      invoke<WorkspaceDiscovery>("workspace_discover", { root }).catch((cause) => ({ status: "unavailable", root, config: null, writable: false, message: String(cause), lock: null } as WorkspaceDiscovery)),
      invoke<ProjectRootOption[]>("list_project_roots", { workspaceRoot: root }).catch((cause) => { setError(`Unable to load projects from this workspace: ${String(cause)}`); return null; }),
    ]);
    setWorkspaceDiscovery(discovery);
    if (discovery.status === "valid" && discovery.config) {
      setWorkspaceConfig(discovery.config);
      setProjectShowCatalog({ path: "Shared workspace", shows: discovery.config.projectShowNames.map((name) => ({ name })) });
      setWorkspaceSetupRequired(false);
      const mappings = await CONFIG_STORE.get<Record<string, string>>(`workspaceResourceMappings:${discovery.config.workspaceId}`).catch(() => ({}));
      setWorkspaceLocalMappings(mappings ?? {});
      await CONFIG_STORE.set(`workspaceCache:${root.toLowerCase()}`, discovery.config);
    } else if (discovery.status === "absent") {
      setWorkspaceSetupRequired(true);
      setSettingsSection("workspace");
      setShowAdvancedMenu(true);
    } else {
      const cached = await CONFIG_STORE.get<WorkspaceConfig>(`workspaceCache:${root.toLowerCase()}`).catch(() => null);
      setWorkspaceConfig(cached ?? null);
      setWorkspaceSetupRequired(false);
      setError(discovery.message ?? "Workspace settings could not be loaded.");
    }
    if (roots) {
      setProjectRoots(roots);
      const currentParts = projectRootRef.current.split(/[\\/]/).filter(Boolean);
      const currentName = currentParts[currentParts.length - 1]?.toLowerCase();
      const nextProject = roots.find((item) => item.name.toLowerCase() === currentName)?.path ?? roots[0]?.path ?? "";
      await changeProjectRoot(nextProject);
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

  const handleQuickCreateSession = async (client: ClientInfo) => {
    if (creatingStudioClientsRef.current.has(client.path)) return;
    creatingStudioClientsRef.current.add(client.path);
    setCreatingStudioClients(new Set(creatingStudioClientsRef.current));
    let created: StudioSession;
    try {
      // Check the client folder before creating a remote session.
      await invoke('restream_client_sessions', { clientPath: client.path });
      created = await createStudioSession(parseClientLabel(client.name).name);
    } catch (error) {
      showToast(`Could not confirm session creation. Check Studio before retrying. ${String(error)}`, "error", 9000);
      creatingStudioClientsRef.current.delete(client.path);
      setCreatingStudioClients(new Set(creatingStudioClientsRef.current));
      return;
    }
    try {
      let saveError = '';
      try { await invoke('restream_associate_session', { clientPath: client.path, session: created }); }
      catch (error) { saveError = String(error); }
      setStudioRequests(current => ({ ...current, [client.path]: (current[client.path] ?? 0) + 1 }));
      if (projectRootRef.current === projectRoot) setExpandedClients(new Set([client.name]));
      let clipboardError = '';
      try { await writeText(created.url); }
      catch (error) { clipboardError = String(error); }
      if (saveError || clipboardError) {
        showToast(`Session created.${saveError ? ` Could not save it to the client folder: ${saveError}. Link it from Studio instead of creating another.` : ''}${clipboardError ? ` Could not copy the link: ${clipboardError}.` : ' Link copied to clipboard.'} ${created.url}`, "error", 15000);
      } else {
        showToast('Session created. Link copied to clipboard.', "success");
      }
    } finally {
      creatingStudioClientsRef.current.delete(client.path);
      setCreatingStudioClients(new Set(creatingStudioClientsRef.current));
    }
  };

  const handleAddClient = async () => {
    if (creatingClient) return;
    if (!projectRoot) {
      setError("Choose a Project Root first.");
      return;
    }
    const baseName = newClientName.trim();
    if (!workspaceConfig || workspaceDiscovery?.status !== "valid") {
      setError("A validated shared workspace configuration is required before creating clients.");
      return;
    }
    if (!currentWorkspaceProject) {
      setError(`Project folder "${projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot}" is missing from the shared workspace project catalog.`);
      return;
    }
    if (!projectProfile) {
      setError(`No workspace profile is assigned to "${currentWorkspaceProject.name}". Assign it in Workspace settings > Project profiles.`);
      return;
    }
    if (!projectClientTypes.length) {
      setError(`Workspace profile "${projectProfile.name}" has no valid client types assigned.`);
      return;
    }
    if (!baseName || (needsProjectSeason && (projectSeasons.loading || projectSeasons.creating || !projectSeasons.season))) return;
    const normalized = `${normalizeClientInput(baseName)}_${newClientType.toUpperCase()}`;
    if (!normalized) return;

    setCreatingClient(true);
    setError(null);
    try {
      await invoke("create_client", {
        projectRoot,
        clientName: normalized,
        clientType: newClientType,
        season: needsProjectSeason ? projectSeasons.season : null,
        huddleTemplate: (selectedWorkspaceClientType?.featureOptions.premiere_project?.length ?? 0) > 1 ? huddleTemplate : null,
        resourceMappings: workspaceLocalMappings,
      });
      setNewClientName("");
      setNewClientType(defaultProjectClientType);
      setHuddleTemplate("VIDEO_CALL");
      setShowNewClientForm(false);
        await refreshClients(undefined, false);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreatingClient(false);
    }
  };

  const handleFixClient = async (client: ClientInfo) => {
    await invoke("fix_client", {
      projectRoot,
      clientName: client.name,
    });
    await refreshClients(projectRoot, true, true, true);
  };

  const handlePublishClip = async (client: ClientInfo, clip: ClientClip) => {
    if (busy || (publishingClientPath && !clipPublishQueue.length) || !client.export_status.final_filename || clip.current || queuedClipPaths.current.has(clip.path)) return;
    queuedClipPaths.current.add(clip.path);
    setClipPublishQueue(queue => [...queue, {clientPath:client.path,clip}]);
  };

  useEffect(() => {
    const job = clipPublishQueue[0];
    if (!job || busy || activePublishingClientPath || processingClip.current) return;
    processingClip.current = true;
    setPublishingClientPath(job.clientPath);
    setPublishProgress({ client_path: job.clientPath, stage: "clips", completed: 0, total: 0 });
    void (async () => {
      try {
        const { name, size, modified_ms, sha256 } = job.clip;
        const message = await invoke<string>("publish_client_clips", {
          clientPath: job.clientPath, clipSelections: [{ name, size, modified_ms, sha256 }],
        });
        showToast(message, "success");
      } catch (error) {
        showToast(`Could not publish ${job.clip.name}: ${String(error)}`, "error");
      } finally {
        queuedClipPaths.current.delete(job.clip.path);
        processingClip.current = false;
        setClipPublishQueue(queue => queue.filter(item => item !== job));
        setPublishingClientPath(null);
        setPublishProgress(null);
      }
    })();
  }, [clipPublishQueue, busy, activePublishingClientPath]);

  const handlePromoteLatest = async (client: ClientInfo) => {
    const exportStatus = client.export_status;
    if (!exportStatus.latest_filename || exportStatus.issue) return;
    setPublishingClientPath(client.path);
    setPublishProgress({ client_path: client.path, stage: "main", completed: 0, total: 0 });
    setPromotionError("");
    setError(null);
    try {
      const selectedClips=promotionClips.filter(clip=>promotionClipSelection.has(clip.name)).map(({name,size,modified_ms,sha256})=>({name,size,modified_ms,sha256}));
      setPendingPromotion(null);
      const message = await invoke<string>("promote_latest_export", {clientPath:client.path,expectedFilename:exportStatus.latest_filename,selectedClips});
      setPublishFailedClientPaths((current) => {
        const next = new Set(current);
        next.delete(client.path);
        return next;
      });
      showToast(message, "success");
      setPendingPromotion(null);
      try {
        await refreshClients(projectRoot, false, true, false, [client.name]);
      } catch (err) {
        setError(`Published, but project status could not refresh: ${String(err)}`);
      }
    } catch(err) {
      setPublishFailedClientPaths((current) => new Set(current).add(client.path));
      const message=String(err); setPromotionError(message); setError(`Publish needs attention: ${message}`);
      void refreshClients(projectRoot, false, true, false, [client.name]).catch((refreshError) => console.warn("Could not refresh failed publish status", refreshError));
    } finally {
      setPublishingClientPath(null);
      setPublishProgress(null);
    }
  };

  const toggleManualPublished = async (client: ClientInfo) => {
    const next = { ...manualPublishedPaths };
    if (next[client.path]) delete next[client.path];
    else next[client.path] = true;
    try {
      await saveConfigValue("manualPublishedClients", next);
      setManualPublishedPaths(next);
      showToast(next[client.path] ? "Client marked as published" : "Published override removed", "success");
    } catch (error) { setError(`Could not save published status: ${String(error)}`); }
  };

  const handleUnpublish = async (client: ClientInfo) => {
    setPublishingClientPath(client.path);
    setError(null);
    try {
      let message = "Published override removed";
      if (isFinalised(client)) {
        message = await invoke<string>("unpublish_final", { clientPath: client.path });
      }
      if (manualPublishedPaths[client.path]) {
        const next = { ...manualPublishedPaths };
        delete next[client.path];
        await saveConfigValue("manualPublishedClients", next);
        setManualPublishedPaths(next);
      }
      showToast(message, "success");
      await refreshClients(undefined, false, true);
    } catch (error) {
      setError(`Could not unpublish client: ${String(error)}`);
      void refreshClients(undefined, false, true).catch((refreshError) => console.warn("Could not refresh client after unpublish failure", refreshError));
    } finally {
      setPublishingClientPath(null);
    }
  };

  const toggleStatusWarnings = async (client: ClientInfo) => {
    const next = { ...suppressedStatusPaths };
    if (next[client.path]) delete next[client.path];
    else next[client.path] = true;
    try {
      await saveConfigValue("suppressedClientStatusWarnings", next);
      setSuppressedStatusPaths(next);
      showToast(next[client.path] ? "Status warnings hidden" : "Status warnings restored", "success");
    } catch (error) { setError(`Could not save warning preference: ${String(error)}`); }
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

  function cancelClientDrop(clientPath: string) {
    const next = { ...pendingClientDropsRef.current };
    delete next[clientPath];
    pendingClientDropsRef.current = next;
    setPendingClientDrops(next);
  }

  function updateClientDropChoices(clientPath: string, choices: DropChoices) {
    const pending = pendingClientDropsRef.current[clientPath];
    if (!pending) return;
    pendingClientDropsRef.current = { ...pendingClientDropsRef.current, [clientPath]: { ...pending, choices } };
    setPendingClientDrops(pendingClientDropsRef.current);
  }

  function confirmClientDrop(clientPath: string, choices: DropChoices) {
    const pending = pendingClientDropsRef.current[clientPath];
    if (!pending?.preview || pending.error || busyRef.current) return;
    const groups = pending.preview.groups ?? [];
    if (groups.some(group => !choices[group.kind])) return;
    const routes = groups.map(group => ({ folder: choices[group.kind], paths: group.paths }));
    cancelClientDrop(clientPath);
    void handleSortDrop(pending.client, pending.preview.paths, undefined, routes.length ? undefined : pending.folder, pending.projectRoot, routes.length ? routes : undefined);
  }

  async function queueClientDrop(client: ClientInfo, paths: string[], _meta?: { queued: number; skipped: number }, folder?: string) {
    if (busyRef.current || !paths.length) return;
    const pending: PendingClientDrop = { id: crypto.randomUUID(), client, projectRoot: projectRootRef.current, paths, folder: folder ?? "", preview: null, error: null, choices: {} };
    pendingClientDropsRef.current = { ...pendingClientDropsRef.current, [client.path]: pending };
    setPendingClientDrops(pendingClientDropsRef.current);
    try {
      const preview = await invoke<DropPreview>("media_drop_preview", { clientPath: client.path, destinationFolder: folder ?? null, paths });
      if (pendingClientDropsRef.current[client.path]?.id !== pending.id) return;
      pendingClientDropsRef.current = { ...pendingClientDropsRef.current, [client.path]: { ...pending, preview } };
    } catch (error) {
      if (pendingClientDropsRef.current[client.path]?.id !== pending.id) return;
      pendingClientDropsRef.current = { ...pendingClientDropsRef.current, [client.path]: { ...pending, error: String(error) } };
    }
    setPendingClientDrops(pendingClientDropsRef.current);
  }

  async function handleSortDrop(
    client: ClientInfo,
    paths: string[],
    _meta?: { queued: number; skipped: number },
    destinationFolder?: string,
    rootOverride?: string,
    destinationRoutes?: { folder: string; paths: string[] }[],
  ) {
    let root = rootOverride ?? projectRoot;
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
    if (busyRef.current) return;
    busyRef.current = true;

    setSortingClientPath(client.path);
    setBusy(true);
    setError(null);
    setProgress({ processed: 0, total: paths.length, current: "", result: "", bytes_done: 0, bytes_total: 0 });
    try {
      const result = await invoke<SortResult>("sort_files", {
        projectRoot: root,
        clientName: client.name,
        destinationFolder,
        destinationRoutes,
        mode,
        operation: "copy",
        dryRun: false,
        paths,
      });
      setLastBatch(buildUndoBatch(result.entries));
      setLastSummary(
        `${result.processed} processed • ${result.failed} failed • ${result.skipped} skipped`
      );
      recordNotification(
        `Complete • ${result.processed} processed • ${result.failed} failed • ${result.skipped} skipped`,
        result.failed ? "error" : "success",
        5000
      );
      if (projectRootRef.current === root) await refreshClients(root, false);
    } catch (err) {
      setError(String(err));
      recordNotification(`Transfer failed: ${String(err)}`, "error", 5000);
    } finally {
      setSortingClientPath(null);
      busyRef.current = false;
      setBusy(false);
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        watcherRefreshAllRef.current = false;
        watcherChangedClientsRef.current.clear();
        const visibleRoot = projectRootRef.current;
        if (visibleRoot) await refreshClients(visibleRoot, false);
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

  const handleOpenFileLocation = async (path: string) => {
    try {
      await invoke("open_file_location", { path });
    } catch (err) {
      setError(formatOpenError(path, err));
    }
  };

  const handleOpenFinal = async (client: ClientInfo) => {
    await handleOpenFolder(`${client.path.replace(/[\\/]+$/, "")}\\04_FINAL`);
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
    const target = mediaDropTarget(event.clientX, event.clientY);
    setDragTarget(null);
    hoverClientRef.current = null;
    setDragActive(false);
    if ((target.folder || target.mixed) && paths.length) {
      void queueClientDrop(client, paths, undefined, target.folder);
    }
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

  const clientRowActions = useClientRowActions({
    confirmClientDrop, updateClientDropChoices, cancelClientDrop, toggleClientExpanded, openPepperContextMenu, handleOpenFolder, copyFromContextMenu, handleQuickCreateSession, refreshClients, handleUnpublish, handlePublishClip, showToast, toggleManualPublished, toggleStatusWarnings, handleSortDragOver, setDragTarget, handleDropEvent, setPendingPromotion, handleFixClient, handleOpenFinal, handleOpenFileLocation, setSelectedVersionByClient, openFrameIoSettings, setPendingFrameIoUpload, uploadApprovalToFrameIo, copyFrameIoShareLink, removeFrameIoUpload,
  });

  return (
    <div
      className={`app ${screen === "sort" ? "sort-mode" : ""}`}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
        event.preventDefault();
      }}
    >
      {pepperContextMenu && (
        <div
          ref={pepperContextMenuRef}
          className="pepper-context-menu"
          role="menu"
          aria-label={`${pepperContextMenu.title} menu`}
          style={{ left: pepperContextMenu.x, top: pepperContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="pepper-context-menu-title">{pepperContextMenu.title}</div>
          {pepperContextMenu.items.map((item, index) => (
            <button
              type="button"
              role="menuitem"
              className={`pepper-context-menu-item ${item.separatorBefore ? "has-separator" : ""}`}
              key={`${item.label}-${index}`}
              disabled={item.disabled}
              onClick={() => {
                setPepperContextMenu(null);
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
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
              aria-label={`Notifications${activeNotifications.length ? `, ${activeNotifications.length} in progress` : ""}${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ""}`}
              data-active={activeNotifications.length > 0}
              aria-expanded={showNotificationMenu}
              title="Notifications"
              onClick={() => {
                const opening = !showNotificationMenu;
                setShowNotificationMenu(opening);
                if (opening) setNotificationHistory((current) => current.map((entry) => ({ ...entry, unread: false })));
              }}
            >
              <Bell size={17} aria-hidden="true" />
              {activeNotifications.length > 0 && <span className="notification-bell-active" aria-hidden="true"/>}
              {unreadNotificationCount > 0 && <span className="notification-count">{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</span>}
            </button>
            {showNotificationMenu && (
              <section className="notification-popover" aria-label="Notification history">
                <header className="notification-popover-heading">
                  <div className="notification-popover-title">
                    <strong>Notifications</strong>
                    <span>{activeNotifications.length ? `${activeNotifications.length} in progress` : notificationHistory.length ? `${notificationHistory.length} recent` : "Up to date"}</span>
                  </div>
                  <button type="button" disabled={notificationHistory.length === 0} onClick={() => setNotificationHistory([])} aria-label="Clear notification history" title="Clear history"><Trash2 size={14} /></button>
                </header>
                <NotificationActivities activities={activeNotifications}/>
                {notificationHistory.length === 0 ? (
                  <p className="notification-empty">{activeNotifications.length ? "No recent notifications." : "No notifications yet."}</p>
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
            aria-label="Settings"
            aria-expanded={showAdvancedMenu}
            aria-controls="pepper-settings"
            title="Settings"
            onClick={() => {
              setShowNotificationMenu(false);
              setSettingsSection("general");
              setShowAdvancedMenu(true);
            }}
          >
            <Settings size={17} aria-hidden="true" />
          </button>
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
            onClick={() => void getCurrentWindow().close().catch(error => showToast(`Could not close Pepper: ${String(error)}`, "error"))}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>
      {error && <div className="banner error">{error}</div>}
      {toast && <div className={`toast ${toast.tone}`}>{toast.message}</div>}

      {ingestOpen ? <IngestWorkspace projectRoot={projectRoot} projectTitle={formatProjectName(projectRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "Import media")} clients={clients} clientTypes={projectClientTypes} defaultClientType={defaultProjectClientType} onActivityChange={setIngestOperationBusy} onBack={()=>setIngestOpen(false)} onCreateClient={async(name,clientMode,template,season)=>{await invoke("create_client",{projectRoot,clientName:`${normalizeClientInput(name)}_${clientMode.toUpperCase()}`,clientType:clientMode,season:season||null,huddleTemplate:(workspaceConfig?.clientTypes.find(type=>type.id===clientMode)?.featureOptions.premiere_project?.length??0)>1?template:null,resourceMappings:workspaceLocalMappings});await refreshClients(undefined,false);}} /> : <div className="app-content">
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
            {(["collecting","inventorying","filing"].includes(ingestProgress?.phase||""))&&ingestProgress?.project_root===projectRoot&&<button type="button" className="ingest-progress-entry" onClick={()=>setIngestOpen(true)}><LoaderCircle size={14} className="spin"/> {ingestProgress.phase==="inventorying"?"Finding media":ingestProgress.phase==="filing"?`Organising ${ingestProgress.completed}/${ingestProgress.total}`:`Copying ${ingestProgress.completed}/${ingestProgress.total}`} · View import</button>}
            <button type="button" className="media-import-entry" aria-label="Import media" title="Import media" disabled={!projectRoot} onClick={()=>setIngestOpen(true)}><FolderInput size={17}/></button>
          </div>
          {advancedMode && (
            <details className="advanced-stats-disclosure">
              <summary>Project stats</summary>
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
            </details>
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

            </div>
          </div>
          </div>
          <ClientScrollArea
            onDragOver={screen === "sort" ? handleSortDragOver : undefined}
            scrollRef={tableScrollRef}
          >
            <div className={`table client-list ${advancedMode ? "client-list-advanced" : ""}`}>
              {showNewClientForm && <form className="table-row add-client-inline" aria-label="Create client" aria-busy={creatingClient} onSubmit={(event) => { event.preventDefault(); void handleAddClient(); }}>
                <label className="new-client-name">Client name
                <input
                  className="inline-input"
                  autoFocus
                  placeholder="e.g. Digitain"
                  disabled={creatingClient}
                  value={newClientName}
                  onChange={(event) => setNewClientName(event.target.value)}
                />
                </label>
                <fieldset className="new-client-types" disabled={creatingClient}><legend>Client type</legend>
                <div className="inline-types">
                  {projectClientTypes.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      className={`type-chip ${
                        newClientType === type.id ? "selected" : ""
                      } ${type.id.toLowerCase()}`}
                      aria-pressed={newClientType === type.id}
                      onClick={() => setNewClientType(type.id)}
                    >
                      {clientTypeLabel(type.id, workspaceTypeNames)}
                    </button>
                  ))}
                </div>
                {workspaceConfig && !currentWorkspaceProject && <p className="client-type-config-message" role="alert">This project is missing from the shared project catalog.</p>}
                {currentWorkspaceProject && !projectProfile && <p className="client-type-config-message" role="alert">Assign this project to a profile in Workspace settings.</p>}
                {projectProfile && !projectClientTypes.length && <p className="client-type-config-message" role="alert">This profile has no valid client types assigned.</p>}
                </fieldset>
                <div className={`client-extra ${needsProjectSeason ? "has-season" : ""} ${needsProjectSeason || (selectedWorkspaceClientType?.featureOptions.premiere_project?.length ?? 0) > 1 ? "has-options" : ""}`}>
                {needsProjectSeason && <ProjectSeasonSelect selection={projectSeasons} />}
                {(selectedWorkspaceClientType?.featureOptions.premiere_project?.length ?? 0) > 1 && (
                  <InterviewTypeSelect value={huddleTemplate} onChange={setHuddleTemplate} disabled={creatingClient} />
                )}
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="ghost new-client-cancel"
                    disabled={creatingClient}
                    aria-label="Cancel adding client"
                    title="Cancel"
                    onClick={() => {
                      setNewClientName("");
                      setNewClientType(defaultProjectClientType);
                      setHuddleTemplate("VIDEO_CALL");
                      setShowNewClientForm(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary new-client-submit"
                    aria-label="Create client"
                    title="Create client"
                    disabled={creatingClient || !newClientName.trim() || !workspaceConfig || workspaceDiscovery?.status !== "valid" || !currentWorkspaceProject || !projectProfile || !projectClientTypes.length || (needsProjectSeason && (projectSeasons.loading || projectSeasons.creating || !projectSeasons.season))}
                  >
                    {creatingClient ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} {creatingClient ? "Creating?" : "Create client"}
                  </button>
                </div>
              </form>}
            <div className="table-row table-head">
              <div className="client-column-heading">
                <button
                  type="button"
                  className="column-sort"
                  onClick={() => toggleClientSort("name")}
                  aria-label={clientSort.column === "name" && clientSort.direction === "asc" ? "Client name: A to Z. Click to sort Z to A" : "Sort client names A to Z"}
                >
                  Client {sortIcon("name")}
                </button>
              </div>
              <div className="status-column-heading">
                <button
                  type="button"
                  className="column-sort"
                  onClick={() => toggleClientSort("status")}
                  aria-label={clientSort.column === "status" && clientSort.direction === "asc" ? "Status: unfinished first. Click to show finalised first" : "Sort status: unfinished first"}
                  title={clientSort.column === "status" && clientSort.direction === "asc" ? "Show finalised projects first" : "Show unfinished projects first"}
                >
                  Status {sortIcon("status")}
                </button>
              </div>
              <div className="actions-column-heading"><span className="column-label">Actions</span></div>
            </div>
            {loading && visibleClients.length === 0 && clients.length > 0 && (
              <div className="table-row">Loading…</div>
            )}
            {visibleClients.length === 0 && !loading && (
              <div className="table-row">
                {projectRoot ? "No clients found." : "Select a numbered project to view clients."}
              </div>
            )}
            {clientListReady && clientSections.map(section => (
              <section key={section.clients[0].path} className={`client-section ${section.season ? "client-season-group" : ""}`} aria-label={section.season?.replace(/^SEASON\s+/i, "Season ") || "Clients"}>
              {section.clients.map((client, sectionIndex) => (
                <ClientListRow
                  key={client.path}
                  client={client}
                  index={section.start + sectionIndex}
                  screen={screen}
                  frameIoProgress={frameIoProgress}
                  frameIoConfig={frameIoConfig}
                  frameIoBusyPath={frameIoBusyPath}
                  busy={busy}
                  projectRoot={projectRoot}
                  advancedMode={advancedMode}
                  publishingClientPath={publishingClientPath}
                  clipPublishStates={clipPublishStates}
                  publishProgress={publishProgress?.client_path === client.path ? publishProgress : null}
                  hoverClientRef={hoverClientRef}
                  workspaceTypeNames={workspaceTypeNames}
                  frameIoConfigured={frameIoConfigured}
                  activeProject={activeProject}
                  clientIsCached={cachedClientNames.has(client.name)}
                  expanded={expandedClients.has(client.name)}
                  manuallyPublished={Boolean(manualPublishedPaths[client.path])}
                  warningsSuppressed={Boolean(suppressedStatusPaths[client.path])}
                  publishFailedOverride={publishFailedClientPaths.has(client.path)}
                  selectedVersion={selectedVersionByClient[client.name]}
                  dragOver={dragTarget === client.name}
                  dragKinds={dragTarget === client.name ? dragKinds : null}
                  transferProgress={sortingClientPath === client.path ? progress : null}
                  pendingDrop={pendingClientDrops[client.path] ?? null}
                  creatingStudio={creatingStudioClients.has(client.path)}
                  studioRequest={studioRequests[client.path] ?? 0}
                  actions={clientRowActions}
                />
              ))}
              </section>
            ))}
            </div>
          </ClientScrollArea>
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
      </div>}

      {!ingestOpen && <footer className="status">
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
      </footer>}

      {showAdvancedMenu && (
        <SettingsDialog section={settingsSection} workspaceAvailable={advancedMode || workspaceSetupRequired} onClose={() => setShowAdvancedMenu(false)} onNavigate={(section) => {
          if (section === "integrations") openFrameIoSettings();
          else setSettingsSection(section);
        }}>
          {settingsSection === "general" && <>
            {advancedMode && <section className="settings-group">
              <h4>Display</h4>
                <label className="settings-toggle">
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
                  <span><strong>Float on top</strong><small>Keep Pepper above other windows.</small></span>
                </label>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={showNonClients}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setShowNonClients(checked);
                      saveConfigValue("showNonClients", checked);
                    }}
                  />
                  <span><strong>Show non-client folders</strong><small>Include other folders in the client list.</small></span>
                </label>

            </section>}
            <section className="settings-group">
              <h4>Application</h4>
              <div className="settings-row"><div><strong>Pepper updates</strong><small>Check for the latest version of Pepper.</small></div>
                <button type="button" className="ghost" disabled={checkingForUpdates} onClick={() => void checkForUpdates()}><RefreshCw size={14} className={checkingForUpdates ? "spinning" : ""} />{checkingForUpdates ? "Checking…" : "Check for updates"}</button>
              </div>
              <p className="settings-feedback" role="status">{settingsUpdateStatus}</p>
            </section>
          </>}
          {settingsSection === "advanced" && <>
            <section className="settings-group"><h4>Access</h4>
                <label className="settings-toggle">
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
                  <span><strong>Advanced mode</strong><small>Unlock manual status and maintenance controls.</small></span>
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

            </section>
            {advancedMode && <section className="settings-group"><h4>Maintenance</h4>
              <div className="settings-row"><div><strong>Last operation</strong><small>{lastSummary || "No operations to undo."}</small></div><button type="button" className="ghost" onClick={() => { setShowAdvancedMenu(false); setShowUndoConfirm(true); }} disabled={!lastBatch.length}>Undo last</button></div>
              <div className="settings-row"><div><strong>Project log</strong><small>View the current project's operation history.</small></div><button type="button" className="ghost" onClick={() => void handleLogOpen()} disabled={!projectRoot}>View log <ArrowUpRight size={13} /></button></div>
            </section>}
          </>}
          {settingsSection === "integrations" && <div className="settings-integrations">
            <StudioMailSettings />
            <section className="integration-provider" aria-labelledby="integration-frameio-title">
              <header className="integration-heading">
                <IntegrationBrand provider="frameio" />
                {frameIoIssues.length > 0 && <span className="integration-status integration-issues" role="status" title={frameIoIssues.join("\n")}><TriangleAlert size={12} aria-hidden="true" />{frameIoIssues.length} {frameIoIssues.length === 1 ? "Issue" : "Issues"}</span>}
              </header>
              {frameIoAccounts.length === 0 && <div className="settings-actions integration-connect">
                <button type="button" className="ghost" disabled={!frameIoConfig.clientId || !frameIoConfig.scopes || frameIoLoadingChoices || frameIoAuthBusy} onClick={() => void connectFrameIo()}>{frameIoAuthBusy ? "Waiting for Adobe..." : "Connect Adobe"}</button>
              </div>}
              <div className="integration-storage" aria-live="polite">
                <button type="button" className="integration-refresh" disabled={frameIoStorageLoading || !frameIoConfig.accountId} onClick={() => void loadFrameIoStorage()} aria-label="Refresh Frame.io storage" title="Refresh storage"><RefreshCw size={13} className={frameIoStorageLoading ? "spinning" : ""} /></button>
              {frameIoStorage && (() => {
                const remaining = Math.max(0, frameIoStorage.limitBytes - frameIoStorage.usedBytes);
                const percentage = frameIoStorage.limitBytes > 0 ? Math.min(100, frameIoStorage.usedBytes / frameIoStorage.limitBytes * 100) : 0;
                return <>
                  <div className="integration-storage-numbers"><strong>{formatStorage(remaining)} free</strong><span>{formatStorage(frameIoStorage.usedBytes)} of {formatStorage(frameIoStorage.limitBytes)} used</span></div>
                  <div className="frameio-storage-track" role="progressbar" aria-label="Frame.io storage used" aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percentage}%` }} /></div>
                </>;
              })()}
              {!frameIoStorageLoading && !frameIoStorage && <p className="frameio-storage-note">{frameIoStorageError ?? (frameIoConfig.accountId ? "Storage usage is unavailable." : "Select an account to view its storage quota.")}</p>}

              </div>
              <details className="integration-options">
                <summary aria-label="Frame.io connection options">Connection options</summary>
                <div className="frameio-config-grid">
                <label>Account<select value={frameIoConfig.accountId} onChange={(event) => void selectFrameIoAccount(event.target.value)} disabled={frameIoLoadingChoices || frameIoAccounts.length === 0}><option value="">{frameIoAccounts.length ? "Select an account" : "Connect Adobe to load accounts"}</option>{frameIoAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label>Project<select value={frameIoConfig.projectId} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, projectId: event.target.value })} disabled={!frameIoConfig.accountId || frameIoLoadingChoices || frameIoProjects.length === 0}><option value="">{frameIoProjects.length ? "Select a project" : frameIoConfig.accountId ? "No projects returned for this account" : "Choose an account first"}</option>{frameIoProjects.map((project) => <option key={project.id} value={project.id}>{project.workspace_name ? `${project.workspace_name} — ` : ""}{project.name}</option>)}</select></label>
              </div>

            <div className="settings-actions">
              {frameIoAccounts.length > 0 && <button type="button" className="ghost" disabled={frameIoLoadingChoices} onClick={() => void loadFrameIoChoices().catch(() => undefined)}>Refresh accounts</button>}
              {frameIoAuthBusy && <button type="button" className="ghost" onClick={() => void cancelFrameIoAuth()}>Cancel sign-in</button>}
              {frameIoAccounts.length > 0 && <button type="button" className="ghost" disabled={!frameIoConfig.clientId || !frameIoConfig.scopes || frameIoLoadingChoices || frameIoAuthBusy} onClick={() => void connectFrameIo()}>{frameIoAuthBusy ? "Waiting for Adobe…" : "Reconnect Adobe"}</button>}
            </div>
              <details className="integration-options integration-developer">
                <summary>Developer settings</summary>
              <div className="frameio-advanced-fields">
                <label>Client ID<input value={frameIoConfig.clientId} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, clientId: event.target.value })} placeholder="From Adobe Developer Console" /></label>
                <label>OAuth scopes<input value={frameIoConfig.scopes} onChange={(event) => void saveFrameIoConfig({ ...frameIoConfig, scopes: event.target.value })} placeholder="Scopes enabled for this credential" /></label>
                <p className="frameio-help">Pepper uses the Adobe Native App redirect URI assigned to this credential. Credentials stay in this computer’s secure credential store.</p>
              </div>
              </details>

              </details>
              {frameIoSetupError && <p className="frameio-setup-error" role="alert">{frameIoSetupError}</p>}
            </section>
            <section className="integration-provider" aria-labelledby="integration-restream-title">
              <header className="integration-heading">
                <IntegrationBrand provider="restream" />
                {restreamError && <span className="integration-status integration-issues" role="status" title={restreamError}><TriangleAlert size={12} aria-hidden="true" />1 Issue</span>}
              </header>
              {restreamError && <div className="restream-error-row"><p className="frameio-setup-error" role="alert">{restreamError}</p><button type="button" className="frameio-storage-refresh" onClick={()=>void writeText(restreamError).then(()=>showToast("Restream error copied to clipboard.","success")).catch(error=>showToast(`Could not copy error: ${String(error)}`,"error",6000))}><Copy size={13}/> Copy error</button></div>}
              {restreamStatus === "connected" ? <details className="integration-options">
                <summary aria-label="Restream connection options">Connection options</summary>
<div className="settings-actions">
                {restreamStatus === "connected" && <button type="button" className="ghost" disabled={restreamBusy} onClick={()=>void invoke("restream_disconnect").then(()=>setRestreamStatus("disconnected")).catch(e=>setRestreamError(String(e)))}>Disconnect</button>}
                <button type="button" className="primary" disabled={restreamBusy} onClick={()=>void connectRestream()}>{restreamBusy ? "Waiting for Restream…" : "Reconnect"}</button>
              </div>
              </details> : <div className="settings-actions integration-connect"><button type="button" className="ghost" disabled={restreamBusy} onClick={() => void connectRestream()}>{restreamBusy ? "Waiting for Restream..." : "Connect"}</button></div>}
            </section>
          </div>}
          {settingsSection === "people" && <StudioMailPeopleSettings />}
          {settingsSection === "workspace" && <WorkspaceSettings
            root={workspaceRoot}
            config={workspaceConfig}
            setup={workspaceSetupRequired}
            writable={workspaceDiscovery?.status === "absent" ? workspaceDiscovery.writable : workspaceDiscovery?.status === "valid" && workspaceDiscovery.writable}
            localMappings={workspaceLocalMappings}
            starterProjectShowNames={projectShowCatalog?.shows.map((show) => show.name) ?? []}
            onLocalMappingsSave={async (mappings) => {
              if (!workspaceConfig) throw new Error("Load a validated workspace before saving computer-only paths.");
              await CONFIG_STORE.set(`workspaceResourceMappings:${workspaceConfig.workspaceId}`, mappings);
              await CONFIG_STORE.save();
              setWorkspaceLocalMappings(mappings);
            }}
            onRootSelected={(root) => void handleWorkspaceRootSelected(root)}
            onSaved={(root, config) => void handleWorkspaceSaved(root, config)}
            onClose={() => setShowAdvancedMenu(false)}
          />}
        </SettingsDialog>
      )}

      {pendingFrameIoUpload && (
        <dialog
          ref={frameIoUploadDialogRef}
          className="modal frameio-link-warning-modal"
          aria-labelledby="frameio-link-warning-title"
          aria-describedby="frameio-link-warning-description"
          onCancel={(event) => {
            event.preventDefault();
            setPendingFrameIoUpload(null);
          }}
        >
          <div className="frameio-warning-header">
            <span className="frameio-warning-icon"><TriangleAlert size={18} aria-hidden="true" /></span>
            <div>
              <h2 id="frameio-link-warning-title">New review link</h2>
            </div>
          </div>
          <div className="frameio-warning-body">
            <div className="frameio-warning-file">
              <strong>{parseClientLabel(pendingFrameIoUpload.clientKey).name}</strong>
              {pendingFrameIoVersion != null && <span className="frameio-warning-version" aria-label={`Version ${pendingFrameIoVersion}`}>V{pendingFrameIoVersion}</span>}
            </div>
            <p id="frameio-link-warning-description">This version needs a separate link.</p>
          </div>
          <div className="modal-actions frameio-warning-actions">
            <button type="button" className="ghost" autoFocus onClick={() => setPendingFrameIoUpload(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const upload = pendingFrameIoUpload;
                setPendingFrameIoUpload(null);
                if (upload) void uploadApprovalToFrameIo(upload.path, upload.clientKey, upload.projectName, upload.projectPath);
              }}
            >
              Send for review
            </button>
          </div>
        </dialog>
      )}

      {pendingFrameIoRemoval && (
        <dialog
          ref={frameIoRemoveDialogRef}
          className="modal frameio-link-warning-modal"
          aria-labelledby="frameio-remove-title"
          aria-describedby="frameio-remove-description"
          onCancel={(event) => { event.preventDefault(); setPendingFrameIoRemoval(null); }}
        >
          <div className="frameio-warning-header">
            <span className="frameio-warning-icon"><TriangleAlert size={18} aria-hidden="true" /></span>
            <div><h2 id="frameio-remove-title">Remove from Frame.io?</h2></div>
          </div>
          <div className="frameio-warning-body">
            <div className="frameio-warning-file">
              <strong>{parseClientLabel(pendingFrameIoRemoval.clientKey).name}</strong>
              <span className="frameio-warning-version">V{pendingFrameIoRemoval.version}</span>
            </div>
            <p id="frameio-remove-description">This deletes the uploaded Frame.io file. Pepper will keep the local approval copy.</p>
          </div>
          <div className="modal-actions frameio-warning-actions">
            <button type="button" className="ghost" autoFocus onClick={() => setPendingFrameIoRemoval(null)}>Cancel</button>
            <button type="button" className="primary" onClick={() => void confirmRemoveFrameIoUpload()}>Remove from Frame.io</button>
          </div>
        </dialog>
      )}

      {pendingPromotion && (
        <dialog
          ref={promotionDialogRef}
          className="modal promotion-modal"
          aria-label="Publish final"
          onCancel={(event) => {
            event.preventDefault();
            setPendingPromotion(null);
          }}
        >
          <header className="promotion-heading"><div><h2>Publish final</h2><p className="promotion-client-name">{parseClientLabel(pendingPromotion.name).name}</p></div><button type="button" className="promotion-close" aria-label="Close publish dialog" onClick={()=>setPendingPromotion(null)}><X size={17}/></button></header>
          <div className="promotion-content">
          <nav className="cw-tabs cw-review-tabs promotion-tabs" role="tablist" aria-label="Publish views">
            <button type="button" id="publish-main-tab" role="tab" aria-selected={promotionTab==='main'} aria-controls="publish-main-panel" onClick={()=>setPromotionTab('main')}><VideoIcon size={14}/>Main video</button>
            {promotionClips.length>0&&<button type="button" id="publish-clips-tab" role="tab" aria-selected={promotionTab==='clips'} aria-controls="publish-clips-panel" onClick={()=>setPromotionTab('clips')}><Clapperboard size={14}/>Clips<span className="promotion-tab-count">{promotionClipSelection.size}/{promotionClips.length}</span></button>}
          </nav>
          {(() => {
            const cleanVersion = pendingPromotion.export_status.versions.find(version=>version.version===pendingPromotion.export_status.latest_version);
            const previewClip = promotionClips.find(clip=>clip.path===promotionClipPreview)??promotionClips[0];
            const cleanPath = cleanVersion ? `${pendingPromotion.path.replace(/[\\/]+$/, "")}\\03_EXPORTS\\${cleanVersion.relative_path.replace(/[\\/]+/g, "\\")}` : null;
            const previewPath = promotionTab==='clips'?previewClip?.path:cleanPath;
            return <div role="tabpanel" id={promotionTab==='main'?'publish-main-panel':'publish-clips-panel'} aria-labelledby={promotionTab==='main'?'publish-main-tab':'publish-clips-tab'} className={`promotion-workspace ${promotionTab==='clips'&&promotionClips.length?'has-clips':''}`}>
              <article className="export-preview promotion-preview">
                {previewPath?<div className="clip-review-stage promotion-review-stage"><InlineVideoPlayer key={previewPath} className="promotion-video-player" src={convertFileSrc(previewPath)}/></div>:<p className="promotion-preview-empty">{promotionTab==='clips'?'No clips available.':'Clean master unavailable. Refresh exports.'}</p>}
              </article>
              {promotionTab==='clips'&&promotionClips.length>0&&<ClipReviewList label="Clips to publish" selected={previewClip?.path??''} items={promotionClips.map(clip=>({id:clip.path,name:clip.name,checked:promotionClipSelection.has(clip.name)}))} onSelect={setPromotionClipPreview} disabled={publishingClientPath===pendingPromotion.path} onToggle={id=>{const clip=promotionClips.find(item=>item.path===id);if(clip)setPromotionClipSelection(current=>{const next=new Set(current);if(next.has(clip.name))next.delete(clip.name);else next.add(clip.name);return next;});}}
                header={<div className="promotion-selection-header"><label><input type="checkbox" aria-label="Include all clips" ref={input=>{if(input)input.indeterminate=promotionClipSelection.size>0&&promotionClipSelection.size<promotionClips.length;}} checked={promotionClipSelection.size===promotionClips.length} disabled={publishingClientPath===pendingPromotion.path} onChange={event=>setPromotionClipSelection(event.target.checked?new Set(promotionClips.map(clip=>clip.name)):new Set())}/><span>Include all</span></label><span>{promotionClipSelection.size} selected</span></div>}
              />}
            </div>;
          })()}
          {promotionError&&<p className="promotion-error" role="alert">{promotionError}</p>}
          </div>
          <div className="modal-actions promotion-actions">
            <div className="promotion-publish-summary" aria-live="polite"><span><VideoIcon size={13}/>Main video</span>{promotionClipSelection.size>0&&<><Plus size={11} className="promotion-summary-plus"/><span><Clapperboard size={13}/>{promotionClipSelection.size} {promotionClipSelection.size===1?'clip':'clips'}</span></>}</div>
            <button type="button" className="ghost promotion-cancel" autoFocus onClick={() => setPendingPromotion(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary promotion-publish-button"
              disabled={publishingClientPath===pendingPromotion.path||!pendingPromotion.export_status.versions.some((version) => version.version === pendingPromotion.export_status.latest_version)}
              onClick={() => void handlePromoteLatest(pendingPromotion)}
            >
              {publishingClientPath===pendingPromotion.path?<><LoaderCircle size={14} className="cf-spin"/><span>Publishing…</span></>:<><span>{(promotionError&&!promotionError.startsWith("Could not load clips:")||pendingPromotion.export_status.publish_failed)?"Retry publish":"Publish final"}</span><ArrowUpRight size={14}/></>}
            </button>
          </div>
        </dialog>
      )}

      {pendingUpdate && (
        <UpdateDialog
          update={pendingUpdate}
          operationActive={Boolean(busy || publishingClientPath || frameIoBusyPath || creatingClient || ingestOperationBusy)}
          onBusyChange={value => { updateInProgressRef.current = value; }}
          onDismiss={dismissUpdate}
        />
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
