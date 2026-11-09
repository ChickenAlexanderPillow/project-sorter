import { useEffect, useId, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, File, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { statusFor, type MediaHealthStatus as Status } from './premiereHealthStatus';
import './PremiereProjectHealth.css';

type MachineAvailability = { machine_name: string; last_seen: string };
type MediaItem = { file_name: string; original_path: string; resolved_path: string | null; status: string; available_on: MachineAvailability[] };
type HealthReport = { machine_name: string; availability_note: string | null; items: MediaItem[] };
const labels: Record<Status, string> = { local: 'Not on NAS', missing: 'Missing', unavailable: 'Unavailable', moved: 'Moved', unknown: 'Needs checking', found: 'Found' };
const hints: Record<Status, string> = {
  local: 'Stored on this computer, not on the NAS. Copy it to the NAS and reconnect it in Premiere.',
  missing: 'Reconnect this file in Premiere. Check the drive is connected first.',
  unavailable: 'Check the drive connection and folder access, then check again.',
  moved: 'Found in a new location. Premiere may need to reconnect it.',
  unknown: 'Open the project in Premiere to check this file.',
  found: 'Available on the NAS.',
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

export function PremiereProjectHealth({ clientPath, projectPath }: { clientPath: string; projectPath: string }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [showFound, setShowFound] = useState(false);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [locationError, setLocationError] = useState('');
  const [openingLocation, setOpeningLocation] = useState<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setReport(null); setShowFound(false); setQuery(''); setLocationError('');
    void invoke<HealthReport>('premiere_project_health_scan', { clientPath, path: projectPath })
      .then(value => { if (active) setReport(value); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [clientPath, projectPath, attempt]);

  async function openLocation(item: MediaItem) {
    setOpeningLocation(item.original_path); setLocationError('');
    try {
      const recorded = (item.resolved_path || item.original_path).trim().replace(/\//g, '\\');
      const path = /^(?:[a-z]:[\\/]|\\\\)/i.test(recorded) ? recorded : projectPath.replace(/[^\\/]+$/, '') + recorded;
      await invoke('open_file_location', { path });
    } catch { setLocationError(`Couldn’t open the folder for ${item.file_name}. It may be moved or disconnected.`); }
    finally { setOpeningLocation(null); }
  }

  const items = report?.items || [];
  const rank: Record<Status, number> = { missing: 0, unavailable: 1, local: 2, moved: 3, unknown: 4, found: 5 };
  const issues = items.filter(item => statusFor(item.status) !== 'found')
    .sort((a, b) => rank[statusFor(a.status)] - rank[statusFor(b.status)]);
  const found = items.filter(item => statusFor(item.status) === 'found');
  const issueStatuses = new Set(issues.map(item => statusFor(item.status)));
  const singleStatus = issueStatuses.size === 1 ? statusFor(issues[0].status) : null;
  const fileCount = `${issues.length} ${issues.length === 1 ? 'file' : 'files'}`;
  const headline = !issues.length ? 'All media on NAS'
    : singleStatus === 'missing' ? `${issues.length} missing ${issues.length === 1 ? 'file' : 'files'}`
    : singleStatus === 'unavailable' ? `${fileCount} unavailable`
    : singleStatus === 'local' ? `${fileCount} ${issues.length === 1 ? 'is' : 'are'} not on NAS`
    : singleStatus === 'moved' ? `${fileCount} to reconnect`
    : `${fileCount} ${issues.length === 1 ? 'needs' : 'need'} attention`;
  const displayed = showFound ? found : issues;
  const visible = displayed.filter(item => `${item.file_name} ${item.original_path} ${item.resolved_path || ''} ${report?.machine_name || ''}`.toLowerCase().includes(query.toLowerCase()));
  const showStatus = !showFound && issueStatuses.size > 1;

  return <section className="pph-panel" aria-labelledby={headingId} aria-busy={busy}>
      <header className="pph-header">
        <h3 id={headingId} title={projectPath}>Media</h3>
        <button type="button" className="pph-rescan" disabled={busy} onClick={() => setAttempt(value => value + 1)} title="Rescan project media" aria-label="Rescan project media"><RefreshCw size={14} className={busy ? 'pph-spin' : ''}/></button>
      </header>
      <div className="pph-body">
        {busy ? <div className="pph-state" role="status"><LoaderCircle className="pph-spin" size={18}/><span>Checking media…</span></div>
          : error ? <p className="pph-error" role="alert">{errorCopy(error)}</p>
          : report ? <>
            <div className={`pph-result ${issues.length ? 'attention' : 'healthy'}`} role="status">
              <div className="pph-result-heading">{issues.length ? <i aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}<strong>{headline}</strong></div>
              <span>{issues.length ? `${found.length} on NAS` : `${found.length} ${found.length === 1 ? 'file' : 'files'}`}</span>
              {singleStatus === 'local' && <p className="pph-action-hint">Copy to NAS, then relink in Premiere.</p>}
            </div>
            {displayed.length > 0 && <>
              {displayed.length > 8 && <input className="pph-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a file" aria-label="Find a media file"/>}
              <ul className="pph-media-list" aria-label={showFound ? 'Media files on NAS' : 'Files needing attention'}>
                {visible.map(item => {
                  const status = statusFor(item.status);
                  const path = item.resolved_path || item.original_path;
                  const peerReports = status === 'found' ? [] : item.available_on;
                  return <li className="pph-media-row" key={item.original_path} aria-label={`${item.file_name}: ${labels[status]}${peerReports.length ? `; last seen on ${peerReports.map(peer => peer.machine_name).join(', ')}` : ''}`} title={hints[status]}>
                    <File size={16} className="pph-file-icon" aria-hidden="true"/>
                    <div className="pph-file-name"><strong title={item.file_name}>{item.file_name}</strong><span title={status === 'moved' ? `Saved: ${item.original_path}\nFound: ${path}` : item.original_path}>{folderName(path)}</span></div>
                    {(showStatus || status === 'local' || peerReports.length > 0) && <span className={`pph-file-status ${status}`} title={status === 'local' ? `${hints[status]} Available on ${report.machine_name}.` : peerReports.length ? `${labels[status]} here. Last known on:\n${peerTitle(peerReports)}` : hints[status]}>{status === 'local' ? `Local · ${report.machine_name}` : peerReports.length ? peerLabel(peerReports) : labels[status]}</span>}
                    <button type="button" className="pph-icon-button" disabled={openingLocation !== null} title="Open file location" aria-label={`Open file location for ${item.file_name}`} onClick={() => void openLocation(item)}>{openingLocation === item.original_path ? <LoaderCircle size={14} className="pph-spin"/> : <FolderOpen size={15}/>}</button>
                  </li>;
                })}
              </ul>
              {!visible.length && <p className="pph-empty">No matching files</p>}
            </>}
            {found.length > 0 && <button type="button" className="pph-text-button" aria-pressed={showFound} onClick={() => { setShowFound(value => !value); setQuery(''); }}>{showFound ? issues.length ? 'Show issues' : 'Hide files' : 'Show NAS files'}</button>}
            {report.availability_note && <p className="pph-feedback" title={report.availability_note}>This check couldn’t be shared with other computers.</p>}
            {locationError && <p className="pph-feedback" role="alert">{locationError}</p>}
          </> : null}
      </div>
    </section>;
}
