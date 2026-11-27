import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Files, FileVideo, FolderInput, Headphones, Image } from "lucide-react";
import { MEDIA_ROLES_BY_KIND, MEDIA_ROLE_ICONS } from "./MediaTypes";
import "./ClientMediaDrop.css";
import { useMediaDropReveal } from "./useMediaDropReveal";

export type MediaDropFolder = { path: string; role: string | null };
const folderCache = new Map<string, { at: number; promise: Promise<MediaDropFolder[]> }>();
function loadFolders(clientPath: string) {
  const cached = folderCache.get(clientPath);
  if (cached && Date.now() - cached.at < 30_000) return cached.promise;
  const promise = invoke<MediaDropFolder[]>("client_media_drop_folders", { clientPath });
  folderCache.set(clientPath, { at: Date.now(), promise });
  void promise.catch(() => folderCache.delete(clientPath));
  return promise;
}

export function ClientMediaDrop({ clientPath, kinds, active }: { clientPath: string; kinds: string[] | null; active: boolean }) {
  const [folders, setFolders] = useState<MediaDropFolder[] | null>(null);
  const [displayKinds, setDisplayKinds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    loadFolders(clientPath).then(
      value => { if (current) { setFolders(value); setError(""); } },
      reason => { if (current) setError(String(reason)); },
    );
    return () => { current = false; };
  }, [clientPath, active]);
  // Retain the last contents while fading out after the drag has left.
  useLayoutEffect(() => { if (kinds !== null) setDisplayKinds(kinds); }, [kinds]);
  const ready = Boolean(error) || (folders !== null && (kinds !== null || !active));
  useMediaDropReveal(active, ready, element);
  useLayoutEffect(() => {
    const row = element.current?.parentElement;
    return () => {
      row?.style.removeProperty('--client-drop-details-opacity');
      row?.style.removeProperty('--client-drop-regions-opacity');
    };
  }, []);
  // A mixed batch must fit the whole destination: never put audio into video folders.
  const relevant = folders?.filter(folder => !folder.role || (displayKinds.length
    ? displayKinds.every(kind => MEDIA_ROLES_BY_KIND[kind]?.includes(folder.role!))
    : folder.role === 'Miscellaneous')).sort((a, b) => {
      const order = ['Proxy video', 'Full-resolution video', 'Raw audio', 'Clean audio', 'Music', 'Stills', 'Graphics', 'Stock', 'Miscellaneous'];
      const rank = (role: string | null) => role && order.includes(role) ? order.indexOf(role) : order.length;
      return rank(a.role) - rank(b.role) || a.path.localeCompare(b.path);
    });
  const mixed = displayKinds.length > 1;
  const kindNames: Record<string, string> = { video: "Video", audio: "Audio", image: "Images", other: "Supporting files" };
  return <div ref={element} className="client-media-drop" data-mixed={mixed && Boolean(folders?.length) && !error} data-engaged="false" data-details-visible="true" data-visible="false" aria-hidden="true" aria-label="Drop files into a media folder" onClick={event => event.stopPropagation()}>
    {error ? <span className="client-media-drop-message" role="status" title={error}>Media folders unavailable</span>
      : folders === null ? null
      : !folders.length ? <span className="client-media-drop-message">No folders in 01_MEDIA</span>
      : mixed ? <div className="client-media-drop-mixed"><Files size={18} aria-hidden="true"/><span><strong>Sort mixed media</strong><small className="client-media-drop-kinds">{displayKinds.map(kind => { const Icon = kind === 'audio' ? Headphones : kind === 'video' ? FileVideo : kind === 'image' ? Image : Files; return <span key={kind}><Icon size={12} aria-hidden="true"/>{kindNames[kind] ?? kind}</span>; })}</small></span></div>
      : !relevant?.length ? <span className="client-media-drop-message" role="status"><Files size={15} aria-hidden="true"/><span>Drop one type of media at a time</span></span>
      : relevant.map(folder => {
        const Icon = folder.role === 'Stills' ? Image : MEDIA_ROLE_ICONS[folder.role as keyof typeof MEDIA_ROLE_ICONS] ?? FolderInput;
        return <div key={folder.path} className="client-media-drop-folder" data-media-drop-folder={folder.path} title={`Copy to ${folder.path}`}>
          <span className="client-media-drop-icon" aria-hidden="true"><Icon size={16}/><FolderInput size={16}/></span>
          <span>{folder.path.split("/").pop()!.replace(/^\d+[_ -]*/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase())}</span>
        </div>;
      })}
  </div>;
}
