import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Archive, ArrowLeft, ChevronRight, Copy, FolderOpen, Folders, History, LayoutGrid, ListFilter, Plus, RefreshCw, RotateCcw, Save as SaveIcon, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useSettingsCloseGuard } from "./SettingsDialog";
import { WORKSPACE_FEATURES, type WorkspaceConfig, type WorkspaceDiscovery, type WorkspaceFolder, type WorkspaceHistoryEntry } from "./workspaceTypes";
import "./WorkspaceSettings.css";

const pages = [
  { id: "overview", title: "Workspace", icon: LayoutGrid, description: "Shared with everyone using this folder." },
  { id: "types", title: "Client types", icon: SlidersHorizontal, description: "Choose the tools and folder structure each client type uses." },
  { id: "profiles", title: "Project rules", icon: ListFilter, description: "Choose which client types are available in each project." },
  { id: "folders", title: "Folders", icon: Folders, description: "Define the folder structure for new clients. Existing folders stay unchanged." },
  { id: "resources", title: "Templates", icon: FolderOpen, description: "Connect Premiere templates for your team and this computer." },
  { id: "catalog", title: "Project names", icon: ListFilter, description: "Names offered when creating a new project." },
  { id: "recovery", title: "Backups", icon: Archive, description: "Export, import or restore your workspace settings." },
] as const;
type Page = typeof pages[number]["id"];
type Props = {
  root: string;
  config: WorkspaceConfig | null;
  setup?: boolean;
  writable: boolean;
  localMappings: Record<string, string>;
  starterProjectShowNames: string[];
  onLocalMappingsSave: (mappings: Record<string, string>) => Promise<void>;
  onRootSelected: (root: string) => void;
  onSaved: (root: string, config: WorkspaceConfig) => void;
  onClose: () => void;
};

