type PendingSource = {path:string;size:number;modified?:string|null};
type CollectedSource = {source:string;relative_path:string;inbox_path:string;size:number;source_modified:string|null;status:string;sha256:string};
const normalize=(path:string)=>path.replace(/\\/g,'/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').replace(/\/+$/,'').toLowerCase();

/** Only remove known, verified source versions; changed or uncertain inputs remain collectable. */
export function pendingIngestSources<T extends PendingSource>(sources:T[],collected:CollectedSource[]):T[]{
  const versions=new Set<string>();
  for(const file of collected){
    if(!['Verified','Filed'].includes(file.status)||!file.sha256||!file.source_modified)continue;
    for(const path of [file.source,`${file.source}/${file.relative_path}`,file.inbox_path]){
      versions.add(JSON.stringify([normalize(path),file.size,file.source_modified]));
    }
  }
  return sources.filter(source=>!source.modified||!versions.has(JSON.stringify([normalize(source.path),source.size,source.modified])));
}
