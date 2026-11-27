import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, Folder, FolderPlus, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-react";
import "./ClientIssuesDialog.css";

export type ClientIssue = {
  id: string;
  title: string;
  details: string[];
  actionLabel: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
};

function MissingFolderTree({ paths }: { paths: string[] }) {
  const tree = new Map<string, string[]>();
  for (const path of paths) {
    const [root, ...rest] = path.split(/[\\/]/).filter(Boolean);
    if (!root) continue;
    if (!tree.has(root)) tree.set(root, []);
    if (rest.length) tree.get(root)!.push(rest.join(" / "));
  }
  return <ul className="client-issue-folders" aria-label="Missing folders">
    {[...tree].map(([root, children]) => <li key={root}>
      <span className="client-issue-folder"><Folder size={13} aria-hidden="true" /><span>{root}</span></span>
      {children.length > 0 && <ul>{children.map(child => <li key={child}><span>{child}</span></li>)}</ul>}
    </li>)}
  </ul>;
}

export function ClientIssuesDialog({ clientName, issues, onRefresh, onClose }: {
  clientName: string;
  issues: ClientIssue[];
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const run = async (key: string, action: () => void | Promise<void>) => {
    if (working) return;
    setWorking(key);
    setError("");
    try { await action(); }
    catch (err) { setError(String(err)); }
    finally { setWorking(null); }
  };
  return createPortal(<dialog ref={dialog} className="modal client-issues-dialog" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); if (!working) onClose(); }}>
    <div className="client-issues-heading">
      <span className={`client-issues-symbol ${issues.length ? "" : "resolved"}`}>
        {issues.length ? <TriangleAlert size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}
      </span>
      <div><div className="client-issues-title"><h2 id={`${id}-title`}>Client issues</h2></div><p>{clientName}</p></div>
      <button type="button" className="ghost icon-button client-issues-close" aria-label="Close issues" disabled={!!working} onClick={onClose}><X size={16} /></button>
    </div>
    <div className="client-issues-list" aria-busy={!!working}>
      {issues.length ? issues.map(issue => <section className="client-issue" key={issue.id}>
        <div className="client-issue-heading">
          {issue.id === "folders" ? <FolderPlus size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
          <h3>{issue.title}</h3>
          {issue.id === "folders" && <span>{issue.details.length}</span>}
        </div>
        <div className="client-issue-body">
          {issue.id === "folders" ? <MissingFolderTree paths={issue.details} /> : issue.details.map((detail, index) => <p key={index}>{detail}</p>)}
        </div>
        <div className="client-issue-actions">
          <button type="button" className="ghost" disabled={!!working || issue.disabled} onClick={() => void run(issue.id, issue.action)}>
            {working === issue.id ? <LoaderCircle size={13} className="approval-progress-spinner" /> : issue.id === "folders" ? <FolderPlus size={13} /> : <ArrowUpRight size={13} />}
            {working === issue.id ? "Resolving..." : issue.actionLabel}
          </button>
        </div>
      </section>) : <div className="client-issues-resolved" role="status"><Check size={20} aria-hidden="true" /><p>All issues resolved</p></div>}
    </div>
    {error && <p className="client-issues-error" role="alert"><TriangleAlert size={14} aria-hidden="true" />{error}</p>}
    <div className="client-issues-footer">
      <button type="button" className="ghost client-issues-refresh" aria-label={working === "refresh" ? "Checking issues" : "Check again"} title="Check again" disabled={!!working} onClick={() => void run("refresh", onRefresh)}>
        <RefreshCw size={13} className={working === "refresh" ? "approval-progress-spinner" : undefined} aria-hidden="true" />
      </button>
      <button type="button" className="primary" disabled={!!working} onClick={onClose}>Done</button>
    </div>
  </dialog>, document.body);
}
