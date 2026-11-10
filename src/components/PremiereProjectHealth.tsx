import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, File, FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { statusFor, type MediaHealthStatus as Status } from './premiereHealthStatus';
import { mediaKind } from './MediaTypes';
import { CopyMediaPreview } from './CopyMediaPreview';
import './PremiereProjectHealth.css';

type MachineAvailability = { machine_name: string; last_seen: string };
type MediaItem = { file_name: string; original_path: string; resolved_path: string | null; status: string; available_on: MachineAvailability[] };
type HealthReport = { machine_name: string; availability_note: string | null; items: MediaItem[] };
const labels: Record<Status, string> = { local: 'Not on NAS', missing: 'Missing', unavailable: 'Unavailable', moved: 'Moved', copied: 'NAS copy · relink', unknown: 'Needs checking', found: 'Found' };
const hints: Record<Status, string> = {
  local: 'Stored on this computer, not on the NAS. Copy it to the NAS and reconnect it in Premiere.',
  missing: 'Pepper could not find this linked file at its saved location. It is not available to copy from this computer. Check the last known computer or reconnect the drive.',
  unavailable: 'Check the drive connection and folder access, then check again.',
  moved: 'Found in a new location. Premiere may need to reconnect it.',
  copied: 'A verified copy is on the NAS. The project still links to the local path; reconnect it in Premiere to use the shared copy.',
  unknown: 'Open the project in Premiere to check this file.',
  found: 'Available on the NAS.',
};
const roleDestinations: Record<string, string> = {
  'Proxy video': '01_MEDIA/010_VIDEO_PROXY', 'Full-resolution video': '01_MEDIA/020_VIDEO_RAW',
  'Clean audio': '01_MEDIA/030_AUDIO_CLEAN', 'Raw audio': '01_MEDIA/040_AUDIO_RAW',
  Music: '01_MEDIA/060_MUSIC', Stills: '01_MEDIA/050_STILLS', Graphics: '01_MEDIA/070_GRAPHICS', Miscellaneous: '01_MEDIA/080_MISCELLANEOUS', Stock: '01_MEDIA/090_STOCK',
};
const roleOptions: Record<string, string[]> = {
  video: ['Full-resolution video', 'Proxy video', 'Stock'], audio: ['Raw audio', 'Clean audio', 'Music', 'Stock'],
  image: ['Stills', 'Graphics', 'Stock'], other: ['Miscellaneous', 'Stock'],
};
const defaultCopyRole = (path: string) => {
  const kind = mediaKind(path);
  return kind === 'video' ? 'Full-resolution video' : kind === 'audio' ? 'Raw audio' : kind === 'image' ? 'Stills' : 'Miscellaneous';
};
const folderName = (path: string) => path.replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() || path;
function errorCopy(error: string) {
  if (/unsupported|not supported|not readable XML|No supported|XML root|version is missing/i.test(error)) return 'Check this project in Premiere instead.';
  if (/unavailable|Cannot open|Cannot inspect|access.*denied/i.test(error)) return 'Check the project’s drive connection and try again.';
  return 'Try again, or check the project in Premiere.';
}
function peerLabel(peers: MachineAvailability[]) {
  if (!peers.length) return '';
  return peers.length === 1 ? `Last on ${peers[0].machine_name}` : `Last seen on ${peers.length} computers`;
}
function peerTitle(peers: MachineAvailability[]) {
  return peers.map(peer => `${peer.machine_name} · ${new Date(peer.last_seen).toLocaleString()}`).join('\n');
}

