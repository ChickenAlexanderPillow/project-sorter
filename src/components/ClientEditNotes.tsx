import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AudioLines, Check, ChevronRight, Clock3, File, Files, GripVertical, Headphones, Image, LoaderCircle, NotebookPen, Package, RefreshCw, Trash2, Video } from 'lucide-react';
import { formatNoteTime, parseNoteTime } from './noteTiming';
import { startNativeFileDrag } from './nativeFileDrag';
import { ClientNotesSync, type NoteTask as Task, type NoteReference as MediaReference } from './clientNotesSync';

type MediaFile = { name: string; path: string; relative_path: string; kind: string };
type Listing = { files: MediaFile[] };
export type ClientNoteMarker = { taskId: string; referenceId: string; timecode: string; end_timecode?: string; text: string };
export type ClientNotePreview = { taskId: string; referenceId: string; path: string; name: string; kind: string; timecode: string; markers: ClientNoteMarker[]; revealMarker: (taskId: string, referenceId: string) => void; setTimecode: (value: string) => void; addTimestamp: (value: string, end?: string) => ClientNoteMarker; editTimestamp: (taskId: string, referenceId: string, value: string, end?: string) => void; editNote: (taskId:string, referenceId:string, text:string)=>void };
type MediaCategory = 'all' | 'video' | 'audio' | 'stills' | 'stock';
const CATEGORIES: { id: MediaCategory; name: string; Icon: typeof Files }[] = [
  { id: 'all', name: 'All', Icon: Files }, { id: 'video', name: 'Video', Icon: Video },
  { id: 'audio', name: 'Audio', Icon: Headphones }, { id: 'stills', name: 'Stills', Icon: Image },
  { id: 'stock', name: 'Stock', Icon: Package },
];
const isStock = (file: MediaFile) => /(?:^|[\\/])090_STOCK(?:[\\/]|$)/i.test(file.relative_path);
const inCategory = (file: MediaFile, category: MediaCategory) => category === 'all' || (category === 'stock' ? isStock(file)
  : category === 'video' ? file.kind === 'video' && !isStock(file)
  : category === 'audio' ? file.kind === 'audio' && !isStock(file)
  : file.kind === 'image' && !isStock(file));
const signature = (tasks: Task[]) => JSON.stringify(tasks);
const makeTask = (): Task => ({ id: crypto.randomUUID(), text: '', completed: false, references: [] });
const isDraft = (task: Task) => !task.completed && !task.text.trim() && !(task.references || []).length;
const orderTasks = (tasks: Task[]) => [...tasks.filter(task => !task.completed), ...tasks.filter(task => task.completed)];
const prepareLoadedTasks = (saved: Task[]) => {
  let loadedTasks = orderTasks(saved.map(task => ({ ...task, references: task.references || [] })));
  const legacyMarkers = loadedTasks.filter(task => !task.text.trim() && task.references.length > 0 && task.references.every(reference => reference.timecode.trim()));
  for (const markerTask of legacyMarkers) {
    const path = markerTask.references[0]?.relative_path;
    const owner = loadedTasks.find(task => task.id !== markerTask.id && task.references.some(reference => reference.relative_path === path && !reference.timecode.trim()));
    if (owner) loadedTasks = loadedTasks.map(task => task.id === owner.id ? { ...task, references: [...task.references, ...markerTask.references] } : task).filter(task => task.id !== markerTask.id);
  }
  const normalizedTasks = normalizeTasks(orderTasks(loadedTasks));
  return { tasks: normalizedTasks };
};
const normalizeTasks = (tasks: Task[]) => {
  const draft = [...tasks].reverse().find(isDraft) || makeTask();
  return [...tasks.filter(task => !task.completed && !isDraft(task)), draft, ...tasks.filter(task => task.completed)];
};
const savedTasks = (tasks: Task[]) => tasks.filter(task => !isDraft(task));
function migrateInlineReferences(task: Task, files: MediaFile[]): Task {
  let text = task.text;
  const references = [...(task.references || [])];
  for (const file of [...files].sort((a, b) => b.relative_path.length - a.relative_path.length)) {
    const token = `@${file.relative_path}`;
    let index = text.indexOf(token);
    while (index >= 0) {
      let end = index + token.length, timecode = '';
      const suffix = text.slice(end).match(/^\s+\[([^\]]+)\]/);
      if (suffix) { timecode = suffix[1]; end += suffix[0].length; }
      const before = text.slice(0, index), after = text.slice(end);
      text = `${before}${before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after}`;
      references.push({ id: crypto.randomUUID(), relative_path: file.relative_path, name: file.name, timecode });
      index = text.indexOf(token, index + 1);
    }
  }
  return { ...task, text: text.trim(), references };
}

