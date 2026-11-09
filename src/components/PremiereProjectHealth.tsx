import { useEffect, useId, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, File, FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { statusFor, type MediaHealthStatus as Status } from './premiereHealthStatus';
import { mediaKind } from './MediaTypes';
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
  Music: '01_MEDIA/060_MUSIC', Stills: '01_MEDIA/050_STILLS', Graphics: '01_MEDIA/070_GRAPHICS', Miscellaneous: '01_MEDIA/080_MISCELLANEOUS',
};
const roleOptions: Record<string, string[]> = {
  video: ['Full-resolution video', 'Proxy video'], audio: ['Raw audio', 'Clean audio', 'Music'],
  image: ['Stills', 'Graphics'], other: ['Miscellaneous'],
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
  const [copySelection, setCopySelection] = useState<Record<string, boolean>>({});
  const [copyRoles, setCopyRoles] = useState<Record<string, string>>({});
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copySuccess, setCopySuccess] = useState('');
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
    setCopySelection(Object.fromEntries(localItems.map(item => [item.original_path, true])));
    setCopyRoles(Object.fromEntries(localItems.map(item => [item.original_path, defaultCopyRole(item.file_name)])));
    setCopyOpen(true);
  }

  async function copyLocalMedia(localItems: MediaItem[]) {
    const selected = localItems.filter(item => copySelection[item.original_path]);
    if (!selected.length || copyBusy) return;
    setCopyBusy(true); setCopyError(''); setCopySuccess('');
    let staged = false;
    try {
      const sources = selected.map(item => item.resolved_path || item.original_path);
      const manifest = await invoke<{ files: Array<{ id: string; source: string; name: string; status: string; role: string; clients: string[]; client: string | null; client_paths: string[]; destinations: string[] }> }>('ingest_collect', { projectRoot, sources });
      staged = true;
      const relativeRoot = projectRoot.replace(/[\\/]+$/, '');
      const clientPrefix = `${relativeRoot}\\`;
      if (!clientPath.toLowerCase().startsWith(clientPrefix.toLowerCase())) throw new Error('The client folder is outside the selected project.');
      const relativeClient = clientPath.slice(clientPrefix.length).replace(/\\/g, '/');
      const clientName = clientPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || clientPath;
      const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
      const fileIds: string[] = [];
      for (const item of selected) {
        const source = item.resolved_path || item.original_path;
        const entry = manifest.files.find(file => normalize(file.source) === normalize(source));
        if (!entry) throw new Error(`Could not find the verified staged copy for ${item.file_name}.`);
        if (entry.status === 'Filed' || entry.destinations.length) continue;
        if ((entry.clients.length || entry.client) && !(entry.clients.length === 1 && entry.clients[0] === clientName && entry.client_paths.length === 1 && normalize(entry.client_paths[0]) === normalize(relativeClient))) {
          throw new Error(`${item.file_name} is already assigned in Import media. Finish or clear that assignment there first.`);
        }
        entry.role = copyRoles[item.original_path] || defaultCopyRole(item.file_name);
        entry.client = clientName;
        entry.clients = [clientName];
        entry.client_paths = [relativeClient];
        fileIds.push(entry.id);
      }
      if (!fileIds.length) {
        setCopySuccess('These files are already filed in the client workspace.');
        setCopyOpen(false);
        return;
      }
      await invoke('ingest_save', { projectRoot, manifest });
      const filed = await invoke<typeof manifest>('ingest_file_ids', { projectRoot, fileIds });
      const completed = filed.files.filter(file => fileIds.includes(file.id) && file.status === 'Filed').length;
      setCopySuccess(`${completed} ${completed === 1 ? 'file' : 'files'} copied into the client folders. Originals are untouched; verified recovery copies remain in Import media. Relink the project in Premiere to use the NAS copies.`);
      setCopyOpen(false);
      setAttempt(value => value + 1);
    } catch (reason) {
      setCopyError(`Could not finish copying the selected files: ${String(reason)}${staged ? ' Verified staged copies remain in Import media for recovery.' : ''}`);
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
  const fileCount = `${issues.length} ${issues.length === 1 ? 'file' : 'files'}`;
  const headline = !issues.length ? 'All media on NAS'
    : singleStatus === 'missing' ? `${issues.length} missing ${issues.length === 1 ? 'file' : 'files'}`
    : singleStatus === 'unavailable' ? `${fileCount} unavailable`
    : singleStatus === 'local' ? `${fileCount} ${issues.length === 1 ? 'is' : 'are'} not on NAS`
    : singleStatus === 'moved' ? `${fileCount} to reconnect`
    : singleStatus === 'copied' ? `${fileCount} copied to NAS · relink in Premiere`
    : `${fileCount} ${issues.length === 1 ? 'needs' : 'need'} attention`;
  const displayed = showFound ? found : issues;
  const visible = displayed.filter(item => `${item.file_name} ${item.original_path} ${item.resolved_path || ''} ${report?.machine_name || ''}`.toLowerCase().includes(query.toLowerCase()));
  const showStatus = !showFound && issueStatuses.size > 1;

  return <section className="pph-panel" aria-labelledby={headingId} aria-busy={busy}>
      <header className="pph-header">
        <h3 id={headingId} title={projectPath}>Media</h3>
        <div className="pph-header-actions">
          <button type="button" className="pph-rescan" disabled={busy} onClick={() => setAttempt(value => value + 1)} title="Rescan project media" aria-label="Rescan project media"><RefreshCw size={14} className={busy ? 'pph-spin' : ''}/></button>
        </div>
      </header>
      <div className="pph-body">
        {busy ? <div className="pph-state" role="status"><LoaderCircle className="pph-spin" size={18}/><span>Checking media…</span></div>
          : error ? <p className="pph-error" role="alert">{errorCopy(error)}</p>
          : report ? <>
            <div className={`pph-result ${issues.length ? 'attention' : 'healthy'}`}>
              <div className="pph-result-top">
                <div className="pph-result-heading" role="status">{issues.length ? <i aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}<strong>{headline}</strong></div>
                {localItems.length > 0 && <button type="button" className="pph-copy-button" disabled={busy} onClick={() => startCopyDialog(localItems)}><Copy size={13}/>Copy to NAS</button>}
              </div>
              <span>{issues.length ? `${found.length} on NAS` : `${found.length} ${found.length === 1 ? 'file' : 'files'}`}</span>
              {singleStatus === 'local' && <p className="pph-action-hint">Copy to NAS, then relink in Premiere.</p>}
              {singleStatus === 'missing' && <p className="pph-action-hint">These files are not available at their linked paths on this computer, so Pepper cannot copy them from here. Check the reported last computer or reconnect the source drive.</p>}
              {singleStatus === 'copied' && <p className="pph-action-hint">The verified NAS copy is ready. Reconnect this file in Premiere.</p>}
            </div>
            {displayed.length > 0 && <>
              {displayed.length > 8 && <input className="pph-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a file" aria-label="Find a media file"/>}
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
            {found.length > 0 && <button type="button" className="pph-text-button" aria-pressed={showFound} onClick={() => { setShowFound(value => !value); setQuery(''); }}>{showFound ? issues.length ? 'Show issues' : 'Hide files' : 'Show NAS files'}</button>}
            {report.availability_note && <p className="pph-feedback" title={report.availability_note}>This check couldn’t be shared with other computers.</p>}
            {copySuccess && <p className="pph-feedback pph-success" role="status">{copySuccess}</p>}
            {copyError && <p className="pph-feedback" role="alert">{copyError}</p>}
            {locationError && <p className="pph-feedback" role="alert">{locationError}</p>}
          </> : null}
      </div>
      {copyOpen && <div className="pph-copy-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !copyBusy) setCopyOpen(false); }}>
        <section className="pph-copy-dialog" role="dialog" aria-modal="true" aria-labelledby="pph-copy-title">
          <header><div><h2 id="pph-copy-title">Copy local media to NAS</h2><p>Choose a destination type for each file. Pepper stages and verifies each copy, then files it under this client.</p></div><button type="button" className="pph-rescan" aria-label="Close dialog" disabled={copyBusy} onClick={() => setCopyOpen(false)}><X size={15}/></button></header>
          <div className="pph-copy-list" role="list">
            {localItems.map(item => {
              const choices = roleOptions[mediaKind(item.file_name) || 'other'];
              const role = copyRoles[item.original_path] || defaultCopyRole(item.file_name);
              return <div className={`pph-copy-row ${copySelection[item.original_path] ? 'selected' : ''}`} key={item.original_path}>
                <input type="checkbox" checked={Boolean(copySelection[item.original_path])} disabled={copyBusy} aria-label={`Include ${item.file_name}`} onChange={event => setCopySelection(current => ({ ...current, [item.original_path]: event.target.checked }))}/>
                <div className="pph-copy-file"><strong title={item.file_name}>{item.file_name}</strong><small title={item.original_path}>{item.original_path}</small></div>
                <label><span>File as</span><select value={role} disabled={copyBusy || !copySelection[item.original_path]} onChange={event => setCopyRoles(current => ({ ...current, [item.original_path]: event.target.value }))}>{choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select><small>{roleDestinations[role]}</small></label>
              </div>;
            })}
          </div>
          <footer><button type="button" className="pph-copy-cancel" disabled={copyBusy} onClick={() => setCopyOpen(false)}>Cancel</button><button type="button" className="pph-copy-confirm" disabled={copyBusy || !localItems.some(item => copySelection[item.original_path])} onClick={() => void copyLocalMedia(localItems)}>{copyBusy ? <><LoaderCircle size={14} className="pph-spin"/>Copying and verifying…</> : <><Copy size={14}/>Copy selected to NAS</>}</button></footer>
        </section>
      </div>}
    </section>;
}