const makeId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`;
const clone = <T,>(value: T): T => structuredClone(value);
const windowsInvalid = /[<>:"|?*\u0000-\u001f]/;
const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function folderIssue(path: string): string | null {
  if (!path.trim()) return "Enter a folder path.";
  if (/^(\\\\|[a-z]:)/i.test(path) || path.startsWith("/")) return "Use a path inside the client folder.";
  const parts: string[] = path.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".pepper")) return "Use a safe relative folder path.";
  if (parts.some((part) => windowsInvalid.test(part) || /[. ]$/.test(part) || reservedName.test(part))) return "This name is not valid for a Windows folder.";
  return null;
}

function importSummary(current: WorkspaceConfig | null, incoming: WorkspaceConfig): string[] {
  if (!current) return ["Initializes shared settings for this workspace."];
  const changedItems = <T extends { id: string }>(before: T[], after: T[], equal: (left: T, right: T) => boolean) => {
    const oldById = new Map(before.map((item) => [item.id, item]));
    const newById = new Map(after.map((item) => [item.id, item]));
    return { added: after.filter((item) => !oldById.has(item.id)).length, removed: before.filter((item) => !newById.has(item.id)).length, changed: after.filter((item) => oldById.has(item.id) && !equal(oldById.get(item.id)!, item)).length };
  };
  const count = (label: string, values: { added: number; removed: number; changed: number }) => `${label}: ${values.added} added, ${values.removed} removed, ${values.changed} changed`;
  const types = changedItems(current.clientTypes, incoming.clientTypes, (a, b) => a.name === b.name && a.folderTemplateId === b.folderTemplateId && JSON.stringify(a.features) === JSON.stringify(b.features) && JSON.stringify(a.featureOptions) === JSON.stringify(b.featureOptions));
  const profiles = changedItems(current.profiles, incoming.profiles, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const folders = changedItems(current.folderTemplates, incoming.folderTemplates, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const resources = changedItems(current.resources, incoming.resources, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  return [count("Client types", types), count("Project profiles and defaults", profiles), count("Folder structures", folders), count("Shared resource references", resources), current.projectShowNames.join("\n") === incoming.projectShowNames.join("\n") ? "Project name choices: unchanged" : `Project name choices: ${current.projectShowNames.length} to ${incoming.projectShowNames.length}`];
}

export function WorkspaceSettings({ root, config, setup = false, writable, localMappings, starterProjectShowNames, onLocalMappingsSave, onRootSelected, onSaved, onClose }: Props) {
  const [saved, setSaved] = useState<WorkspaceConfig | null>(config);
  const [draft, setDraft] = useState<WorkspaceConfig | null>(config);
  const [workspaceRoot, setWorkspaceRoot] = useState(root);
  const [setupStep, setSetupStep] = useState<"location" | "starting" | "review" | "editor">(setup ? "location" : "editor");
  const [page, setPage] = useState<Page>("overview");
  const [typeDetailsOpen, setTypeDetailsOpen] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState(config?.clientTypes[0]?.id ?? "");
  const [selectedProfileId, setSelectedProfileId] = useState(config?.profiles[0]?.id ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState(config?.folderTemplates[0]?.id ?? "");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [remote, setRemote] = useState<WorkspaceDiscovery | null>(null);
  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
  const [historyChoice, setHistoryChoice] = useState("");
  const [importDraft, setImportDraft] = useState<WorkspaceConfig | null>(null);
  const [importPath, setImportPath] = useState("");
  const [importReviewSummary, setImportReviewSummary] = useState<string[] | null>(null);
  const [localDraft, setLocalDraft] = useState(localMappings);
  const [localStatus, setLocalStatus] = useState("");
  const [sampleClient, setSampleClient] = useState("Sample Client");
  const [newProjectShowName, setNewProjectShowName] = useState("");
  const [previewProjectId, setPreviewProjectId] = useState(config?.projects[0]?.id ?? "");
  const [guardOpen, setGuardOpen] = useState(false);
  const guardDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = guardDialog.current;
    if (guardOpen) dialog?.showModal();
    return () => dialog?.close();
  }, [guardOpen]);
  const leaveAfterSave = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWorkspaceRoot(root);
    if (config) {
      setSaved(config);
      setDraft(config);
      setSelectedTypeId((id) => config.clientTypes.some((item) => item.id === id) ? id : config.clientTypes[0]?.id ?? "");
      setSelectedProfileId((id) => config.profiles.some((item) => item.id === id) ? id : config.profiles[0]?.id ?? "");
      setSelectedTemplateId((id) => config.folderTemplates.some((item) => item.id === id) ? id : config.folderTemplates[0]?.id ?? "");
      setPreviewProjectId((id) => config.projects.some((item) => item.id === id) ? id : config.projects[0]?.id ?? "");
    }
  }, [root, config]);
  useEffect(() => setLocalDraft(localMappings), [localMappings]);
  useEffect(() => {
    if (setup) setSetupStep("location");
    else if (config) setSetupStep("editor");
  }, [setup, config]);

  const sharedDirty = useMemo(() => Boolean(draft && (!saved || JSON.stringify(draft) !== JSON.stringify(saved))), [draft, saved]);
  const localDirty = useMemo(() => JSON.stringify(localDraft) !== JSON.stringify(localMappings), [localDraft, localMappings]);
  const dirty = sharedDirty || localDirty;
  const activeType = draft?.clientTypes.find((type) => type.id === selectedTypeId) ?? draft?.clientTypes[0];
  const activeProfile = draft?.profiles.find((profile) => profile.id === selectedProfileId) ?? draft?.profiles[0];
  const activeTemplate = draft?.folderTemplates.find((template) => template.id === selectedTemplateId) ?? draft?.folderTemplates[0];
  const currentPage = pages.find((item) => item.id === page)!;
  const navigate = (next: Page) => { setPage(next); };

  const requestLeave = useCallback((leave: () => void) => {
    if (dirty) { leaveAfterSave.current = leave; setGuardOpen(true); }
    else leave();
  }, [dirty]);
  const closeRequest = useCallback((leave = onClose) => requestLeave(leave), [requestLeave, onClose]);
  useSettingsCloseGuard(closeRequest);

  const refreshState = useRef({ workspaceRoot, saved, dirty, onSaved });
  useLayoutEffect(() => { refreshState.current = { workspaceRoot, saved, dirty, onSaved }; });
  const refreshInFlight = useRef<string | null>(null);
  const refreshWorkspace = useCallback(async () => {
    if (!workspaceRoot || refreshInFlight.current === workspaceRoot) return;
    refreshInFlight.current = workspaceRoot;
    try {
      const next = await invoke<WorkspaceDiscovery>("workspace_discover", { root: workspaceRoot });
      const latest = refreshState.current;
      if (latest.workspaceRoot !== workspaceRoot) return;
      if (next.status === "valid" && next.config) {
        const changed = !latest.saved || next.config.revision !== latest.saved.revision || next.config.contentHash !== latest.saved.contentHash;
        if (changed && latest.dirty) setRemote(next);
        else if (changed) {
          setSaved(next.config); setDraft(next.config); setRemote(null); latest.onSaved(workspaceRoot, next.config);
        }
        if (next.lock) setRemote((current) => current ?? next);
      } else if (next.status !== "valid") setRemote(next);
    } catch (cause) {
      if (refreshState.current.workspaceRoot === workspaceRoot) setError(String(cause));
    } finally {
      if (refreshInFlight.current === workspaceRoot) refreshInFlight.current = null;
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (setupStep !== "editor") return;
    void refreshWorkspace();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshWorkspace(); }, 20_000);
    let focusTimer: number | undefined;
    const focus = () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => { if (document.visibilityState === "visible") void refreshWorkspace(); }, 250);
    };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.clearTimeout(focusTimer); window.removeEventListener("focus", focus); };
  }, [setupStep, refreshWorkspace]);

  const updateDraft = (mutate: (current: WorkspaceConfig) => WorkspaceConfig) => {
    setDraft((current) => current ? mutate(current) : current);
    setError(""); setStatus("");
  };

  const chooseRoot = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Choose the workspace folder" });
    if (typeof picked !== "string") return;
    setWorkspaceRoot(picked); onRootSelected(picked); setRemote(null); setError("");
  };

  const continueFromLocation = async () => {
    setError(""); setStatus("");
    try {
      if (workspaceRoot.replace(/[\\/]+$/, "").toLowerCase() !== root.replace(/[\\/]+$/, "").toLowerCase()) onRootSelected(workspaceRoot);
      const found = await invoke<WorkspaceDiscovery>("workspace_discover", { root: workspaceRoot });
      if (found.status === "valid" && found.config) {
        setSaved(found.config); setDraft(found.config); setSetupStep("editor"); onSaved(workspaceRoot, found.config); return;
      }
      if (found.status === "absent") { setSetupStep("starting"); return; }
      setError(found.message ?? (found.status === "unsupported" ? "Update Pepper to open this workspace." : "Workspace settings could not be loaded."));
    } catch (cause) { setError(String(cause)); }
  };

  const makeStarter = async (customize = false) => {
    try {
      const next = await invoke<WorkspaceConfig>("workspace_starter", { root: workspaceRoot, displayName: "", projectShowNames: starterProjectShowNames });
      setDraft(next); setSaved(null); setSetupStep(customize ? "editor" : "review"); setPage("overview");
      setSelectedTypeId(next.clientTypes[0]?.id ?? ""); setSelectedProfileId(next.profiles[0]?.id ?? "");
      setSelectedTemplateId(next.folderTemplates[0]?.id ?? ""); setPreviewProjectId(next.projects[0]?.id ?? "");
    } catch (cause) { setError(String(cause)); }
  };

  const openImport = async () => {
    try {
      const path = await open({ multiple: false, title: "Import workspace settings", filters: [{ name: "Pepper workspace", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const imported = await invoke<WorkspaceConfig>("workspace_import_read", { path });
      setImportDraft(imported); setImportPath(path); setError(""); setStatus("");
    } catch (cause) { setError(String(cause)); }
  };

  const applyImport = () => {
    if (!importDraft) return;
    const current = saved;
    const next = clone(importDraft);
    setImportReviewSummary(importSummary(current, next));
    if (current) { next.workspaceId = current.workspaceId; next.revision = current.revision; next.contentHash = current.contentHash; }
    else { next.workspaceId = globalThis.crypto?.randomUUID?.() ?? makeId("workspace"); next.revision = 0; next.contentHash = ""; }
    setDraft(next); setImportDraft(null); setSetupStep("review"); setPage("overview");
  };

  const saveWorkspace = async () => {
    if ((!sharedDirty && !localDirty) || (sharedDirty && (!draft || !writable)) || saving) return;
    setSaving(true); setError(""); setStatus("");
    try {
      if (sharedDirty && draft) {
        const result = await invoke<WorkspaceConfig>("workspace_save", {
          root: workspaceRoot,
          draft,
          expectedRevision: saved?.revision ?? null,
          expectedHash: saved?.contentHash ?? null,
        });
        setDraft(result); setSaved(result); setRemote(null); setSetupStep("editor");
        onSaved(workspaceRoot, result);
      }
      if (localDirty) { await onLocalMappingsSave(localDraft); setLocalStatus("Saved on this computer"); }
      setStatus("Changes saved");
      if (leaveAfterSave.current) { const leave = leaveAfterSave.current; leaveAfterSave.current = null; leave(); }
    } catch (cause) {
      const message = String(cause);
      setError(message);
      if (message.toLowerCase().includes("changed on another computer")) void refreshWorkspace();
    } finally { setSaving(false); }
  };

  const reloadRemote = () => {
    if (remote?.config) {
      setSaved(remote.config); setDraft(remote.config); onSaved(workspaceRoot, remote.config);
      setRemote(null); setError(""); setStatus("Shared settings reloaded");
    } else void refreshWorkspace();
  };

  const discardDraft = () => {
    setDraft(saved ? clone(saved) : null); setLocalDraft(localMappings); setImportDraft(null); setError(""); setStatus(""); setGuardOpen(false);
    if (leaveAfterSave.current) { const leave = leaveAfterSave.current; leaveAfterSave.current = null; leave(); }
  };

  const restoreHistory = async () => {
    if (!historyChoice || !saved || !confirm("Restore the selected shared settings for everyone using this workspace? Existing client folders and media will not be changed.")) return;
    try {
      const result = await invoke<WorkspaceConfig>("workspace_restore", { root: workspaceRoot, fileName: historyChoice, expectedRevision: saved.revision, expectedHash: saved.contentHash });
      setSaved(result); setDraft(result); setHistoryChoice(""); onSaved(workspaceRoot, result); setStatus("Previous configuration restored as a new revision");
    } catch (cause) { setError(String(cause)); }
  };

  const resetToStarter = async () => {
    if (!saved || !confirm(`Reset shared settings for everyone using ${workspaceRoot} to the current Pepper setup? Existing client folders and media will not be changed.`)) return;
    try {
      const next = await invoke<WorkspaceConfig>("workspace_starter", { root: workspaceRoot, displayName: saved.displayName, projectShowNames: saved.projectShowNames });
      next.workspaceId = saved.workspaceId; next.revision = saved.revision; next.contentHash = saved.contentHash;
      setDraft(next); setPage("overview"); setStatus("Starter settings loaded for review. Save changes to apply them.");
    } catch (cause) { setError(String(cause)); }
  };

  const exportWorkspace = async () => {
    if (!saved) return;
    try {
      const path = await save({ title: "Export workspace settings", defaultPath: `pepper-workspace-v${saved.schemaVersion}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await invoke("workspace_export", { root: workspaceRoot, path }); setStatus("Saved configuration exported");
    } catch (cause) { setError(String(cause)); }
  };

  const loadHistory = async () => {
    try { setHistory(await invoke<WorkspaceHistoryEntry[]>("workspace_history", { root: workspaceRoot })); setHistoryLoaded(true); }
    catch (cause) { setError(String(cause)); }
  };

  const saveLocalMappings = async () => {
    try { await onLocalMappingsSave(localDraft); setLocalStatus("Saved on this computer"); }
    catch (cause) { setLocalStatus(`Could not save local paths: ${String(cause)}`); }
  };

  const chooseLocalResource = async (resourceId: string) => {
    try {
      const path = await open({ multiple: false, title: "Choose a Premiere project template", filters: [{ name: "Premiere project", extensions: ["prproj"] }] });
      if (typeof path === "string") setLocalDraft((current) => ({ ...current, [resourceId]: path }));
    } catch (cause) { setLocalStatus(`Could not choose a local file: ${String(cause)}`); }
  };
  const chooseSharedResource = async (resourceId: string) => {
    try {
      const path = await open({ multiple: false, title: "Choose a Premiere template inside this workspace", filters: [{ name: "Premiere project", extensions: ["prproj"] }] });
      if (typeof path !== "string") return;
      const prefix = workspaceRoot.replace(/[\\/]+$/, "");
      if (!path.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`) && !path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
        setError("Shared templates must be stored inside the selected workspace. Use a local mapping for a file on this computer."); return;
      }
      const relativePath = path.slice(prefix.length + 1).replace(/\\/g, "/");
      updateDraft((current) => ({ ...current, resources: current.resources.map((resource) => resource.id === resourceId ? { ...resource, relativePath } : resource) }));
    } catch (cause) { setError(`Could not choose a shared file: ${String(cause)}`); }
  };

  const editType = (id: string, mutate: (type: WorkspaceConfig["clientTypes"][number]) => WorkspaceConfig["clientTypes"][number]) => updateDraft((current) => ({ ...current, clientTypes: current.clientTypes.map((type) => type.id === id ? mutate(type) : type) }));
  const addType = () => {
    if (!draft) return;
    const id = makeId("client-type");
    const next = { id, name: "New type", folderTemplateId: draft.folderTemplates[0]?.id ?? "standard", features: [], featureOptions: {} };
    updateDraft((current) => ({ ...current, clientTypes: [...current.clientTypes, next] })); setSelectedTypeId(id); setTypeDetailsOpen(true);
  };
  const duplicateType = (typeId: string) => {
    if (!draft) return;
    const source = draft.clientTypes.find((item) => item.id === typeId); if (!source) return;
    const duplicate = { ...clone(source), id: makeId("client-type"), name: `${source.name} copy` };
    updateDraft((current) => ({ ...current, clientTypes: [...current.clientTypes, duplicate] })); setSelectedTypeId(duplicate.id); setTypeDetailsOpen(true);
  };
  const removeType = (typeId: string) => {
    if (!draft) return;
    const referenced = draft.profiles.some((profile) => profile.allowedClientTypeIds.includes(typeId));
    if (referenced) { setError("Remove this type from every project profile before deleting it."); return; }
    const type = draft.clientTypes.find((item) => item.id === typeId);
    if (!type || !confirm(`Remove ${type.name} from future client creation? Existing clients remain unchanged.`)) return;
    updateDraft((current) => ({ ...current, clientTypes: current.clientTypes.filter((item) => item.id !== typeId) }));
    setSelectedTypeId(draft.clientTypes.find((item) => item.id !== typeId)?.id ?? "");
  };

  const updateProfile = (id: string, mutate: (profile: WorkspaceConfig["profiles"][number]) => WorkspaceConfig["profiles"][number]) => updateDraft((current) => ({ ...current, profiles: current.profiles.map((profile) => profile.id === id ? mutate(profile) : profile) }));
  const addProfile = () => {
    if (!draft || !draft.clientTypes.length) { setError("Add a client type before creating a profile."); return; }
    const type = draft.clientTypes[0]; const id = makeId("profile");
    updateDraft((current) => ({ ...current, profiles: [...current.profiles, { id, name: "New profile", projectIds: [], allowedClientTypeIds: [type.id], defaultClientTypeId: type.id }] }));
    setSelectedProfileId(id);
  };
  const removeProfile = (id: string) => {
    if (!draft) return;
    const profile = draft.profiles.find((item) => item.id === id);
    if (!profile || profile.projectIds.length) { setError("Move this profile's projects to another profile before deleting it."); return; }
    if (draft.profiles.length < 2) { setError("A workspace must keep at least one project profile."); return; }
    if (!confirm(`Remove ${profile.name}? Project folders and clients will remain unchanged.`)) return;
    updateDraft((current) => ({ ...current, profiles: current.profiles.filter((item) => item.id !== id) }));
    setSelectedProfileId(draft.profiles.find((item) => item.id !== id)?.id ?? "");
  };

  const updateFolder = (templateId: string, folderId: string, mutate: (folder: WorkspaceFolder) => WorkspaceFolder) => updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.map((template) => template.id === templateId ? { ...template, folders: template.folders.map((folder) => folder.id === folderId ? mutate(folder) : folder) } : template) }));
  const moveFolder = (index: number, delta: number) => {
    if (!activeTemplate || !draft) return;
    const target = index + delta; if (target < 0 || target >= activeTemplate.folders.length) return;
    const folders = [...activeTemplate.folders]; [folders[index], folders[target]] = [folders[target], folders[index]];
    updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.map((template) => template.id === activeTemplate.id ? { ...template, folders } : template) }));
  };
  const addFolder = () => {
    if (!activeTemplate) return;
    const folder: WorkspaceFolder = { id: makeId("folder"), path: "New Folder", purpose: "other", enabled: true, required: false };
    updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.map((template) => template.id === activeTemplate.id ? { ...template, folders: [...template.folders, folder] } : template) }));
  };
  const addFolderTemplate = () => {
    if (!draft) return;
    const source = activeTemplate ?? draft.folderTemplates[0];
    if (!source) return;
    const id = makeId("folder-template");
    const template = { ...clone(source), id, name: `${source.name} copy`, folders: source.folders.map((folder) => ({ ...folder, id: makeId("folder") })) };
    updateDraft((current) => ({ ...current, folderTemplates: [...current.folderTemplates, template] }));
    setSelectedTemplateId(id);
  };
  const removeFolderTemplate = (id: string) => {
    if (!draft || draft.folderTemplates.length < 2) return;
    const template = draft.folderTemplates.find((item) => item.id === id);
    if (!template) return;
    if (draft.clientTypes.some((type) => type.folderTemplateId === id)) { setError("Choose another folder structure for every client type using this one before deleting it."); return; }
    if (!confirm(`Remove ${template.name}? Existing client folders will remain unchanged.`)) return;
    updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.filter((item) => item.id !== id) }));
    setSelectedTemplateId(draft.folderTemplates.find((item) => item.id !== id)?.id ?? "");
  };

  const profilePreview = useMemo(() => {
    if (!draft || !previewProjectId) return null;
    const profile = draft.profiles.find((item) => item.projectIds.includes(previewProjectId)) ?? draft.profiles.find((item) => item.id === "fallback") ?? draft.profiles.find((item) => item.projectIds.length === 0);
    const project = draft.projects.find((item) => item.id === previewProjectId);
    const type = draft.clientTypes.find((item) => item.id === profile?.defaultClientTypeId);
    if (!project || !profile || !type) return null;
    return { project, profile, type, path: `${workspaceRoot.replace(/[\\/]+$/, "")}\\${project.relativePath}\\${sampleClient.trim() || "Sample Client"}` };
  }, [draft, previewProjectId, sampleClient, workspaceRoot]);

  const canSaveLocal = localDirty;
  const locationStage = setup && setupStep === "location";
  const startStage = setup && setupStep === "starting";
  const reviewStage = setup && setupStep === "review";

  return <div className="workspace-settings-view">
    {setup && setupStep !== "editor" ? <>
      <div className="workspace-setup-heading"><span>Workspace setup</span><p>Step {locationStage ? "1" : startStage ? "2" : "3"} of 3</p></div>
      {locationStage && <section className="settings-group">
        <h4>Location</h4>
        <p className="workspace-scope">Choose the folder that contains Pepper's project folders. Setup only reads this folder until you save.</p>
        <div className="workspace-path-choice"><label>Workspace folder<input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} aria-label="Workspace folder" /></label><button className="ghost" type="button" onClick={() => void chooseRoot()}><FolderOpen size={14}/> Choose folder</button></div>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        <div className="workspace-actions"><button type="button" className="primary" disabled={!workspaceRoot} onClick={() => void continueFromLocation()}>Continue</button></div>
      </section>}
      {startStage && <section className="settings-group">
        <h4>Starting point</h4><p className="workspace-scope">Use familiar Pepper settings as a base, then customize supported options.</p>
        <div className="workspace-choice-row"><div><strong>Use current Pepper setup</strong><small>Start with today's types, project rules, and folders.</small></div><button className="primary" type="button" onClick={() => void makeStarter(false)}>Use current setup</button></div>
        <div className="workspace-choice-row"><div><strong>Customize</strong><small>Start from the current setup and edit it before saving.</small></div><button className="ghost" type="button" onClick={() => void makeStarter(true)}>Customize</button></div>
        <div className="settings-actions"><button className="ghost" type="button" onClick={() => void openImport()}>Import configuration</button><button className="ghost" type="button" onClick={() => setSetupStep("location")}>Back</button></div>
        {importDraft && <div className="workspace-import-preview"><strong>Import review</strong><p>Replaces settings for {workspaceRoot}. {importDraft.clientTypes.length} client types, {importDraft.profiles.length} profiles, {importDraft.folderTemplates.length} folder templates.</p><p>Existing client folders and media will not be changed.</p><button type="button" className="primary" onClick={applyImport}>Review imported settings</button></div>}
        {error && <p className="workspace-error" role="alert">{error}</p>}
      </section>}
      {reviewStage && draft && <section className="settings-group">
        <h4>Review setup</h4><p className="workspace-scope">Settings will be shared with everyone using this folder.</p>
        {importReviewSummary && <div className="workspace-import-preview"><strong>Import replaces settings for {workspaceRoot}</strong><ul>{importReviewSummary.map((line) => <li key={line}>{line}</li>)}</ul><p>Existing client folders and media will not be changed.</p><p>Resolve local resource mappings on this computer after setup.</p></div>}
        <dl className="workspace-summary"><div><dt>Workspace</dt><dd>{workspaceRoot}</dd></div><div><dt>Client types</dt><dd>{draft.clientTypes.map((type) => type.name).join(", ")}</dd></div><div><dt>Project profiles</dt><dd>{draft.profiles.length}</dd></div><div><dt>Folder structure</dt><dd>{draft.folderTemplates[0]?.name ?? "None"}</dd></div><div><dt>Project catalog</dt><dd>{draft.projectShowNames.length} name choices</dd></div></dl>
        <section className="workspace-new-client-preview"><h5>New client example</h5><p><strong>Destination:</strong> {profilePreview?.path ?? `${workspaceRoot.replace(/[\\/]+$/, "")}\\Sample Client`}</p><p><strong>Client types:</strong> {profilePreview?.profile.allowedClientTypeIds.map((id) => draft.clientTypes.find((type) => type.id === id)?.name).filter(Boolean).join(", ") || draft.clientTypes.map((type) => type.name).join(", ")}</p><p><strong>Enabled features:</strong> {profilePreview?.type.features.map((feature) => WORKSPACE_FEATURES.find((item) => item.id === feature)?.title).filter(Boolean).join(", ") || "Shown by client type in the editor"}</p><p><strong>Folders:</strong> {(draft.folderTemplates[0]?.folders ?? []).filter((folder) => folder.enabled).map((folder) => folder.path).join(", ")}</p></section>
        <div className="settings-actions"><button type="button" className="ghost" onClick={() => setSetupStep("starting")}>Back</button><button type="button" className="ghost" onClick={() => { setSetupStep("editor"); setPage("types"); }}>Edit client types</button><button type="button" className="ghost" onClick={() => { setSetupStep("editor"); setPage("profiles"); }}>Edit profiles</button><button type="button" className="ghost" onClick={() => { setSetupStep("editor"); setPage("folders"); }}>Edit folders</button><button type="button" className="primary" disabled={!writable} onClick={() => void saveWorkspace()}>{saving ? "Saving…" : "Save workspace"}</button></div>
        <p className="workspace-scope">Saves settings in this folder for everyone using it.</p>
        {error && <p className="workspace-error" role="alert">{error}</p>}
      </section>}
    </> : <>
      <header className="workspace-editor-heading">
        {page !== "overview" && <button type="button" className="workspace-back" aria-label="Back to workspace" title="Back to workspace" onClick={() => navigate("overview")}><ArrowLeft size={16}/></button>}
        <div><h3>{currentPage.title}</h3><p>{currentPage.description}</p></div>
        {!writable && <span className="workspace-readonly">Read-only</span>}
      </header>
      <div className="workspace-editor-layout">
        <div className="workspace-editor-content" key={page}>
          {remote?.status === "valid" && remote.config && (remote.config.revision !== saved?.revision || remote.config.contentHash !== saved?.contentHash) && <div className="workspace-remote" role="status"><span>Workspace settings changed on another computer.</span><div><button type="button" className="ghost" onClick={() => { setImportDraft(remote.config); setImportPath("Remote revision"); }}>Review changes</button><button type="button" className="ghost" onClick={() => requestLeave(reloadRemote)}>Reload shared settings</button></div></div>}
          {saved && remote && remote.status !== "valid" && <div className="workspace-remote" role="status"><span>{remote.message ?? (remote.status === "unavailable" ? "Workspace is unavailable. Showing the last validated settings." : "Workspace settings need attention.")}</span><button type="button" className="ghost" onClick={() => void refreshWorkspace()}><RefreshCw size={13}/> Retry</button></div>}
          {saved && remote?.lock && <div className="workspace-remote" role="status"><span>{remote.lock.canOfferRecovery ? "An old workspace save lock was found. Confirm that no one is saving on another computer before manually moving workspace.lock out of .pepper, then retry." : "A workspace save is in progress. Shared changes remain unavailable until it finishes."}<code>{remote.lock.content}</code></span><button type="button" className="ghost" onClick={() => void refreshWorkspace()}><RefreshCw size={13}/> Retry</button></div>}
          {importDraft && setupStep === "editor" && <div className="workspace-import-preview"><strong>Review import {importPath ? `from ${importPath.split(/[\\/]/).pop()}` : ""}</strong><p>Replaces the saved configuration for <b>{workspaceRoot}</b>. Existing client folders and media will not be changed.</p><ul>{importSummary(saved, importDraft).map((line) => <li key={line}>{line}</li>)}</ul><p>Unresolved local resource paths stay on this computer and block only dependent actions.</p><div className="settings-actions"><button className="ghost" type="button" onClick={() => setImportDraft(null)}>Cancel</button><button className="primary" type="button" onClick={applyImport}>Review imported settings</button></div></div>}

          {page === "overview" && draft && <>
            <section className="workspace-location"><div><span>Workspace folder</span><p>{workspaceRoot}</p></div><button type="button" className="ghost" onClick={() => requestLeave(() => void chooseRoot())}><FolderOpen size={13}/> Change</button></section>
            <div className="workspace-destinations">
              <button type="button" onClick={() => navigate("types")}><SlidersHorizontal size={16}/><span><strong>Client types</strong><span>Choose the tools each type uses.</span></span><ChevronRight size={14}/></button>
              <button type="button" onClick={() => navigate("profiles")}><ListFilter size={16}/><span><strong>Project rules</strong><span>Choose the client types available in each project.</span></span><ChevronRight size={14}/></button>
            </div>
            <details className="workspace-more"><summary>More settings</summary><div className="workspace-destinations workspace-secondary-destinations">{pages.filter((item) => ["folders", "resources", "catalog", "recovery"].includes(item.id)).map(({ id, title, icon: Icon }) => <button type="button" key={id} onClick={() => navigate(id)}><Icon size={15}/><span><strong>{title}</strong></span><ChevronRight size={14}/></button>)}</div></details>
          </>}
          {page === "catalog" && draft && <>
            <section className="settings-group"><h4>Project catalog</h4><p className="workspace-scope">Shared names offered when creating a new project folder.</p><div className="workspace-project-show-add"><input value={newProjectShowName} onChange={(event) => setNewProjectShowName(event.target.value)} placeholder="Add project name" aria-label="Add project name" disabled={!writable}/><button type="button" className="ghost" disabled={!writable || !newProjectShowName.trim() || draft.projectShowNames.some((name) => name.toLowerCase() === newProjectShowName.trim().toLowerCase())} onClick={() => { const name = newProjectShowName.trim(); if (!name) return; updateDraft((current) => ({ ...current, projectShowNames: [...current.projectShowNames, name].sort((a, b) => a.localeCompare(b)) })); setNewProjectShowName(""); }}><Plus size={13}/> Add</button></div><div className="workspace-project-list">{draft.projectShowNames.map((name) => <div className="workspace-project-show" key={name}><span>{name}</span><button type="button" aria-label={`Remove ${name}`} title={`Remove ${name}`} disabled={!writable} onClick={() => updateDraft((current) => ({ ...current, projectShowNames: current.projectShowNames.filter((item) => item !== name) }))}><X size={13}/></button></div>)}</div></section>
          </>}
          {page === "recovery" && draft && <>
            <section className="settings-group"><h4>Backup &amp; restore</h4><p className="workspace-scope">These actions affect settings only. Project folders and media stay unchanged.</p><div className="settings-actions"><button type="button" className="ghost" onClick={() => void openImport()} disabled={!writable}>Import</button><button type="button" className="ghost" onClick={() => void exportWorkspace()} disabled={!saved}>Export saved settings</button><button type="button" className="ghost" onClick={() => void loadHistory()}><History size={13}/> Recovery history</button></div>
              {historyLoaded && history.length === 0 && <p className="workspace-scope" role="status">No previous configurations yet.</p>}
              {history.length > 0 && <div className="workspace-history-row"><label>Previous configuration<select value={historyChoice} onChange={(event) => setHistoryChoice(event.target.value)}><option value="">Choose a revision</option>{history.map((entry) => <option key={entry.fileName} value={entry.fileName}>Revision {entry.revision} · {entry.modified ?? "date unavailable"}</option>)}</select></label><button type="button" className="ghost" disabled={!historyChoice || !writable} onClick={() => void restoreHistory()}>Restore</button></div>}
              {saved && <details className="workspace-reset"><summary>Reset to current Pepper setup</summary><p>Replaces shared settings for everyone using this folder. Existing client folders and media will not be changed.</p><button type="button" className="ghost" disabled={!writable} onClick={() => void resetToStarter()}><RotateCcw size={13}/> Review reset</button></details>}
            </section>
          </>}
          {page === "resources" && draft && <>
            <section className="settings-group"><h4>Shared resources</h4><p className="workspace-scope">Shared template files must be inside this workspace. These paths are saved with the shared configuration.</p>{draft.resources.map((resource) => <label className="workspace-resource-row" key={resource.id}>{resource.name}<span className="workspace-local-path"><input value={resource.relativePath ?? ""} disabled={!writable} onChange={(event) => updateDraft((current) => ({ ...current, resources: current.resources.map((item) => item.id === resource.id ? { ...item, relativePath: event.target.value || null } : item) }))} placeholder="Workspace-relative path, for example Templates/master.prproj"/><button type="button" className="ghost" disabled={!writable} onClick={() => void chooseSharedResource(resource.id)}>Browse</button></span></label>)}</section>
            <section className="settings-group"><h4>On this computer</h4><details className="workspace-local-mappings"><summary>Local resource paths</summary><p>These paths stay on this computer and do not change shared feature choices.</p>{draft.resources.map((resource) => <label key={resource.id}>{resource.name}<span className="workspace-local-path"><input value={localDraft[resource.id] ?? ""} onChange={(event) => setLocalDraft((current) => ({ ...current, [resource.id]: event.target.value }))} placeholder="Choose a local .prproj file"/><button type="button" className="ghost" onClick={() => void chooseLocalResource(resource.id)}>Browse</button></span></label>)}<div className="settings-actions"><button type="button" className="ghost" disabled={!canSaveLocal} onClick={() => void saveLocalMappings()}>Save on this computer</button><span className="settings-feedback" role="status">{localStatus}</span></div></details></section>
          </>}

          {page === "types" && draft && <div className="workspace-types-layout">
            <div className="workspace-item-picker"><label>Client type<select value={activeType?.id ?? ""} onChange={(event) => { setSelectedTypeId(event.target.value); setTypeDetailsOpen(false); }}>{draft.clientTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label><button type="button" className="ghost" disabled={!writable} onClick={addType}><Plus size={13}/> Add type</button></div>
            {activeType && <fieldset className="workspace-detail-panel" key={activeType.id} disabled={!writable}>
              {WORKSPACE_FEATURES.map((feature) => { const enabled = activeType.features.includes(feature.id); return <div className="workspace-feature-row" key={feature.id}><label className="workspace-feature-toggle"><input type="checkbox" checked={enabled} onChange={(event) => editType(activeType.id, (type) => ({ ...type, features: event.target.checked ? [...type.features, feature.id] : type.features.filter((item) => item !== feature.id), featureOptions: event.target.checked ? type.featureOptions : Object.fromEntries(Object.entries(type.featureOptions).filter(([key]) => key !== feature.id)) }))}/><span><strong>{feature.title}</strong><small>{feature.description}</small></span></label>
                {enabled && feature.id === "premiere_project" && <details className="workspace-template-options"><summary>Interview templates</summary><fieldset className="workspace-feature-option"><legend className="workspace-sr-only">Interview templates</legend>{[{ id: "standard", title: "Standard interview" }, { id: "video_call", title: "Video call interview" }].map((option) => <label key={option.id}><input type="checkbox" checked={(activeType.featureOptions.premiere_project ?? []).includes(option.id)} onChange={(event) => editType(activeType.id, (type) => ({ ...type, featureOptions: { ...type.featureOptions, premiere_project: event.target.checked ? [...(type.featureOptions.premiere_project ?? []), option.id] : (type.featureOptions.premiere_project ?? []).filter((id) => id !== option.id) } }))}/>{option.title}</label>)}</fieldset></details>}

</div>; })}
              <details className="workspace-manage" open={typeDetailsOpen} onToggle={(event) => setTypeDetailsOpen(event.currentTarget.open)}><summary>Name &amp; folder structure</summary><div className="workspace-detail-panel"><label>Type name<input value={activeType.name} onChange={(event) => editType(activeType.id, (type) => ({ ...type, name: event.target.value }))}/></label><label>Folder structure<select value={activeType.folderTemplateId} onChange={(event) => editType(activeType.id, (type) => ({ ...type, folderTemplateId: event.target.value }))}>{draft.folderTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
              <div className="settings-actions"><button type="button" className="ghost" disabled={!writable} onClick={() => duplicateType(activeType.id)}><Copy size={13}/> Duplicate</button><button type="button" className="ghost" disabled={!writable || draft.clientTypes.length <= 1} onClick={() => removeType(activeType.id)}><Trash2 size={13}/> Remove type</button></div></div></details>
            </fieldset>}
          </div>}

          {page === "profiles" && draft && <div className="workspace-types-layout">
            <div className="workspace-item-picker"><label>Project rule<select value={activeProfile?.id ?? ""} onChange={(event) => setSelectedProfileId(event.target.value)}>{draft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><button type="button" className="ghost" disabled={!writable} onClick={addProfile}><Plus size={13}/> Add rule</button></div>
            {activeProfile && <fieldset className="workspace-detail-panel" disabled={!writable}>
              <h5>Allowed client types</h5><div className="workspace-project-list">{draft.clientTypes.map((type) => <label key={type.id}><input type="checkbox" checked={activeProfile.allowedClientTypeIds.includes(type.id)} onChange={(event) => updateProfile(activeProfile.id, (profile) => { const allowed = event.target.checked ? [...profile.allowedClientTypeIds, type.id] : profile.allowedClientTypeIds.filter((id) => id !== type.id); return { ...profile, allowedClientTypeIds: allowed, defaultClientTypeId: allowed.includes(profile.defaultClientTypeId) ? profile.defaultClientTypeId : allowed[0] ?? "" }; })}/><span>{type.name}</span></label>)}</div>
              <label>Default client type<select value={activeProfile.defaultClientTypeId} onChange={(event) => updateProfile(activeProfile.id, (profile) => ({ ...profile, defaultClientTypeId: event.target.value }))}><option value="">Choose a default</option>{draft.clientTypes.filter((type) => activeProfile.allowedClientTypeIds.includes(type.id)).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><details className="workspace-manage"><summary>Name &amp; assigned projects</summary><div className="workspace-detail-panel"><label>Rule name<input value={activeProfile.name} onChange={(event) => updateProfile(activeProfile.id, (profile) => ({ ...profile, name: event.target.value }))}/></label>
              <h5>Assigned projects</h5><div className="workspace-project-list">{draft.projects.map((project) => <label key={project.id}><input type="checkbox" checked={activeProfile.projectIds.includes(project.id)} onChange={(event) => updateProfile(activeProfile.id, (profile) => ({ ...profile, projectIds: event.target.checked ? [...profile.projectIds, project.id] : profile.projectIds.filter((id) => id !== project.id) }))}/><span>{project.name}</span></label>)}</div>
<div className="settings-actions"><button type="button" className="ghost" disabled={!writable || activeProfile.projectIds.length > 0 || draft.profiles.length < 2} onClick={() => removeProfile(activeProfile.id)}><Trash2 size={13}/> Remove rule</button></div></div></details>
            </fieldset>}
            <details className="workspace-preview"><summary>Preview client creation</summary><label>Project<select value={previewProjectId} onChange={(event) => setPreviewProjectId(event.target.value)}>{draft.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{profilePreview && <p>{profilePreview.profile.name}: {profilePreview.profile.allowedClientTypeIds.map((id) => draft.clientTypes.find((type) => type.id === id)?.name).filter(Boolean).join(", ")}<br/>Default: {profilePreview.type.name}<br/>Destination: {profilePreview.path}</p>}</details>
          </div>}

          {page === "folders" && draft && <fieldset className="workspace-folder-editor" disabled={!writable}><label>Folder structure<select value={activeTemplate?.id ?? ""} onChange={(event) => setSelectedTemplateId(event.target.value)}>{draft.folderTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>{activeTemplate && <label>Structure name<input value={activeTemplate.name} onChange={(event) => updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.map((template) => template.id === activeTemplate.id ? { ...template, name: event.target.value } : template) }))}/></label>}<div className="settings-actions"><button type="button" className="ghost" disabled={!writable} onClick={addFolderTemplate}><Copy size={13}/> Duplicate structure</button><button type="button" className="ghost" disabled={!writable || draft.folderTemplates.length < 2 || draft.clientTypes.some((type) => type.folderTemplateId === activeTemplate?.id)} onClick={() => activeTemplate && removeFolderTemplate(activeTemplate.id)}><Trash2 size={13}/> Remove structure</button></div>
            <div className="workspace-list-heading"><strong>{activeTemplate?.name ?? "Folders"}</strong><button type="button" className="ghost" disabled={!writable} onClick={addFolder}><Plus size={14}/> Add folder</button></div>
            <div className="workspace-folder-tree">{activeTemplate?.folders.map((folder, index) => <div className={`workspace-folder-row${folder.required ? " required" : ""}`} key={folder.id}><label className="workspace-folder-path"><span>{folder.required ? "Required by Pepper" : folder.purpose.replace(/_/g, " ")}</span><input aria-label="Relative folder path" value={folder.path} disabled={folder.required} onChange={(event) => updateFolder(activeTemplate.id, folder.id, (item) => ({ ...item, path: event.target.value }))}/>{folderIssue(folder.path) && <small className="workspace-error">{folderIssue(folder.path)}</small>}</label><label className="workspace-purpose">Purpose<select value={folder.purpose} disabled={folder.required} onChange={(event) => updateFolder(activeTemplate.id, folder.id, (item) => ({ ...item, purpose: event.target.value }))}><option value="other">Other</option><option value="media">Media</option><option value="video_proxy">Video proxy</option><option value="video_raw">Raw video</option><option value="audio_clean">Clean audio</option><option value="audio_raw">Raw audio</option><option value="stills">Stills</option><option value="music">Music</option><option value="graphics">Graphics</option><option value="edit">Edit</option><option value="exports">Exports</option><option value="approval">Approval</option><option value="clips">Clips</option><option value="final">Final</option></select></label><label className="workspace-folder-enabled"><input type="checkbox" checked={folder.enabled} disabled={folder.required} onChange={(event) => updateFolder(activeTemplate.id, folder.id, (item) => ({ ...item, enabled: event.target.checked }))}/>Enabled</label><div className="workspace-folder-actions"><button type="button" aria-label="Move folder up" title="Move up" disabled={!writable || index === 0} onClick={() => moveFolder(index, -1)}><ArrowUp size={14}/></button><button type="button" aria-label="Move folder down" title="Move down" disabled={!writable || index === activeTemplate.folders.length - 1} onClick={() => moveFolder(index, 1)}><ArrowDown size={14}/></button><button type="button" aria-label="Remove folder" title="Remove folder" disabled={!writable || folder.required} onClick={() => updateDraft((current) => ({ ...current, folderTemplates: current.folderTemplates.map((template) => template.id === activeTemplate.id ? { ...template, folders: template.folders.filter((item) => item.id !== folder.id) } : template) }))}><Trash2 size={14}/></button></div></div>)}</div>
            <details className="workspace-new-client-preview"><summary>Preview folder structure</summary><label>Sample client name<input value={sampleClient} onChange={(event) => setSampleClient(event.target.value)}/></label><p>Destination: <strong>{profilePreview?.path ?? `${workspaceRoot}\\${sampleClient}`}</strong></p><ul>{activeTemplate?.folders.filter((folder) => folder.enabled).map((folder) => <li key={folder.id}>{folder.path}</li>)}</ul><small>New clients use this structure. Existing folders stay unchanged.</small></details>
          </fieldset>}

          {error && <p className="workspace-error" role="alert">{error}</p>}{status && <p className="settings-feedback" role="status">{status}</p>}
        </div>
      </div>
      <footer className="workspace-editor-footer"><span className="workspace-save-state" role="status">{dirty ? "Unsaved changes" : ""}</span><button type="button" className="ghost" disabled={!dirty || saving} onClick={discardDraft}>Discard changes</button><button type="button" className="primary" disabled={!dirty || (sharedDirty && !writable) || saving} onClick={() => void saveWorkspace()}><SaveIcon size={13}/>{saving ? "Saving…" : "Save changes"}</button></footer>
    </>}

    {guardOpen && <dialog ref={guardDialog} className="workspace-guard" aria-labelledby="workspace-guard-title" onCancel={(event) => { event.preventDefault(); leaveAfterSave.current = null; setGuardOpen(false); }}><h4 id="workspace-guard-title">Unsaved workspace changes</h4><p>Save your changes before leaving?</p><div className="settings-actions"><button type="button" className="ghost" onClick={() => { leaveAfterSave.current = null; setGuardOpen(false); }}>Keep editing</button><button type="button" className="ghost" onClick={discardDraft}>Discard</button><button type="button" className="primary" disabled={(sharedDirty && !writable) || saving} onClick={() => { setGuardOpen(false); void saveWorkspace(); }}>Save</button></div></dialog>}
  </div>;
}

