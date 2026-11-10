import { recordingGroups, type Recording, type RecordingMetadata } from './recordingGroups.ts';
export type ClientAsset={name:string;path:string;relative_path:string;kind:string;variant:string;size:number;modified_ms:number|null;created_ms?:number|null};
export type ClientRecordingAsset=ClientAsset&Recording;
export function clientRecordingFiles(files:ClientAsset[],metadata:Record<string,RecordingMetadata|null>):ClientRecordingAsset[]{
  return files.map(file=>({...file,id:file.path,source_created:null,source_modified:null,timestamp_warning:null,group_name:null,
    recording_metadata:['audio','video'].includes(file.kind)?metadata[file.path]||null:null}));
}
export function clientOverlapGroups(files:ClientRecordingAsset[]){
  return recordingGroups(files).map(group=>({variant:group.id==='unsorted'?'Other files':group.name,files:[...group.files].sort((a,b)=>['project','video','audio','image','other'].indexOf(a.kind)-['project','video','audio','image','other'].indexOf(b.kind)),timeline:group.automatic}));
}
export const clientAssetCategory=(file:ClientAsset)=>({project:'Projects',video:'Video',audio:'Audio',image:'Stills'}[file.kind]||'Other');

export function clientFileTooltip(file:ClientRecordingAsset){
  if(file.kind==='project')return `${file.relative_path}\nDouble-click to open`;
  const metadata=file.recording_metadata;
  const embedded=/^\d{1,19}$/.test(metadata?.start_ns||'')&&/^(format|stream\.\d+)\.creation_time$/.test(metadata?.start_source||'');
  const raw=embedded?Number(BigInt(metadata!.start_ns!)/1_000_000n):file.created_ms;
  const date=raw!=null?new Date(raw):null;
  const created=date&&Number.isFinite(date.getTime())
    ?`${date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}, ${date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`
    :'Unavailable';
  return `${file.name}\nCreated (${embedded?'embedded':'filesystem'}): ${created}`;
}