export function ClientEditNotes({ clientPath, activePreviewId, activePreviewPath, playbackActiveIds=[], onPreviewChange, onMarkersChange }: { clientPath: string; activePreviewId: string | null; activePreviewPath: string | null; playbackActiveIds?:string[]; onPreviewChange: (preview: ClientNotePreview | null) => void; onMarkersChange:(markers:ClientNoteMarker[])=>void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingMarker, setEditingMarker] = useState<string | null>(null);
  const [editingTask,setEditingTask]=useState<string|null>(null);
  const [selectedTask,setSelectedTask]=useState<string|null>(null);
  const [completing,setCompleting]=useState<Set<string>>(new Set());
  const completionTimers=useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(()=>()=>{completionTimers.current.forEach(clearTimeout);},[clientPath]);
  const [reordering, setReordering] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const noteDrag = useRef<{ id: string; pointerId: number; startY: number; target: { id: string; before: boolean } | null } | null>(null);
  const draggedMedia = useRef(false);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ taskId: string; start: number; query: string } | null>(null);
  const [mentionFile, setMentionFile] = useState<MediaFile | null>(null);
  const [category, setCategory] = useState<MediaCategory>('all');
  const [active, setActive] = useState(0);
  const [pickerPosition, setPickerPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const picker = useRef<HTMLDivElement>(null);
  const sync = useRef<ClientNotesSync | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; path: string } | null>(null);
  const nativeBusy = useRef(false);
  const cursor = useRef<{ id: string; position: number } | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded(false); setTasks([]); setError(''); setStatus('saving'); setMention(null); setMentionFile(null);
    const session = new ClientNotesSync({
      load: () => invoke<Task[]>('client_edit_notes_load', { clientPath }),
      save: (tasks, baseTasks) => invoke<Task[]>('client_edit_notes_save', { clientPath, tasks, baseTasks }),
    }, saved => {
      if (!current) return;
      setTasks(previous => {
        const draft = previous.find(isDraft);
        return normalizeTasks([...prepareLoadedTasks(saved).tasks.filter(task => !isDraft(task)), ...(draft ? [draft] : [])]);
      });
      setLoaded(true);
    }, (nextStatus, reason) => { if (current) { setStatus(nextStatus); setError(reason); } });
    sync.current = session;
    void session.refresh();
    const interval = window.setInterval(() => { void session.refresh(); }, 500);
    const refresh = () => { void session.refresh(true); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pepper-refresh-notes', refresh);
    document.addEventListener('visibilitychange', visible);
    void invoke<Listing>('client_files_list', { clientPath, category: 'all' })
      .then(listing => { if (current) setFiles(listing.files.filter(file => file.kind !== 'project')); })
      .catch(() => { /* Notes remain usable when media folders are unavailable. */ });
    return () => {
      current = false;
      session.stop();
      if (sync.current === session) sync.current = null;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pepper-refresh-notes', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [clientPath]);

  useEffect(() => {
    if (!mention) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) { setMention(null); setMentionFile(null); }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMention(null); setMentionFile(null); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown, true); };
  }, [mention]);

  useLayoutEffect(() => {
    if (loaded) sync.current?.update(savedTasks(tasks));
  }, [loaded, tasks]);

  useEffect(() => {
    if (!loaded || !files.length) return;
    const migrated = tasks.map(task => migrateInlineReferences(task, files));
    if (signature(migrated) !== signature(tasks)) setTasks(migrated);
  }, [files, loaded]);

  const categories = CATEGORIES.filter(item => item.id === 'all' || files.some(file => inCategory(file, item.id)));
  const results = mention && !mentionFile ? files.filter(file => inCategory(file, category)
    && `${file.name} ${file.relative_path}`.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const moveTask = (id: string, target: string) => setTasks(current => {
    const from = current.findIndex(task => task.id === id);
    const to = current.findIndex(task => task.id === target);
    if (from < 0 || to < 0 || from === to || isDraft(current[to]) || current[from].completed !== current[to].completed) return current;
    const next = [...current]; const [task] = next.splice(from, 1); next.splice(to, 0, task);
    return normalizeTasks(next);
  });
  const updateTask = (id: string, update: Partial<Task>) => setTasks(current => normalizeTasks(current.map(task => task.id === id ? { ...task, ...update } : task)));
  const updateReferenceTimecode = (taskId: string, referenceId: string, value: string) => setTasks(current => normalizeTasks(current.map(task => task.id === taskId ? { ...task, references: task.references.map(reference => reference.id === referenceId ? { ...reference, timecode: value } : reference) } : task)));
  const completeTask=(id:string)=>{
    if(completing.has(id))return;
    setCompleting(current=>new Set([...current,id]));
    const pending=setTimeout(()=>{updateTask(id,{completed:true});setCompleting(current=>{const next=new Set(current);next.delete(id);return next;});completionTimers.current.delete(pending);},240);
    completionTimers.current.add(pending);
  };
  const removeTask = (id: string) => {
    if (tasks.some(task => task.id === id && isDraft(task))) return;
    if (activePreviewId?.startsWith(`${id}:`)) onPreviewChange(null);
    setTasks(current => normalizeTasks(current.filter(task => task.id !== id)));
    setMention(null); setMentionFile(null);
  };
  const addAfter = () => {
    const draft = tasks.find(isDraft);
    if (draft) requestAnimationFrame(() => inputRefs.current.get(draft.id)?.focus());
    else {
      const task = makeTask();
      setTasks(current => normalizeTasks([...current, task]));
      requestAnimationFrame(() => inputRefs.current.get(task.id)?.focus());
    }
  };
  const closePicker = () => { setMention(null); setMentionFile(null); };
  const selectMedia = (file: MediaFile) => insertReference(file);
  const placePicker = (input: HTMLTextAreaElement) => {
    const panelRect = panel.current?.getBoundingClientRect();
    if (!panelRect) return;
    const inputRect = input.getBoundingClientRect();
    const width = Math.min(320, panelRect.width - 16);
    setPickerPosition({
      left: Math.max(8, Math.min(inputRect.left - panelRect.left, panelRect.width - width - 8)),
      top: inputRect.bottom - panelRect.top + 4,
    });
  };
  const insertReference = (chosen = mentionFile) => {
    if (!mention || !chosen) return;
    const field = inputRefs.current.get(mention.taskId);
    if (!field) return;
    const task = tasks.find(item => item.id === mention.taskId);
    if (!task) return;
    const before = task.text.slice(0, mention.start), after = task.text.slice(field.selectionStart ?? mention.start);
    const nextText = `${before}${before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after}`;
    const reference: MediaReference = { id: crypto.randomUUID(), relative_path: chosen.relative_path, name: chosen.name, timecode: '' };
    setTasks(current => normalizeTasks(current.map(item => item.id === task.id ? { ...item, text: nextText, references: [...(item.references || []), reference] } : item)));
    closePicker(); cursor.current = { id: task.id, position: before.length };
    requestAnimationFrame(() => {
      const input = inputRefs.current.get(task.id);
      if (input && cursor.current) { input.focus(); input.setSelectionRange(cursor.current.position, cursor.current.position); }
    });
  };
  useEffect(() => {
    if (!loaded || !activePreviewPath) return;
    const file = files.find(item => item.path === activePreviewPath);
    if (!file) { onMarkersChange([]); return; }
    onMarkersChange(tasks.flatMap(task => task.references.filter(ref => ref.relative_path === file.relative_path && ref.timecode.trim()).map(ref => ({ taskId: task.id, referenceId: ref.id, timecode: ref.timecode, end_timecode: ref.end_timecode, text: ref.text ?? task.text }))));
  }, [tasks, files, loaded, activePreviewPath, onMarkersChange]);
  const activeTasks = tasks.filter(task => !task.completed);
  const completedTasks = tasks.filter(task => task.completed);
  const activeCount = activeTasks.filter(task => !isDraft(task)).length;
  const openReferencePreview = (task: Task, reference: MediaReference, file: MediaFile) => {
    setSelectedTask(task.id);
    onPreviewChange({ taskId: task.id, referenceId: reference.id, path: file.path, name: file.name, kind: file.kind, timecode: reference.timecode,
      revealMarker: (taskId, referenceId) => {
        setSelectedTask(taskId);
        requestAnimationFrame(() => {
          const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-marker-id]') || [])].find(node => node.dataset.markerId === referenceId && node.dataset.markerTask === taskId);
          const completed = row?.closest('details');
          if (completed) completed.open = true;
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          row?.querySelector<HTMLButtonElement>('.cen-note-marker')?.focus({ preventScroll: true });
        });
      },
      markers: tasks.flatMap(item => item.references.filter(mark => mark.relative_path === reference.relative_path && mark.timecode.trim()).map(mark => ({ taskId: item.id, referenceId: mark.id, timecode: mark.timecode, end_timecode: mark.end_timecode, text: mark.text ?? item.text }))),
      addTimestamp: (value, end='') => {
        const id = crypto.randomUUID();
        setTasks(current => normalizeTasks(current.map(item => item.id === task.id ? { ...item, references: [...item.references, { ...reference, id, timecode: value, end_timecode: end, text: '' }] } : item)));
        return { taskId: task.id, referenceId: id, timecode: value, end_timecode: end, text: '' };
      },
      editNote: (taskId, referenceId, text) => setTasks(current => current.map(item => item.id === taskId ? { ...item, references: item.references.map(mark => mark.id === referenceId ? { ...mark, text } : mark) } : item)),
      editTimestamp: (taskId, referenceId, value, end='') => {
        if (!value.trim()) setTasks(current => normalizeTasks(current.map(item => item.id === taskId ? { ...item, references: item.references.filter(mark => mark.id !== referenceId) } : item)));
        else setTasks(current => current.map(item => item.id === taskId ? { ...item, references: item.references.map(mark => mark.id === referenceId ? { ...mark, timecode: value, end_timecode: end } : mark) } : item));
      },
      setTimecode: value => updateReferenceTimecode(task.id, reference.id, value),
    });
  };
  const renderReferences = (task: Task) => task.references?.filter((reference, index, references) => references.findIndex(item => item.relative_path === reference.relative_path) === index).map(reference => {
    const file = files.find(item => item.relative_path === reference.relative_path);
    const selectedReference = task.references.find(item => `${task.id}:${item.id}` === activePreviewId);
    const mediaSelected = selectedReference?.relative_path === reference.relative_path;
    const markerCount = task.references.filter(mark => mark.relative_path === reference.relative_path && mark.timecode.trim()).length;
    const Icon = file?.kind === 'audio' ? AudioLines : file?.kind === 'image' ? Image : file?.kind === 'video' ? Video : File;
    return <div className="cen-ref-wrap" key={reference.id}>
      <div className="cen-ref-chip">
        <button type="button" className="cen-ref-label" title={reference.relative_path} disabled={!file} aria-pressed={mediaSelected}           onPointerDown={event => { if (!file || event.button !== 0 || nativeBusy.current) return; draggedMedia.current = false; drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, path: file.path }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            const pending = drag.current;
            if (!pending || pending.pointerId !== event.pointerId || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
            draggedMedia.current = true;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            nativeBusy.current = true;
            void startNativeFileDrag(clientPath, [pending.path]).catch(reason => setError(String(reason))).finally(() => { nativeBusy.current = false; });
          }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onDragStart={event => event.preventDefault()} onClick={() => {
          if (draggedMedia.current) { draggedMedia.current = false; return; }
          if (!file) return;
          openReferencePreview(task, reference, file);
        }}>
          <Icon size={13}/><span>{reference.name}</span>{markerCount > 0 && <Clock3 size={11} aria-label="Has timestamps"/>}
        </button>

      </div>
    </div>;
  });
  const renderMarkers = (task: Task) => {
    const markers = task.references.filter(reference => reference.timecode.trim());
    if (!markers.length) return null;
    return <div className="cen-note-markers" aria-label="Timestamps">{[...markers].sort((a,b) => a.timecode.localeCompare(b.timecode)).map(reference => {
      const file = files.find(item => item.relative_path === reference.relative_path);
      const markerText = reference.text ?? task.text;
      return <div className={`cen-marker-row ${activePreviewId === `${task.id}:${reference.id}` ? 'selected' : ''} ${playbackActiveIds.includes(`${task.id}:${reference.id}`)?'playback-active':''}`} aria-current={playbackActiveIds.includes(`${task.id}:${reference.id}`)?'time':undefined} data-marker-id={reference.id} data-marker-task={task.id} key={reference.id}>
        <button type="button" className="cen-note-marker" aria-pressed={activePreviewId === `${task.id}:${reference.id}`} disabled={!file} title={`Open ${reference.name} at ${reference.timecode}`} onClick={() => { if (file) openReferencePreview(task, reference, file); }}><Clock3 size={12}/><span>{formatNoteTime(parseNoteTime(reference.timecode)??0)}{reference.end_timecode&&<><br/><span className="cen-range-end">&ndash; {formatNoteTime(parseNoteTime(reference.end_timecode)??0)}</span></>}</span></button>
        {editingMarker === reference.id ? <input autoFocus className="cen-marker-text" aria-label={`Note at ${reference.timecode}`} placeholder="Add a marker note..." value={markerText} onClick={event => event.stopPropagation()} onFocus={event => { const field=event.currentTarget; requestAnimationFrame(() => field.setSelectionRange(field.value.length,field.value.length)); }} onBlur={() => setEditingMarker(null)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); } }} onChange={event => { const text=event.target.value; setTasks(current => current.map(item => item.id === task.id ? { ...item, references: item.references.map(mark => mark.id === reference.id ? { ...mark, text } : mark) } : item)); }}/> : <span className={`cen-marker-caption ${markerText ? '' : 'empty'}`} tabIndex={0} role="textbox" aria-readonly="true" aria-label={`Note at ${reference.timecode}. Double-click or press Enter to edit`} onClick={event => event.stopPropagation()} onMouseDown={event => { if (event.detail > 1) event.preventDefault(); }} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); setEditingMarker(reference.id); }} onKeyDown={event => { if(event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); setEditingMarker(reference.id); } }}>{markerText || 'Untitled note'}</span>}
        <button type="button" className="cen-marker-remove" aria-label={`Remove timestamp ${reference.timecode}`} onClick={() => setTasks(current => current.map(item => item.id === task.id ? { ...item, references: item.references.filter(mark => mark.id !== reference.id) } : item))}><Trash2 size={11}/></button>
      </div>;
    })}</div>;
  };

  return <section ref={panel} className="cen-panel" aria-label="Client notes">
    <header className="cen-heading">
      <div className="cen-title"><NotebookPen size={14}/><strong>Notes</strong><span className="cen-count">{activeCount}</span></div>
      <div className="cen-heading-actions"><span className={`cen-save-status ${status}`} role="status">{!loaded ? status === 'error' ? 'Unavailable' : <LoaderCircle size={12} className="cf-spin"/> : status === 'saving' ? 'Saving…' : status === 'error' ? 'Not synced' : 'Synced'}</span>
        <button type="button" className="cen-refresh" title="Refresh notes" aria-label="Refresh notes" onClick={() => void sync.current?.refresh(true)}><RefreshCw size={12}/></button>
      </div>
    </header>
    {<>
      <div className="cen-task-list">
        {activeTasks.map(task => <div data-note-id={task.id} data-note-draft={isDraft(task)} className={`cen-task-row ${reordering===task.id?'reordering':''} ${selectedTask===task.id?'selected':''} ${completing.has(task.id)?'completing':''} ${dropTarget?.id===task.id ? dropTarget.before ? 'drop-before' : 'drop-after' : ''}`} key={task.id} onClick={event=>{if((event.target as Element).closest('button,input,[role="textbox"]'))return;setSelectedTask(task.id);if(!activePreviewId?.startsWith(task.id+':'))event.currentTarget.querySelector<HTMLButtonElement>('.cen-ref-label:not(:disabled)')?.click();}}>
          <button type="button" className="cen-reorder" disabled={isDraft(task)} title="Drag to reorder; use arrow keys to move" aria-label={`Reorder note: ${task.text}`} onPointerDown={event => {
            if (event.button !== 0 || isDraft(task)) return;
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            noteDrag.current = { id: task.id, pointerId: event.pointerId, startY: event.clientY, target: null };
          }} onPointerMove={event => {
            const pending = noteDrag.current;
            if (!pending || pending.pointerId !== event.pointerId || Math.abs(event.clientY - pending.startY) < 4) return;
            setReordering(pending.id);
            const list = event.currentTarget.closest('.cen-task-list');
            if (!list) return;
            const bounds = list.getBoundingClientRect();
            if (event.clientY < bounds.top + 25) list.scrollTop -= 10;
            if (event.clientY > bounds.bottom - 25) list.scrollTop += 10;
            const rows = [...list.querySelectorAll<HTMLElement>('[data-note-id]')].filter(row => row.dataset.noteDraft !== 'true' && row.dataset.noteId !== pending.id);
            const target = rows.find(row => event.clientY < row.getBoundingClientRect().bottom) || rows[rows.length - 1];
            if (!target) return;
            const rect = target.getBoundingClientRect();
            pending.target = { id: target.dataset.noteId!, before: event.clientY < rect.top + rect.height / 2 };
            setDropTarget(pending.target);
          }} onPointerUp={event => {
            const pending = noteDrag.current;
            if (!pending || pending.pointerId !== event.pointerId) return;
            const target = pending.target;
            if (target) setTasks(current => {
              const moving = current.find(item => item.id === pending.id);
              if (!moving || moving.completed || isDraft(moving)) return current;
              const next = current.filter(item => item.id !== pending.id);
              const index = next.findIndex(item => item.id === target.id && !item.completed && !isDraft(item));
              if (index < 0) return current;
              next.splice(index + (target.before ? 0 : 1), 0, moving);
              return normalizeTasks(next);
            });
            noteDrag.current = null; setReordering(null); setDropTarget(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => { noteDrag.current = null; setReordering(null); setDropTarget(null); }} onLostPointerCapture={() => { noteDrag.current = null; setReordering(null); setDropTarget(null); }} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();const index=activeTasks.findIndex(item=>item.id===task.id);const target=activeTasks[index+(event.key==='ArrowUp'?-1:1)];if(target)moveTask(task.id,target.id);}}}><GripVertical size={13}/></button>
          <button type="button" className="cen-task-toggle" role="checkbox" aria-checked={completing.has(task.id)} aria-label={isDraft(task) ? 'New note checkbox' : `Mark complete: ${task.text}`} disabled={isDraft(task)} onClick={() => completeTask(task.id)}>{completing.has(task.id)&&<Check size={12}/>}</button>
          <div className="cen-task-input-wrap"><div className="cen-task-main">
            <textarea rows={1} ref={node => { if (node) inputRefs.current.set(task.id, node); else inputRefs.current.delete(task.id); }} value={task.text} style={{ width: `${Math.max(task.text ? 6 : 15, Math.min(90, Math.max(...task.text.split('\n').map(line => line.length)) + 2))}ch` }} onMouseDown={event => { if(event.currentTarget.readOnly || !task.text) { if(event.detail > 1) event.preventDefault(); } }} readOnly={!isDraft(task)&&editingTask!==task.id} onDoubleClick={event=>{if(isDraft(task)&&!task.text){event.preventDefault();return;}if(editingTask!==task.id){event.preventDefault();setEditingTask(task.id);requestAnimationFrame(()=>{const field=inputRefs.current.get(task.id);field?.focus();field?.setSelectionRange(field.value.length,field.value.length);});}}} onFocus={()=>{if(isDraft(task))setEditingTask(task.id);}} onBlur={()=>setEditingTask(current=>current===task.id?null:current)} aria-label={isDraft(task) ? 'New editing note' : 'Editing task'} placeholder={isDraft(task) ? "Add a note..." : "Untitled note"} onChange={event => {
              event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
              const value = event.target.value, position = event.target.selectionStart ?? value.length;
              updateTask(task.id, { text: value });
              const before = value.slice(0, position), at = before.lastIndexOf('@');
              if (at >= 0 && !/[\s\n]/.test(before.slice(at + 1)) && (at === 0 || /[\s([{]/.test(before[at - 1]))) {
                placePicker(event.currentTarget);
                setMention({ taskId: task.id, start: at, query: before.slice(at + 1) }); setMentionFile(null); setCategory('all'); setActive(0);
              } else if (mention?.taskId === task.id) closePicker();
            }} onKeyDown={event => {
              if(event.currentTarget.readOnly)return;
              if (event.key === 'Enter' && mention?.taskId === task.id) {
                event.preventDefault();
                if (!mentionFile && results.length) selectMedia(results[active]);
                return;
              }
              if (mention?.taskId === task.id && !mentionFile && results.length && event.key === 'ArrowDown') { event.preventDefault(); setActive(value => (value + 1) % results.length); }
              else if (mention?.taskId === task.id && !mentionFile && results.length && event.key === 'ArrowUp') { event.preventDefault(); setActive(value => (value + results.length - 1) % results.length); }
              else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addAfter(); }
              else if (event.key === 'Backspace' && !task.text && !isDraft(task) && event.currentTarget.selectionStart === 0) { event.preventDefault(); removeTask(task.id); }
            }} />
            {Boolean(task.references?.length) && <div className="cen-ref-list">{renderReferences(task)}</div>}
          </div>
            {renderMarkers(task)}
          </div>
          <button type="button" className="cen-attach" title="Attach media" aria-label="Attach media" onClick={()=>{const field=inputRefs.current.get(task.id);if(field){field.focus();field.setSelectionRange(task.text.length,task.text.length);placePicker(field);setMention({taskId:task.id,start:task.text.length,query:''});setCategory('all');setActive(0);}}}>@</button><button type="button" className={`cen-task-remove ${isDraft(task)?'empty':''}`} aria-label={`Remove task: ${task.text || 'empty task'}`} disabled={isDraft(task)} onClick={() => removeTask(task.id)}><Trash2 size={13}/></button>
        </div>)}
      </div>
      {completedTasks.length > 0 && <details className="cen-completed" aria-label="Completed editing tasks">
        <summary><ChevronRight size={12}/><span>Completed</span><small>{completedTasks.length}</small></summary>
        {completedTasks.map(task => <div className={`cen-task-row completed ${selectedTask===task.id?'selected':''}`} key={task.id} onClick={()=>setSelectedTask(task.id)}>
          <span className="cen-reorder-space" aria-hidden="true"/><button type="button" className="cen-task-toggle checked" role="checkbox" aria-checked={true} aria-label={`Mark incomplete: ${task.text}`} onClick={() => updateTask(task.id, { completed: false })}><Check size={12}/></button>
          <div className="cen-task-input-wrap"><div className="cen-task-main"><textarea rows={1} ref={node => { if (node) inputRefs.current.set(task.id, node); else inputRefs.current.delete(task.id); }} value={task.text} style={{ width: `${Math.max(task.text ? 6 : 15, Math.min(90, Math.max(...task.text.split('\n').map(line => line.length)) + 2))}ch` }} onMouseDown={event => { if(event.currentTarget.readOnly || !task.text) { if(event.detail > 1) event.preventDefault(); } }} readOnly={editingTask!==task.id} onDoubleClick={event=>{if(editingTask!==task.id){event.preventDefault();setEditingTask(task.id);requestAnimationFrame(()=>{const field=inputRefs.current.get(task.id);field?.focus();field?.setSelectionRange(field.value.length,field.value.length);});}}} onBlur={()=>setEditingTask(null)} aria-label="Completed editing task" onChange={event => updateTask(task.id, { text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addAfter(); } }}/>{Boolean(task.references?.length) && <div className="cen-ref-list">{renderReferences(task)}</div>}</div>{renderMarkers(task)}</div>
          <button type="button" className="cen-task-remove" aria-label={`Remove task: ${task.text}`} onClick={() => removeTask(task.id)}><Trash2 size={13}/></button>
        </div>)}
      </details>}

    </>}
    {mention && <div className="cen-mentions" ref={picker} onWheel={event => event.stopPropagation()} style={pickerPosition ? { left: pickerPosition.left, top: pickerPosition.top } : undefined}>
      {!mentionFile ? <>
        <nav className="cen-mention-tabs" aria-label="Media type">{categories.map(({ id, name, Icon }) => <button type="button" key={id} aria-pressed={category === id} onClick={() => { setCategory(id); setActive(0); }}><Icon size={12}/>{name}</button>)}</nav>
        <div role="listbox" aria-label="Media files" className="cen-mention-results">{results.length ? results.map((file, index) => {
          const Icon = file.kind === 'audio' ? AudioLines : file.kind === 'image' ? Image : Video;
          return <button type="button" role="option" aria-selected={index === active} key={file.relative_path} onMouseDown={event => event.preventDefault()} onClick={() => selectMedia(file)}><Icon size={13}/><strong>{file.name}</strong><small>{file.relative_path}</small></button>;
        }) : <p>No matching media files</p>}</div>
      </> : <div className="cen-mention-timecode">
        <button type="button" className="cen-mention-back" onClick={() => { setMentionFile(null); requestAnimationFrame(() => inputRefs.current.get(mention.taskId)?.focus()); }}>Back to media</button>
        <strong title={mentionFile.relative_path}>@{mentionFile.name}</strong><small>{mentionFile.relative_path}</small>
        <footer><button type="button" className="cen-mention-cancel" onClick={closePicker}>Cancel</button><button type="button" onClick={() => insertReference()}>Insert reference</button></footer>
      </div>}
    </div>}
    {error && <p className="cen-error" role="alert" title={error}>Notes couldn’t sync. Check the shared folder connection. Retrying automatically.</p>}
  </section>;
}
