import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Download, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { downloadVerifiedUpdate, type PepperUpdate, type UpdateProgress } from "./updateProgress";
import "./UpdateDialog.css";

interface Props {
  update: PepperUpdate;
  operationActive: boolean;
  onBusyChange: (busy: boolean) => void;
  onDismiss: () => void;
}

export function UpdateDialog({ update, operationActive, onBusyChange, onDismiss }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState(false);
  const [complete, setComplete] = useState(false);
  const busy = progress !== null;

  useEffect(() => { dialog.current?.showModal(); }, []);

  const install = async () => {
    if (running.current || operationActive) return;
    running.current = true;
    onBusyChange(true);
    setError(false);
    try {
      await downloadVerifiedUpdate(update, setProgress);
      setProgress({ phase: "installing", downloaded: 0 });
      // Paint the restart state before the native installer closes Pepper.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await update.install();
      if (update.preview) {
        setComplete(true);
        setProgress(null);
        running.current = false;
        onBusyChange(false);
      }
    } catch (err) {
      console.warn("Pepper update failed", err);
      setError(true);
      setProgress(null);
      running.current = false;
      onBusyChange(false);
    }
  };

  const percent = progress?.total && progress.phase === "downloading"
    ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : undefined;
  const status = progress?.phase === "installing" ? "Restarting" : progress?.phase === "verifying" ? "Verifying" : "Downloading";
  const Icon = complete ? Check : busy ? LoaderCircle : Download;

  return <dialog ref={dialog} className="pepper-update-dialog" aria-labelledby="pepper-update-title"
    onCancel={event => { event.preventDefault(); if (!running.current) onDismiss(); }}>
    <header className="pepper-update-heading">
      <span className="pepper-update-icon"><Icon size={21} strokeWidth={1.6} className={busy ? "spinning" : undefined} aria-hidden="true"/></span>
      <div className="pepper-update-heading-copy">
        <h2 id="pepper-update-title">{complete ? "Pepper updated" : busy ? "Updating Pepper" : "Update Pepper"}</h2>
        <div className="pepper-update-version"><span>{update.currentVersion}</span><ArrowRight size={12} aria-hidden="true"/><strong>{update.version}</strong>{update.preview && <span className="pepper-update-preview">Preview</span>}</div>
      </div>
    </header>
    {busy && <div className="pepper-update-progress" aria-live="polite">
      <div className="pepper-update-status"><span>{status}</span>{percent !== undefined && <span className="pepper-update-percent">{percent}%</span>}</div>
      <progress aria-label={status} max={100} value={percent}/>
    </div>}
    {error && <div className="pepper-update-error" role="alert"><TriangleAlert size={14} aria-hidden="true"/>Update failed</div>}
    {!busy && operationActive && !complete && <div className="pepper-update-status pepper-update-blocked" role="status"><LoaderCircle size={13} aria-hidden="true"/>Operation in progress</div>}
    {!busy && <footer className="pepper-update-actions">
      {complete ? <button type="button" className="pepper-update-primary" onClick={onDismiss}><Check size={14} aria-hidden="true"/>Done</button> : <>
        <button type="button" className="pepper-update-later" onClick={onDismiss}>Later</button>
        <button type="button" className="pepper-update-primary" disabled={operationActive} onClick={() => void install()}>
          {error ? <RefreshCw size={14} aria-hidden="true"/> : <ArrowUpRight size={15} aria-hidden="true"/>}{error ? "Try again" : "Update and restart"}
        </button>
      </>}
    </footer>}
  </dialog>;
}
