import { useState } from "react";
import { ArrowLeft, ArrowRight, FolderInput, Pencil } from "lucide-react";
import { MEDIA_ROLES_BY_KIND, mediaRoleIcon } from "./MediaTypes";
import "./ClientDropConfirm.css";

export type DropGroup = { kind: string; label: string; file_count: number; bytes_total: number; paths: string[] };
export type DropFolder = { path: string; role: string | null };
export type DropPreview = { file_count: number; bytes_total: number; paths: string[]; groups?: DropGroup[]; folders?: DropFolder[] };
export type DropChoices = Record<string, string>;
const groupDescription = (group: DropGroup) => `${group.file_count} ${group.file_count === 1 ? ({video:'video',audio:'audio file',image:'image',other:'supporting file'} as Record<string,string>)[group.kind] ?? 'file' : group.label.toLowerCase()}`;
const folderLabel = (path: string) => path.split(/[\\/]/).pop()!.replace(/^\d+[_ -]*/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
const sizeLabel = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`;

export function ClientDropConfirm({ folder, clientName, preview, error, disabled, choices, onChoicesChange, onConfirm, onCancel }: {
  folder: string; clientName: string; preview: DropPreview | null; error: string | null; disabled: boolean;
  choices?: DropChoices; onChoicesChange?: (choices: DropChoices) => void; onConfirm: (choices: DropChoices) => void; onCancel: () => void;
}) {
  const [localChoices, setLocalChoices] = useState<DropChoices>({});
  const [editing, setEditing] = useState<string | null>(null);
  const groups = preview?.groups ?? (preview ? [{kind:'all', label:'Files', file_count:preview.file_count, bytes_total:preview.bytes_total, paths:preview.paths}] : []);
  const selected = { ...Object.fromEntries(folder ? groups.map(group => [group.kind, folder]) : []), ...(choices ?? localChoices) };
  const current = groups.find(group => group.kind === editing) ?? groups.find(group => !selected[group.kind]);
  const expanded = groups.length > 1 || Boolean(current);
  const index = current ? groups.indexOf(current) : -1;
  const roleOrder = ['Proxy video', 'Full-resolution video', 'Raw audio', 'Clean audio', 'Music', 'Stills', 'Graphics', 'Stock', 'Miscellaneous'];
  const options = (preview?.folders ?? []).filter(option => !option.role || !current || current.kind === 'other' || current.kind === 'all' || MEDIA_ROLES_BY_KIND[current.kind]?.includes(option.role)).sort((a, b) => {
    const rank = (role: string | null) => role && roleOrder.includes(role) ? roleOrder.indexOf(role) : roleOrder.length;
    return rank(a.role) - rank(b.role) || a.path.localeCompare(b.path);
  });
  const choose = (destination: string) => {
    if (!current || disabled) return;
    const next = { ...selected, [current.kind]: destination };
    setLocalChoices(next);
    onChoicesChange?.(next);
    setEditing(null);
  };
  const cancel = <button type="button" className="client-drop-cancel" onClick={onCancel}>Cancel</button>;
  const move = <button type="button" className="client-drop-accept" disabled={disabled || !preview || Boolean(error) || groups.some(group => !selected[group.kind])} onClick={() => onConfirm(selected)}>{expanded && preview ? `Move ${preview.file_count} files` : 'Move'}<ArrowRight size={14} aria-hidden="true"/></button>;
  const title = error ? "Couldn't prepare transfer" : current
    ? `Where should ${current.file_count === 1 ? 'this' : 'these'} ${current.file_count === 1 ? ({video:'video',audio:'audio file',image:'image',other:'supporting file'} as Record<string,string>)[current.kind] ?? 'file' : current.kind === 'other' ? 'supporting files' : current.kind === 'all' ? 'files' : current.kind === 'video' ? 'videos' : current.kind === 'audio' ? 'audio files' : 'images'} go?`
    : expanded ? `Review ${preview?.file_count ?? ''} files`
    : folder ? `Move ${preview?.file_count === 1 ? '1 file' : preview ? `${preview.file_count} files` : 'files'} to ${folderLabel(selected[groups[0]?.kind] || folder)}?` : 'Review file transfer';
  return <div className="client-drop-confirm" data-expanded={expanded} role="group" aria-label="Confirm file transfer"
    onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <div className="client-drop-confirm-heading"><FolderInput className="client-drop-confirm-icon" size={18} aria-hidden="true"/>
      <div className="client-drop-confirm-copy" aria-live="polite"><strong>{title}</strong>
        <span title={error || clientName}>{error || (preview ? current ? `${current.file_count} ${current.file_count === 1 ? 'file' : 'files'} \u00b7 ${sizeLabel(current.bytes_total)} \u00b7 ${index + 1} of ${groups.length}` : `${clientName} \u00b7 ${sizeLabel(preview.bytes_total)}` : 'Checking selected files\u2026')}</span>
      </div>
    </div>
    {expanded ? <>
      {current ? <div className="client-drop-picker" role="group" aria-label={`${current.label} destination`}>
        {options.length ? options.map(option => { const Icon = mediaRoleIcon('still.png', option.role || 'Miscellaneous'); return <button type="button" key={option.path} disabled={disabled} aria-pressed={selected[current.kind] === option.path} title={option.path} onClick={() => choose(option.path)}><Icon size={17} aria-hidden="true"/><span>{folderLabel(option.path)}</span></button>; }) : <span className="client-drop-no-folders">No matching folders are available.</span>}
      </div> : <div className="client-drop-summary">{groups.map(group => <button type="button" key={group.kind} title={selected[group.kind]} aria-label={`Change destination for ${group.label.toLowerCase()}`} onClick={() => setEditing(group.kind)} disabled={disabled}><span>{groupDescription(group)}</span><strong>{folderLabel(selected[group.kind])}</strong><Pencil size={12} aria-hidden="true"/></button>)}</div>}
      <div className="client-drop-confirm-footer"><div>{current && index > 0 && <button type="button" className="client-drop-back" onClick={() => setEditing(groups[index - 1].kind)}><ArrowLeft size={13}/>Back</button>}</div><div className="client-drop-confirm-actions">{cancel}{!current && move}</div></div>
    </> : <div className="client-drop-confirm-actions">{Boolean(preview?.folders?.length) && <button type="button" className="client-drop-cancel client-drop-change" disabled={disabled} onClick={() => setEditing(groups[0].kind)}>Change destination</button>}{cancel}{move}</div>}
  </div>;
}