export function PremiereProjectHealth({ projectRoot, clientPath, projectPath }: { projectRoot: string; clientPath: string; projectPath: string }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [showFound, setShowFound] = useState(false);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [locationError, setLocationError] = useState('');
  const [openingLocation, setOpeningLocation] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copySelection, setCopySelection] = useState<Set<string>>(new Set());
  const copyDialogRef = useRef<HTMLDialogElement>(null);
  const [copyRoles, setCopyRoles] = useState<Record<string, string>>({});
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copyProgress, setCopyProgress] = useState<{ phase: string; source: string } | null>(null);
  const [copySuccess, setCopySuccess] = useState('');
  const copyListRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setReport(null); setShowFound(false); setQuery(''); setLocationError('');
    void invoke<HealthReport>('premiere_project_health_scan', { projectRoot, clientPath, path: projectPath })
      .then(value => { if (active) setReport(value); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [projectRoot, clientPath, projectPath, attempt]);

  useEffect(() => {
    if (copyOpen) copyDialogRef.current?.showModal();
  }, [copyOpen]);

  useEffect(() => {
    if (!copyBusy) { setCopyProgress(null); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await invoke<{ phase: string; source: string } | null>('ingest_progress', { projectRoot });
        if (active) setCopyProgress(value);
      } catch { /* Copy results remain authoritative when progress is unavailable. */ }
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [copyBusy, projectRoot]);

  async function openLocation(item: MediaItem) {
    const status = statusFor(item.status);
    if ((status === 'missing' || status === 'unavailable') && item.available_on.length > 0) return;
    setOpeningLocation(item.original_path); setLocationError('');
    try {
      const recorded = (item.resolved_path || item.original_path).trim().replace(/\//g, '\\');
      const path = /^(?:[a-z]:[\\/]|\\\\)/i.test(recorded) ? recorded : projectPath.replace(/[^\\/]+$/, '') + recorded;
      await invoke('open_file_location', { path });
    } catch { setLocationError(`Couldn’t open the folder for ${item.file_name}. It may be moved or disconnected.`); }
    finally { setOpeningLocation(null); }
  }

  function startCopyDialog(localItems: MediaItem[]) {
    setCopyError(''); setCopySuccess('');
    setCopySelection(new Set(localItems.map(item => item.original_path)));
    setCopyRoles(Object.fromEntries(localItems.map(item => [item.original_path, defaultCopyRole(item.file_name)])));
    setCopyOpen(true);
  }

  async function copyLocalMedia(localItems: MediaItem[]) {
    const selected = localItems.filter(item => copySelection.has(item.original_path));
    if (!selected.length || copyBusy) return;
    setCopyBusy(true); setCopyError(''); setCopySuccess('');
    try {
      const result = await invoke<{ copied: number; already_present: number }>('ingest_copy_project_media', {
        projectRoot, clientPath,
        files: selected.map(item => ({ source: item.resolved_path || item.original_path, role: copyRoles[item.original_path] || defaultCopyRole(item.file_name) })),
      });
      const total = result.copied + result.already_present;
      if (total !== selected.length) throw new Error('The copy result was incomplete. Check Import media before retrying.');
      setCopySuccess(`${total} ${total === 1 ? 'file is' : 'files are'} verified on NAS${result.already_present ? ` (${result.already_present} already present)` : ''}. Relink in Premiere to use the shared copies.`);
      setCopyOpen(false);
      setAttempt(value => value + 1);
    } catch (reason) {
      setCopyError(`Copy not completed: ${String(reason)} Originals are untouched. Any verified recovery copies remain in Import media; you can retry after resolving the problem.`);
    } finally {
      setCopyBusy(false);
    }
  }

  const items = report?.items || [];
  const rank: Record<Status, number> = { missing: 0, unavailable: 1, local: 2, moved: 3, copied: 4, unknown: 5, found: 6 };
  const issues = items.filter(item => statusFor(item.status) !== 'found')
    .sort((a, b) => rank[statusFor(a.status)] - rank[statusFor(b.status)]);
  const found = items.filter(item => statusFor(item.status) === 'found');
  const localItems = items.filter(item => statusFor(item.status) === 'local');
  const issueStatuses = new Set(issues.map(item => statusFor(item.status)));
  const singleStatus = issueStatuses.size === 1 ? statusFor(issues[0].status) : null;
  const headline = !items.length ? 'No linked media found' : !issues.length ? 'All media on NAS'
    : singleStatus === 'local' ? `${issues.length} ${issues.length === 1 ? 'file stored' : 'files stored'} locally`
    : singleStatus === 'missing' ? `${issues.length} missing ${issues.length === 1 ? 'file' : 'files'}`
    : singleStatus === 'copied' || singleStatus === 'moved' ? `${issues.length} ${issues.length === 1 ? 'file' : 'files'} to relink`
    : `${issues.length} ${issues.length === 1 ? 'file needs' : 'files need'} attention`;
  const displayed = showFound ? found : issues;
  const selectedCount = localItems.filter(item => copySelection.has(item.original_path)).length;
  const clientName = clientPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || clientPath;
  const visible = displayed.filter(item => `${item.file_name} ${item.original_path} ${item.resolved_path || ''} ${report?.machine_name || ''}`.toLowerCase().includes(query.toLowerCase()));
  const showStatus = !showFound && issueStatuses.size > 1;

  return <section className="pph-panel" aria-labelledby={headingId} aria-busy={busy}>
      <header className="pph-header">
        <h3 id={headingId} title={projectPath}>Project health</h3>
        <div className="pph-header-actions">
          <button type="button" className="pph-rescan" disabled={busy || copyOpen} onClick={() => setAttempt(value => value + 1)} title="Rescan project media" aria-label="Rescan project media"><RefreshCw size={14} className={busy ? 'pph-spin' : ''}/></button>
        </div>
      </header>
      <div className="pph-body">
        {busy ? <div className="pph-state" role="status"><LoaderCircle className="pph-spin" size={18}/><span>Checking media…</span></div>
          : error ? <p className="pph-error" role="alert">{errorCopy(error)}</p>
          : report ? <>
            <div className={`pph-result ${issues.length ? 'attention' : 'healthy'}`}>
              <div className="pph-result-copy">
                <div className="pph-result-heading" role="status">{issues.length ? <i aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}<strong>{headline}</strong></div>
                <p className="pph-summary-meta">{items.length} {items.length === 1 ? 'linked file' : 'linked files'} &middot; {found.length} on NAS</p>
              </div>
              {localItems.length > 0 && <button type="button" className="pph-copy-button" disabled={busy} onClick={() => startCopyDialog(localItems)}><Copy size={13}/>Copy to NAS</button>}
            </div>
            {showFound && <div className="pph-list-label">On NAS</div>}
            {displayed.length > 0 && <>
              {(issues.length + found.length > 8) && <input className="pph-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a file" aria-label="Find a media file"/>}
              <ul className="pph-media-list" aria-label={showFound ? 'Media files on NAS' : 'Files needing attention'}>
                {visible.map(item => {
                  const status = statusFor(item.status);
                  const path = item.resolved_path || item.original_path;
                  const peerReports = status === 'found' || status === 'copied' ? [] : item.available_on;
                  const remoteOnly = (status === 'missing' || status === 'unavailable') && peerReports.length > 0;
                  return <li className="pph-media-row" key={item.original_path} aria-label={`${item.file_name}: ${labels[status]}${peerReports.length ? `; last seen on ${peerReports.map(peer => peer.machine_name).join(', ')}` : ''}`} title={hints[status]}>
                    <File size={16} className="pph-file-icon" aria-hidden="true"/>
                    <div className="pph-file-name"><strong title={item.file_name}>{item.file_name}</strong><span title={status === 'moved' ? `Saved: ${item.original_path}\nFound: ${path}` : item.original_path}>{folderName(path)}</span></div>
                    {(showStatus || status === 'local' || status === 'copied' || status === 'missing' || peerReports.length > 0) && <span className={`pph-file-status ${status}`} title={status === 'local' ? `${hints[status]} Available on ${report.machine_name}.` : peerReports.length ? `${hints[status]} Last known on:\n${peerTitle(peerReports)}` : hints[status]}>{status === 'local' ? `Local · ${report.machine_name}` : status === 'missing' ? item.status === 'missing_nas' ? 'Not found on NAS' : peerReports.length ? peerLabel(peerReports) : 'Not found here' : peerReports.length ? peerLabel(peerReports) : labels[status]}</span>}
                    <button type="button" className="pph-icon-button" disabled={openingLocation !== null || remoteOnly} title={remoteOnly ? `This file is on another computer (${peerReports.map(peer => peer.machine_name).join(', ')}), so it can't be opened here.` : 'Open file location'} aria-label={remoteOnly ? `File location unavailable here; last seen on ${peerReports.map(peer => peer.machine_name).join(', ')}` : `Open file location for ${item.file_name}`} onClick={() => void openLocation(item)}>{openingLocation === item.original_path ? <LoaderCircle size={14} className="pph-spin"/> : <FolderOpen size={15}/>}</button>
                  </li>;
                })}
              </ul>
              {!visible.length && <p className="pph-empty">No matching files</p>}
            </>}
            {found.length > 0 && <button type="button" className="pph-text-button" aria-pressed={showFound} onClick={() => { setShowFound(value => !value); setQuery(''); }}>{showFound ? issues.length ? 'Show files needing attention' : 'Hide files' : `Show ${found.length} NAS ${found.length === 1 ? 'file' : 'files'}`}</button>}
            {report.availability_note && <p className="pph-feedback" title={report.availability_note}>This check couldn’t be shared with other computers.</p>}
            {copySuccess && <p className="pph-feedback pph-success" role="status">{copySuccess}</p>}
            {copyError && !copyOpen && <p className="pph-feedback" role="alert">{copyError}</p>}
            {locationError && <p className="pph-feedback" role="alert">{locationError}</p>}
          </> : null}
      </div>
      {copyOpen && <dialog ref={copyDialogRef} className="pph-copy-dialog" aria-labelledby="pph-copy-title" aria-describedby="pph-copy-description" onCancel={event => { event.preventDefault(); if (!copyBusy) setCopyOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !copyBusy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setCopyOpen(false); } }}>
          <header><div><h2 id="pph-copy-title">Copy to NAS</h2><p id="pph-copy-description">Choose files and their destination types.</p></div><button type="button" className="pph-rescan" aria-label="Close dialog" disabled={copyBusy} onClick={() => setCopyOpen(false)}><X size={15}/></button></header>
          <div className="pph-copy-toolbar"><div><span>Destination</span><strong title={clientPath}>{clientName}</strong></div><button type="button" className="pph-text-button" disabled={copyBusy} onClick={() => setCopySelection(new Set(selectedCount === localItems.length ? [] : localItems.map(item => item.original_path)))}>{selectedCount === localItems.length ? 'Deselect all' : 'Select all'}</button></div>
          <div className="pph-copy-list" ref={copyListRef} role="list">
            {localItems.map(item => {
              const choices = roleOptions[mediaKind(item.file_name) || 'other'];
              const role = copyRoles[item.original_path] || defaultCopyRole(item.file_name);
              return <div className={`pph-copy-row ${copySelection.has(item.original_path) ? 'selected' : ''}`} role="listitem" key={item.original_path}>
                <label className="pph-copy-file-heading"><input type="checkbox" checked={copySelection.has(item.original_path)} disabled={copyBusy} onChange={event => setCopySelection(current => { const next = new Set(current); if (event.target.checked) next.add(item.original_path); else next.delete(item.original_path); return next; })}/><strong title={item.file_name}>{item.file_name}</strong></label>
                <small className="pph-copy-source" title={item.original_path}>{item.original_path}</small>
                <LazyCopyPreview root={copyListRef} path={item.resolved_path || item.original_path} name={item.file_name}/>
                <label className="pph-copy-destination"><span>Destination type</span><select value={role} disabled={copyBusy || !copySelection.has(item.original_path)} onChange={event => setCopyRoles(current => ({ ...current, [item.original_path]: event.target.value }))}>{choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select><small>{roleDestinations[role]}</small></label>
              </div>;
            })}
          </div>
          <div className="pph-copy-notice" aria-live="polite">{copyError ? <p className="pph-feedback" role="alert">{copyError}</p> : copyBusy ? <p role="status">{copyProgress && ['collecting', 'verifying', 'filing', 'inventorying'].includes(copyProgress.phase) ? `${copyProgress.phase === 'verifying' ? 'Verifying' : copyProgress.phase === 'filing' ? 'Filing' : copyProgress.phase === 'inventorying' ? 'Checking' : 'Copying'} ${copyProgress.source.split(/[\\/]/).pop() || 'selected files'}...` : 'Preparing and verifying selected files...'}</p> : <p>Originals stay untouched. Relink in Premiere after copying.</p>}</div>
          <footer><span className="pph-copy-count" role="status">{selectedCount} of {localItems.length} selected</span><button type="button" className="pph-copy-cancel" autoFocus disabled={copyBusy} onClick={() => setCopyOpen(false)}>Cancel</button><button type="button" className="pph-copy-confirm" disabled={copyBusy || !selectedCount} onClick={() => void copyLocalMedia(localItems)}>{copyBusy ? <><LoaderCircle size={14} className="pph-spin"/>Copying and verifying…</> : <><Copy size={14}/>Copy {selectedCount} {selectedCount === 1 ? 'file' : 'files'} to NAS</>}</button></footer>
      </dialog>}
    </section>;
}

function LazyCopyPreview({root,path,name}:{root:React.RefObject<HTMLDivElement|null>;path:string;name:string}) {
  const element=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false);
  const kind=mediaKind(path);
  useEffect(()=>{
    const node=element.current;
    if(!node)return;
    if(!('IntersectionObserver' in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{
      setVisible(entries.some(entry=>entry.isIntersecting));
    },{root:root.current,rootMargin:'120px'});
    observer.observe(node);
    return()=>observer.disconnect();
  },[root]);
  return <div className="pph-copy-preview" ref={element} aria-label={`Preview of ${name}`}>
    {visible ? <CopyMediaPreview key={path} path={path} name={name}/> : <><div className="pph-copy-canvas"><span>{kind?'Preview loads when visible':'No preview available'}</span></div><div className="pph-copy-playback"/></>}
  </div>;
}
