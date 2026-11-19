import { useEffect, useRef, type ReactNode } from "react";
import { Plug, Settings2, Users, Wrench, X } from "lucide-react";
import "./SettingsDialog.css";

export type SettingsSection = "general" | "integrations" | "people" | "advanced";
const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "people", label: "People", icon: Users },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const;

export function SettingsDialog({ section, onNavigate, onClose, children }: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onClose: () => void;
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
  const current = sections.find((item) => item.id === section)!;
  return (
    <dialog ref={dialog} id="pepper-settings" className="pepper-settings" aria-labelledby="pepper-settings-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      } }}>
      <header className="settings-header">
        <h2 id="pepper-settings-title">Settings</h2>
        <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings" title="Close settings"><X size={17} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? "page" : undefined}
            onClick={() => onNavigate(id)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}
        </nav>
        <div className="settings-content" ref={content} key={section}>
          <header className="settings-page-heading"><h3>{current.label}</h3></header>
          {children}
        </div>
      </div>
    </dialog>
  );
}
