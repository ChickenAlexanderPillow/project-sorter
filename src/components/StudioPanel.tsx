import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { save } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import './StudioPanel.css';
import { createStudioSession, parseStudioSession as session, type StudioSession as Session } from './studioSessions';
import { Check, Download, LoaderCircle, Plus, RefreshCw, Trash2, X, Film, Mail, Send } from 'lucide-react';
import { CopyReviewLinkButton } from './CopyReviewLinkButton';

type Remote = Record<string, unknown>;
type EventRecordings = { recordings?: Remote[] };
type MailRecipient = { id: string; name: string; email: string };

export function StudioPanel({ clientPath, clientName, onSettings, refreshKey = 0 }: { clientPath: string; clientName: string; onSettings: () => void; refreshKey?: number }) {
  const [rows, setRows] = useState<Session[]>([]);
  const [remote, setRemote] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(clientName);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [recordings, setRecordings] = useState<Record<string, { data?: EventRecordings; error?: string; loading?: boolean }>>({});
  const [downloading, setDownloading] = useState('');
  const [downloaded, setDownloaded] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [mailSending, setMailSending] = useState<string | null>(null);
  const [mailFeedback, setMailFeedback] = useState<Record<string, { message: string; error?: boolean }>>({});
  const [customMailAddress, setCustomMailAddress] = useState('');
  const [customMailSelected, setCustomMailSelected] = useState(false);
  const [selectedMailRecipient, setSelectedMailRecipient] = useState<MailRecipient | null>(null);
  const [recipients, setRecipients] = useState<MailRecipient[]>([]);
  const [mailMenu, setMailMenu] = useState<{ sessionId: string; top: number; left: number } | null>(null);
  const mailMenuRef = useRef<HTMLDivElement | null>(null);
  const mailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const request = useRef(0);
  const [deleting, setDeleting] = useState<{ session: Session; number: number } | null>(null);
  const available = remote.filter(item => !rows.some(row => row.event_id === item.event_id));

  const load = async (refresh = false) => {
    const current = ++request.current;
    setLoading(true);
    setError('');
    setConnectionError('');
    try {
      const [saved, status] = await Promise.all([
        invoke<Session[]>('restream_client_sessions', { clientPath }),
        invoke<string>('restream_connection_status').catch(() => 'disconnected'),
      ]);
      if (request.current !== current) return;
      setRows(saved);
      setConnected(status === 'connected');
      setRemote([]);
      if (status === 'connected') {
        const events = await invoke<Remote[]>('restream_list_studios').catch(err => {
          if (request.current === current) setConnectionError(String(err));
          return [];
        });
        if (request.current !== current) return;
        setRemote(events.map(session).filter(item => item.event_id && item.url));
        if (refresh) {
          for (const item of saved) {
            try {
              const fresh = session(await invoke<Remote>('restream_get_studio', { eventId: item.event_id }));
              if (request.current !== current) return;
              if (fresh.event_id && fresh.url) {
                const updated = await invoke<Session[]>('restream_associate_session', { clientPath, session: fresh });
                if (request.current === current) setRows(updated);
              }
            } catch { /* Keep the saved link when a remote session is unavailable. */ }
          }
        }
      }
    } catch (err) {
      if (request.current === current) setError(String(err));
    } finally {
      if (request.current === current) setLoading(false);
    }
  };

  useEffect(() => {
    setRows([]);
    setMailMenu(null);
    setDeleting(null);
    setCreating(false);
    setSelected('');
    setTitle(clientName);
    void load();
    return () => { request.current++; };
  }, [clientPath, refreshKey]);
  useEffect(() => {
    void invoke<MailRecipient[]>('studio_mail_recipients').then(setRecipients).catch(err => setError(String(err)));
    const updateRecipients = (event: Event) => setRecipients((event as CustomEvent<MailRecipient[]>).detail);
    window.addEventListener('pepper-mail-recipients-updated', updateRecipients);
    return () => window.removeEventListener('pepper-mail-recipients-updated', updateRecipients);
  }, []);
  useEffect(() => {
    if (!mailMenu) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!mailMenuRef.current?.contains(target) && !mailTriggerRef.current?.contains(target)) setMailMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMailMenu(null);
        mailTriggerRef.current?.focus();
      }
    };
    const closeOnLayoutChange = (event: Event) => {
      if (event.target instanceof Node && mailMenuRef.current?.contains(event.target)) return;
      setMailMenu(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnLayoutChange);
    window.addEventListener('scroll', closeOnLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnLayoutChange);
      window.removeEventListener('scroll', closeOnLayoutChange, true);
    };
  }, [mailMenu]);
  useEffect(() => {
    if (mailMenu) mailMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [mailMenu?.sessionId]);
  useLayoutEffect(() => {
    if (!mailMenu || !mailMenuRef.current || !mailTriggerRef.current) return;
    const menu = mailMenuRef.current.getBoundingClientRect();
    const trigger = mailTriggerRef.current.getBoundingClientRect();
    const below = trigger.bottom + 5;
    const top = below + menu.height <= window.innerHeight - 8
      ? below : Math.max(8, trigger.top - menu.height - 5);
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    if (top !== mailMenu.top || left !== mailMenu.left) setMailMenu({ ...mailMenu, top, left });
  }, [mailMenu, recipients.length]);
  const closeMailMenu = () => {
    mailTriggerRef.current?.focus();
    setMailMenu(null);
  };
  const associate = async (item: Session) => {
    const updated = await invoke<Session[]>('restream_associate_session', { clientPath, session: item });
    setRows(updated);
    setSelected('');
    setCreating(false);
  };
  const create = async () => {
    if (!title.trim() || busy || loading) return;
    setBusy(true);
    setError('');
    try {
      const created = await createStudioSession(title);
      await associate(created);
    } catch (err) {
      setError(`Could not confirm session creation. Check Restream sessions before retrying. ${String(err)}`);
    } finally { setBusy(false); }
  };
  const linkExisting = async () => {
    const item = available.find(row => row.event_id === selected);
    if (!item || busy) return;
    setBusy(true);
    setError('');
    try { await associate(item); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const open = async (url: string) => {
    try { await openUrl(url); }
    catch (err) { setError(String(err)); }
  };
  const copy = async (url: string) => {
    try { await writeText(url); return true; }
    catch (err) { setError(String(err)); return false; }
  };
  const sendSessionLink = async (item: Session, recipient: MailRecipient) => {
    if (mailSending) return;
    setMailSending(item.event_id);
    setMailFeedback(current => ({ ...current, [item.event_id]: { message: '' } }));
    try {
      await invoke('studio_mail_send_link', { sessionTitle: item.title, sessionUrl: item.url, recipientEmail: recipient.email });
      setMailFeedback(current => ({ ...current, [item.event_id]: { message: `Sent to ${recipient.name || recipient.email}.` } }));
    } catch (err) {
      setMailFeedback(current => ({ ...current, [item.event_id]: { message: String(err), error: true } }));
    } finally { setMailSending(null); }
  };

  const loadRecordings = async (item: Session) => {
    setRecordings(current => ({ ...current, [item.event_id]: { loading: true } }));
    try {
      const data = await invoke<EventRecordings>('restream_list_event_recordings', { eventId: item.event_id, sessionTitle: item.title });
      setRecordings(current => ({ ...current, [item.event_id]: { data } }));
    } catch (err) {
      setRecordings(current => ({ ...current, [item.event_id]: { error: String(err) } }));
    }
  };

  const downloadRecording = async (item: Session, file: Remote, recordingEventId?: string) => {
    const fileName = typeof file.fileName === 'string' ? file.fileName : '';
    if (!fileName || downloading) return;
    const eventId = recordingEventId || item.event_id;
    setDownloading(`${eventId}:${fileName}`);
    const key = `${eventId}:${fileName}`;
    setDownloaded('');
    setDownloadError('');
    try {
      const savePath = await save({ title: 'Save Restream recording', defaultPath: fileName });
      if (!savePath) return;
      await invoke('restream_download_recording', { eventId, fileName, savePath });
      setDownloaded(key);
    } catch (err) {
      setDownloadError(String(err));
    } finally {
      setDownloading('');
    }
  };

  const deleteSession = async (item: Session) => {
    setBusy(true);
    request.current++;
    try {
      const updated = await invoke<Session[]>('restream_delete_studio', { clientPath, eventId: item.event_id });
      setRows(updated);
      setRemote(current => current.filter(row => row.event_id !== item.event_id));
      setDeleting(null);
    } finally { setBusy(false); }
  };

  return <section className="studio-panel" aria-label="Studio sessions" aria-busy={busy}>
    <header className="studio-list-heading">
      <span>Sessions <small>{rows.length}</small></span>
      <div className="studio-list-actions">
        <button type="button" className="frameio-icon-button" title="Refresh sessions" aria-label="Refresh sessions" onClick={() => void load(true)} disabled={loading || busy}><RefreshCw size={13} className={loading ? 'cf-spin' : ''} /></button>
        <button type="button" className="studio-secondary" disabled={loading || busy || creating} onClick={() => { setCreating(true); setError(''); }}><Plus size={13} />New session</button>
      </div>
    </header>
        {creating && connected ? <form className="studio-form" onSubmit={event => { event.preventDefault(); void create(); }}>
          <header><h3>New session</h3><button type="button" className="frameio-icon-button" title="Cancel" aria-label="Cancel new session" disabled={busy} onClick={() => setCreating(false)}><X size={14} /></button></header>
          <label htmlFor={`studio-title-${clientPath}`}>Session title</label>
          <input id={`studio-title-${clientPath}`} autoFocus value={title} onChange={event => setTitle(event.target.value)} disabled={busy} placeholder="Name your session" />
          <button type="submit" className="studio-action" disabled={busy || loading || !title.trim()}>{busy ? <LoaderCircle size={14} className="cf-spin" /> : <Plus size={14} />}Create session</button>
          {available.length > 0 && <div className="studio-existing">
            <label htmlFor={`studio-existing-${clientPath}`}>Or link an existing session</label>
            <div><select id={`studio-existing-${clientPath}`} value={selected} onChange={event => setSelected(event.target.value)} disabled={busy}><option value="">Choose a session…</option>{available.map(item => <option key={item.event_id} value={item.event_id}>{item.title}</option>)}</select><button type="button" className="studio-secondary" disabled={!selected || busy || loading} onClick={() => void linkExisting()}>Link session</button></div>
          </div>}
        </form> : creating ? <div className="studio-connect">
          <header><h3>New session</h3><button type="button" className="frameio-icon-button" title="Cancel" aria-label="Cancel new session" onClick={() => setCreating(false)}><X size={14} /></button></header>
          <p>Connect Restream in Settings to create or link a session.</p>
          <button type="button" className="studio-secondary" onClick={onSettings}>Open Settings</button>
        </div> : null}
    {creating && connectionError && <p className="cf-error" role="alert">{connectionError}</p>}
    <div className="studio-sessions">
      {rows.map((item, index) => <article className="studio-session-row" key={item.event_id}>
        <div className="studio-session-info">
          <h3><a href={item.url} title="Open Studio" onClick={event => { event.preventDefault(); void open(item.url); }}>Session {index + 1}</a></h3>
          <a href={item.url} title={item.url} onClick={event => { event.preventDefault(); void open(item.url); }}>{item.url.replace(/^https?:\/\//, '')}</a>
        </div>
        {item.status && item.status.toLowerCase() !== 'draft' && <span className="studio-status">{item.status.replace(/[_-]/g, ' ')}</span>}
        <div className="studio-row-actions">
          <button type="button" className="frameio-icon-button" ref={mailMenu?.sessionId === item.event_id ? mailTriggerRef : undefined} title={`Email Session ${index + 1} link to`} aria-label={`Email Session ${index + 1} link to`} aria-expanded={mailMenu?.sessionId === item.event_id} aria-controls={`studio-mail-recipients-${item.event_id}`} disabled={Boolean(mailSending)} onClick={event => {
            if (mailMenu?.sessionId === item.event_id) { setMailMenu(null); return; }
            const bounds = event.currentTarget.getBoundingClientRect();
            const width = 304;
            const height = Math.min(420, recipients.length * 42 + 205);
            const top = bounds.bottom + height <= window.innerHeight - 8 ? bounds.bottom + 5 : Math.max(8, bounds.top - height - 5);
            setSelectedMailRecipient(null);
            setCustomMailSelected(false);
            setCustomMailAddress('');
            setMailMenu({ sessionId: item.event_id, top, left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)) });
          }}>{mailSending === item.event_id ? <LoaderCircle size={14} className="cf-spin" /> : <Mail size={14} />}</button>
          {mailMenu?.sessionId === item.event_id && createPortal(<div id={`studio-mail-recipients-${item.event_id}`} ref={mailMenuRef} className="pepper-context-menu studio-mail-menu" role="dialog" aria-labelledby={`studio-mail-title-${item.event_id}`} style={{ top: mailMenu.top, left: mailMenu.left }}>
            <header className="studio-mail-heading">
              <Mail size={15} aria-hidden="true" />
              <h4 id={`studio-mail-title-${item.event_id}`}>Email Session {index + 1} link</h4>
              <button type="button" className="studio-mail-close" aria-label="Close email menu" title="Close" onClick={closeMailMenu}><X size={14} /></button>
            </header>
            <form className="studio-mail-form" onSubmit={event => {
              event.preventDefault();
              const email = customMailAddress.trim();
              const recipient = customMailSelected && email ? { id: 'custom', name: email, email } : selectedMailRecipient;
              if (!recipient || mailSending) return;
              closeMailMenu();
              void sendSessionLink(item, recipient);
            }}>
              {recipients.length > 0 && <div className="studio-mail-recipients" aria-label="Saved recipients">
                {[...recipients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.email.localeCompare(b.email, undefined, { sensitivity: 'base' })).map(person => <button key={person.email} type="button" className={`pepper-context-menu-item studio-mail-recipient-item ${selectedMailRecipient?.email === person.email ? 'selected' : ''}`} aria-label={`Select ${person.name}, ${person.email}`} aria-pressed={selectedMailRecipient?.email === person.email} disabled={Boolean(mailSending)} onClick={() => { setSelectedMailRecipient(person); setCustomMailSelected(false); setCustomMailAddress(''); }}>
                  <span className="studio-mail-recipient-details"><span>{person.name || person.email}</span><small>{person.email}</small></span>
                  <span className="studio-mail-selection" aria-hidden="true">{selectedMailRecipient?.email === person.email && <Check size={13} />}</span>
                </button>)}
              </div>}
              <div className="studio-mail-custom">
                <div className={`studio-mail-custom-row ${customMailSelected ? 'selected' : ''}`}>
                  <div className="studio-mail-recipient-details">
                    <input id={`studio-mail-custom-${item.event_id}`} aria-label="Custom email" type="email" autoComplete="email" required={!selectedMailRecipient} value={customMailAddress} onFocus={() => { setCustomMailSelected(true); setSelectedMailRecipient(null); }} onChange={event => { setCustomMailAddress(event.target.value); setCustomMailSelected(true); setSelectedMailRecipient(null); }} placeholder="name@example.com" disabled={Boolean(mailSending)} />
                  </div>
                  <button type="button" className="studio-mail-custom-select" aria-label="Select custom email" aria-pressed={customMailSelected} disabled={Boolean(mailSending)} onClick={() => { setCustomMailSelected(true); setSelectedMailRecipient(null); mailMenuRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }}>
                    <span className="studio-mail-selection" aria-hidden="true">{customMailSelected && <Check size={13} />}</span>
                  </button>
                </div>
              </div>
              <footer className="studio-mail-footer">
                <button type="button" className="studio-mail-cancel" onClick={closeMailMenu}>Cancel</button>
                <button type="submit" className="studio-mail-send" disabled={(!selectedMailRecipient && !customMailAddress.trim()) || Boolean(mailSending)}><Send size={12} aria-hidden="true" />Send link</button>
              </footer>
            </form>
          </div>, document.body)}
          <CopyReviewLinkButton url={item.url} version={index + 1} label={`link for Session ${index + 1}`} onCopy={copy} />
          {false && <button type="button" className="frameio-icon-button" title="List recordings" aria-label={`List recordings for Session ${index + 1}`} onClick={() => void loadRecordings(item)} disabled={Boolean(recordings[item.event_id]?.loading)}>{recordings[item.event_id]?.loading ? <LoaderCircle size={14} className="cf-spin" /> : <Film size={14} />}</button>}
          <button type="button" className="frameio-icon-button studio-delete" title="Delete session" aria-label={`Delete Session ${index + 1}`} disabled={busy || loading} onClick={() => setDeleting({ session: item, number: index + 1 })}><Trash2 size={14} /></button>
        </div>
        {mailFeedback[item.event_id]?.message && <p className={mailFeedback[item.event_id]?.error ? 'cf-error studio-mail-feedback' : 'studio-mail-feedback'} role="status">{mailFeedback[item.event_id]?.message}</p>}
        {recordings[item.event_id]?.error && <p className="cf-error" role="alert">{recordings[item.event_id]?.error}</p>}
        {recordings[item.event_id]?.data && <div className="studio-recordings" aria-label={`Recordings for Session ${index + 1}`}>
          {(recordings[item.event_id]?.data?.recordings || []).map((recording, recordingIndex) => {
            const recordingEventId = String(recording.eventId ?? recording.event_id ?? (recording.event as Remote | undefined)?.id ?? item.event_id);
            const categories = [
              ['Primary video', recording.primaryVideos],
              ['Secondary video', recording.secondaryVideos],
              ['Video', recording.videos ?? recording.video],
              ['Audio', recording.audio],
              ['File', recording.files],
            ] as const;
            const files = categories.flatMap(([label, value]) => Array.isArray(value) ? value.map(file => ({ label, file: file as Remote })) : []);
            return <div className="studio-recording-group" key={`${item.event_id}-recording-${recordingIndex}`}>
              <strong className="studio-recording-heading">Recording {recordingIndex + 1}{typeof recording.durationSeconds === 'number' ? ` · ${Math.round(recording.durationSeconds)} sec` : ''}</strong>
              {files.map(({ label, file }, fileIndex) => <div className="studio-recording-file" key={`${recordingIndex}-${fileIndex}`}>
                <span>{label}</span>
                <strong>{String(file.fileName ?? 'Recording')}</strong>
                {typeof file.expiresAt === 'string' && <small>Expires {new Date(file.expiresAt).toLocaleString()}</small>}
                <button type="button" className="studio-recording-download" disabled={!file.fileName || Boolean(downloading)} onClick={() => void downloadRecording(item, file, recordingEventId)} aria-label={`Download ${String(file.fileName ?? 'recording')}`} title="Download file">{downloading === `${recordingEventId}:${String(file.fileName ?? '')}` ? <LoaderCircle size={13} className="cf-spin" /> : downloaded === `${recordingEventId}:${String(file.fileName ?? '')}` ? <><Check size={12} />Saved</> : <><Download size={12} />Download</>}</button>
              </div>)}
              {files.length === 0 && <p className="studio-empty">No downloadable files listed for this recording.</p>}
            </div>;
          })}
          {!(recordings[item.event_id]?.data?.recordings || []).length && <p className="studio-empty">No recordings are available for this session yet.</p>}
          <small className="studio-recording-note">Restream does not identify whether a file originated from local or cloud recording.</small>
          {downloadError && <p className="cf-error" role="alert">{downloadError}</p>}
        </div>}
      </article>)}
      {!rows.length && !creating && <p className="studio-empty">{loading ? 'Loading sessions...' : 'No sessions yet. Create a session or link an existing one.'}</p>}
    </div>
    {error && <p className="cf-error" role="alert">{error}</p>}
    {deleting && <DeleteSessionConfirmation session={deleting.session} number={deleting.number} onCancel={() => setDeleting(null)} onConfirm={() => deleteSession(deleting.session)} />}
  </section>;
}

function DeleteSessionConfirmation({ session, number, onCancel, onConfirm }: {
  session: Session; number: number; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onConfirm(); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="studio-delete-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={`${id}-title`}>Delete Session {number}?</h2>
    <p id={`${id}-description`}>This deletes the session from Restream and removes it from this client. This cannot be undone.</p>
    <p className="studio-delete-url">{session.url}</p>
    {error && <p className="cf-error" role="alert">{error}</p>}
    <footer><button type="button" className="studio-secondary" autoFocus disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="studio-delete-confirm" disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle size={14} className="cf-spin" /> : <Trash2 size={14} />}{busy ? 'Deleting...' : 'Delete session'}</button></footer>
  </dialog>, document.body);
}
