import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AtSign, AudioLines, Check, ChevronDown, ChevronRight, Eye, File, Files, GripVertical, Headphones, Image, LoaderCircle, NotebookPen, Package, Plus, Trash2, Video } from 'lucide-react';
import { startNativeFileDrag } from './nativeFileDrag';

type MediaFile = { name: string; path: string; relative_path: string; kind: string };
type Listing = { files: MediaFile[] };
type MediaReference = { id: string; relative_path: string; name: string; timecode: string };
type Task = { id: string; text: string; completed: boolean; references: MediaReference[] };
export type ClientNoteMarker = { taskId: string; referenceId: string; timecode: string };
export type ClientNotePreview = { taskId: string; referenceId: string; path: string; name: string; kind: string; timecode: string; markers: ClientNoteMarker[]; setTimecode: (value: string) => void };
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

export function ClientEditNotes({ clientPath, activePreviewId, onPreviewChange }: { clientPath: string; activePreviewId: string | null; onPreviewChange: (preview: ClientNotePreview | null) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [mention, setMention] = useState<{ taskId: string; start: number; query: string } | null>(null);
  const [mentionFile, setMentionFile] = useState<MediaFile | null>(null);
  const [category, setCategory] = useState<MediaCategory>('all');
  const [active, setActive] = useState(0);
  const [pickerPosition, setPickerPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const picker = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; path: string } | null>(null);
  const nativeBusy = useRef(false);
  const cursor = useRef<{ id: string; position: number } | null>(null);
  const lastSaved = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(false); setTasks([]); setError(''); setStatus('saved'); setMention(null); setMentionFile(null);
    void invoke<Task[]>('client_edit_notes_load', { clientPath }).then(saved => {
      if (!current) return;
      const ordered = orderTasks(saved.map(task => ({ ...task, references: task.references || [] })));
      lastSaved.current = signature(ordered); setTasks(normalizeTasks(ordered)); setCollapsed(ordered.length === 0); setLoaded(true);
    }).catch(reason => { if (current) { setError(String(reason)); setStatus('error'); } });
    void invoke<Listing>('client_files_list', { clientPath, category: 'all' })
      .then(listing => { if (current) setFiles(listing.files.filter(file => file.kind !== 'project')); })
      .catch(() => { /* Notes remain usable when media folders are unavailable. */ });
    return () => { current = false; if (timer.current) clearTimeout(timer.current); };
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

  useEffect(() => {
    if (!loaded) return;
    const currentTasks = savedTasks(tasks);
    const current = signature(currentTasks);
    if (lastSaved.current === current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setStatus('saving');
      void invoke('client_edit_notes_save', { clientPath, tasks: currentTasks }).then(() => { lastSaved.current = current; setStatus('saved'); setError(''); })
        .catch(reason => { setError(String(reason)); setStatus('error'); });
    }, 700);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [clientPath, loaded, tasks]);

  useEffect(() => { if (loaded && savedTasks(tasks).length === 0) setCollapsed(true); }, [loaded, tasks]);
  useEffect(() => {
    if (!loaded || !files.length) return;
    const migrated = tasks.map(task => migrateInlineReferences(task, files));
    if (signature(migrated) !== signature(tasks)) setTasks(migrated);
  }, [files, loaded]);

  const categories = CATEGORIES.filter(item => item.id === 'all' || files.some(file => inCategory(file, item.id)));
  const results = mention && !mentionFile ? files.filter(file => inCategory(file, category)
    && `${file.name} ${file.relative_path}`.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const openNewTask = () => {
    setCollapsed(false);
    const draft = tasks.find(isDraft);
    if (draft) requestAnimationFrame(() => inputRefs.current.get(draft.id)?.focus());
  };
  const updateTask = (id: string, update: Partial<Task>) => setTasks(current => normalizeTasks(current.map(task => task.id === id ? { ...task, ...update } : task)));
  const updateReferenceTimecode = (taskId: string, referenceId: string, value: string) => setTasks(current => normalizeTasks(current.map(task => task.id === taskId ? { ...task, references: task.references.map(reference => reference.id === referenceId ? { ...reference, timecode: value } : reference) } : task)));
  const removeTask = (id: string) => {
    if (tasks.some(task => task.id === id && isDraft(task))) return;
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
  const selectMedia = (file: MediaFile) => setMentionFile(file);
  const placePicker = (input: HTMLInputElement) => {
    const panelRect = panel.current?.getBoundingClientRect();
    if (!panelRect) return;
    const inputRect = input.getBoundingClientRect();
    const width = Math.min(320, panelRect.width - 16);
    setPickerPosition({
      left: Math.max(8, Math.min(inputRect.left - panelRect.left, panelRect.width - width - 8)),
      top: inputRect.bottom - panelRect.top + 4,
    });
  };
  const insertReference = () => {
    if (!mention || !mentionFile) return;
    const field = inputRefs.current.get(mention.taskId);
    if (!field) return;
    const task = tasks.find(item => item.id === mention.taskId);
    if (!task) return;
    const before = task.text.slice(0, mention.start), after = task.text.slice(field.selectionStart ?? mention.start);
    const nextText = `${before}${before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after}`;
    const reference: MediaReference = { id: crypto.randomUUID(), relative_path: mentionFile.relative_path, name: mentionFile.name, timecode: '' };
    setTasks(current => normalizeTasks(current.map(item => item.id === task.id ? { ...item, text: nextText, references: [...(item.references || []), reference] } : item)));
    closePicker(); cursor.current = { id: task.id, position: before.length };
    requestAnimationFrame(() => {
      const input = inputRefs.current.get(task.id);
      if (input && cursor.current) { input.focus(); input.setSelectionRange(cursor.current.position, cursor.current.position); }
    });
  };
  const activeTasks = tasks.filter(task => !task.completed);
  const completedTasks = tasks.filter(task => task.completed);
  const activeCount = activeTasks.filter(task => !isDraft(task)).length;
  const renderReferences = (task: Task) => task.references?.map(reference => {
    const file = files.find(item => item.relative_path === reference.relative_path);
    const previewId = `${task.id}:${reference.id}`;
    const Icon = file?.kind === 'audio' ? AudioLines : file?.kind === 'image' ? Image : file?.kind === 'video' ? Video : File;
    return <div className="cen-ref-wrap" key={reference.id}>
      <div className="cen-ref-chip">
        <button type="button" className="cen-ref-label" title={reference.relative_path} disabled={!file} aria-pressed={activePreviewId === previewId} onClick={() => {
          if (!file) return;
          onPreviewChange(activePreviewId === previewId ? null : { taskId: task.id, referenceId: reference.id, path: file.path, name: file.name, kind: file.kind, timecode: reference.timecode, markers: tasks.flatMap(item => item.references.filter(mark => mark.relative_path === reference.relative_path && mark.timecode.trim()).map(mark => ({ taskId: item.id, referenceId: mark.id, timecode: mark.timecode }))), setTimecode: value => updateReferenceTimecode(task.id, reference.id, value) });
        }}>
          <Icon size={13}/><span>{reference.name}{reference.timecode && <time> · {reference.timecode}</time>}</span><Eye size={12}/>
        </button>
        <button type="button" className="cen-ref-drag" title={file ? `Drag ${reference.name} into Premiere` : 'Media file unavailable'} aria-label={file ? `Drag ${reference.name} into Premiere` : `${reference.name} unavailable`} disabled={!file}
          onPointerDown={event => { if (!file || event.button !== 0 || nativeBusy.current) return; drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, path: file.path }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            const pending = drag.current;
            if (!pending || pending.pointerId !== event.pointerId || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            nativeBusy.current = true;
            void startNativeFileDrag(clientPath, [pending.path]).catch(reason => setError(String(reason))).finally(() => { nativeBusy.current = false; });
          }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onDragStart={event => event.preventDefault()}><GripVertical size={13}/></button>
      </div>
    </div>;
  });

  return <section ref={panel} className="cen-panel" aria-label="Client notes">
    <header className="cen-heading">
      <button type="button" className="cen-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<NotebookPen size={14}/><strong>Notes</strong>
        <span className="cen-count">{activeCount}{completedTasks.length ? ` · ${completedTasks.length} done` : ''}</span>
      </button>
      <div className="cen-heading-actions"><span role="status">{!loaded ? status === 'error' ? 'Unavailable' : <LoaderCircle size={12} className="cf-spin"/> : status === 'saving' ? 'Saving…' : status === 'error' ? 'Couldn’t save' : 'Saved'}</span>
        <button type="button" className="cen-add" onClick={openNewTask} disabled={!loaded}><Plus size={13}/><span>Add task</span></button>
      </div>
    </header>
    {!collapsed && <>
      <div className="cen-task-list">
        {activeTasks.map(task => <div className="cen-task-row" key={task.id}>
          <button type="button" className="cen-task-toggle" role="checkbox" aria-checked={false} aria-label={isDraft(task) ? 'New note checkbox' : `Mark complete: ${task.text}`} disabled={isDraft(task)} onClick={() => updateTask(task.id, { completed: true })}/>
          <div className="cen-task-input-wrap">
            <input ref={node => { if (node) inputRefs.current.set(task.id, node); else inputRefs.current.delete(task.id); }} value={task.text} aria-label={isDraft(task) ? 'New editing note' : 'Editing task'} placeholder={isDraft(task) ? 'Add a note… Type @ to reference media' : 'Describe an edit… Type @ to reference media'} onChange={event => {
              const value = event.target.value, position = event.target.selectionStart ?? value.length;
              updateTask(task.id, { text: value });
              const before = value.slice(0, position), at = before.lastIndexOf('@');
              if (at >= 0 && !/[\s\n]/.test(before.slice(at + 1)) && (at === 0 || /[\s([{]/.test(before[at - 1]))) {
                placePicker(event.currentTarget);
                setMention({ taskId: task.id, start: at, query: before.slice(at + 1) }); setMentionFile(null); setCategory('all'); setActive(0);
              } else if (mention?.taskId === task.id) closePicker();
            }} onKeyDown={event => {
              if (event.key === 'Enter' && mention?.taskId === task.id) {
                event.preventDefault();
                if (!mentionFile && results.length) selectMedia(results[active]);
                return;
              }
              if (mention?.taskId === task.id && !mentionFile && results.length && event.key === 'ArrowDown') { event.preventDefault(); setActive(value => (value + 1) % results.length); }
              else if (mention?.taskId === task.id && !mentionFile && results.length && event.key === 'ArrowUp') { event.preventDefault(); setActive(value => (value + results.length - 1) % results.length); }
              else if (event.key === 'Enter') { event.preventDefault(); addAfter(); }
              else if (event.key === 'Backspace' && !task.text && !isDraft(task) && event.currentTarget.selectionStart === 0) { event.preventDefault(); removeTask(task.id); }
            }} />
            {Boolean(task.references?.length) && <div className="cen-ref-list">{renderReferences(task)}</div>}
          </div>
          <button type="button" className="cen-task-remove" aria-label={`Remove task: ${task.text || 'empty task'}`} disabled={isDraft(task)} onClick={() => removeTask(task.id)}><Trash2 size={13}/></button>
        </div>)}
      </div>
      {completedTasks.length > 0 && <section className="cen-completed" aria-label="Completed editing tasks">
        <h4><span/>Completed <small>{completedTasks.length}</small></h4>
        {completedTasks.map(task => <div className="cen-task-row completed" key={task.id}>
          <button type="button" className="cen-task-toggle checked" role="checkbox" aria-checked={true} aria-label={`Mark incomplete: ${task.text}`} onClick={() => updateTask(task.id, { completed: false })}><Check size={12}/></button>
          <div className="cen-task-input-wrap"><input ref={node => { if (node) inputRefs.current.set(task.id, node); else inputRefs.current.delete(task.id); }} value={task.text} aria-label="Completed editing task" onChange={event => updateTask(task.id, { text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addAfter(); } }}/>{Boolean(task.references?.length) && <div className="cen-ref-list">{renderReferences(task)}</div>}</div>
          <button type="button" className="cen-task-remove" aria-label={`Remove task: ${task.text}`} onClick={() => removeTask(task.id)}><Trash2 size={13}/></button>
        </div>)}
      </section>}
      <div className="cen-task-footer"><span>Press Enter to add another task</span><span><AtSign size={12}/> Mention media · add timestamp from preview</span></div>
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
        <footer><button type="button" className="cen-mention-cancel" onClick={closePicker}>Cancel</button><button type="button" onClick={insertReference}>Insert reference</button></footer>
      </div>}
    </div>}
    {error && <p className="cen-error" role="alert">Tasks couldn’t be {loaded ? 'saved' : 'loaded'}. Check the NAS connection, then reopen this client to retry.</p>}
  </section>;
}
