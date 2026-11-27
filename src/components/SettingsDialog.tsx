import { createContext, useContext, useEffect, useMemo, useRef, type PointerEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderCog, Plug, Settings2, Users, Wrench, X } from "lucide-react";
import "./SettingsDialog.css";

export type SettingsSection = "general" | "integrations" | "people" | "advanced" | "workspace";
type Leave = () => void;
type CloseGuardContextValue = { register: (handler: (leave?: Leave) => void) => () => void };
const CloseGuardContext = createContext<CloseGuardContextValue | null>(null);
export function useSettingsCloseGuard(handler: (leave?: Leave) => void) {
  const context = useContext(CloseGuardContext);
  useEffect(() => context?.register(handler), [context, handler]);
}

const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "workspace", label: "Workspace", icon: FolderCog },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "people", label: "People", icon: Users },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const;

export function SettingsDialog({ section, onNavigate, onClose, workspaceAvailable = false, children }: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onClose: () => void;
  workspaceAvailable?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => { content.current?.scrollTo(0, 0); }, [section]);
  const current = sections.find((item) => item.id === section);
  const guardHandler = useRef<((leave?: Leave) => void) | null>(null);
  const requestLeave = (leave: Leave = onClose) => guardHandler.current ? guardHandler.current(leave) : leave();
  const close = () => requestLeave();
  const context = useMemo<CloseGuardContextValue>(() => ({ register: (handler) => {
    guardHandler.current = handler;
    return () => { if (guardHandler.current === handler) guardHandler.current = null; };
  } }), []);
  const visibleSections = sections.filter((item) => item.id !== "workspace" || workspaceAvailable);
  const dragWindow = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startDragging().catch(console.error);
  };
  return (
    <CloseGuardContext.Provider value={context}>
    <dialog ref={dialog} id="pepper-settings" className="pepper-settings" aria-labelledby="pepper-settings-title"
      onCancel={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        // The native modal backdrop intercepts the app title bar. Forward only
        // that strip to the window, leaving the rest of the backdrop inert.
        if (event.target === event.currentTarget && event.clientY < 32 && event.clientX < window.innerWidth - 170) dragWindow(event);
      }}>
      <div className="settings-window-drag-region" onPointerDown={dragWindow} aria-hidden="true" />
      <header className="settings-header" onPointerDown={dragWindow}>
        <h2 id="pepper-settings-title">Settings</h2>
        <button type="button" className="settings-close" onClick={close} aria-label="Close settings" title="Close settings"><X size={17} /></button>
      </header>
      <div className={`settings-layout${section === "workspace" ? " settings-layout-workspace" : ""}`}>
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleSections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? "page" : undefined}
            onClick={() => { if (id !== section) requestLeave(() => onNavigate(id as SettingsSection)); }}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}
        </nav>
        <div className="settings-content" ref={content} key={section}>
          {section !== "workspace" && <header className="settings-page-heading"><h3>{current?.label}</h3></header>}
          {children}
        </div>
      </div>
    </dialog>
    </CloseGuardContext.Provider>
  );
}
