export type IngestProgressSnapshot = {
  phase:string;source:string;completed:number;total:number;bytes_copied:number;file_size:number;completed_sources:string[];
};
export type CollectProgressState = {completed:string[];copying:string[];percent:number;count:number;total:number};
export const normalizeIngestPath=(path:string)=>path.replace(/\\/g,'/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').toLowerCase();
export const emptyCollectProgress=():CollectProgressState=>({completed:[],copying:[],percent:0,count:0,total:0});

/** Backend counters restart for each source; keep one verified, size-weighted batch. */
export function advanceCollectProgress(previous:CollectProgressState,sources:{path:string;size:number}[],progress:IngestProgressSnapshot):CollectProgressState{
  const keys=sources.map(file=>normalizeIngestPath(file.path));
  const current=keys.indexOf(normalizeIngestPath(progress.source));
  const completed=new Set(previous.completed);
  if(progress.phase==='collecting')for(const path of progress.completed_sources||[]){const key=normalizeIngestPath(path);if(keys.includes(key))completed.add(key);}
  if(progress.phase==='complete')keys.forEach(path=>completed.add(path));
  // Sources are processed sequentially, even if small files finish between polls.
  if(current>=0)keys.slice(0,current).forEach(path=>completed.add(path));
  const copying=new Set(previous.copying);
  if(current>=0&&progress.phase==='collecting')copying.add(keys[current]);
  let fraction=0;
  if(current>=0&&!completed.has(keys[current])){
    if(progress.phase==='collecting'&&progress.file_size>0)fraction=Math.min(.9,Math.max(0,progress.bytes_copied/progress.file_size)*.9);
    else if(progress.phase==='verifying'&&copying.has(keys[current]))fraction=.95;
  }
  const totalBytes=sources.reduce((sum,file)=>sum+Math.max(1,file.size),0);
  const finishedBytes=sources.reduce((sum,file,index)=>sum+Math.max(1,file.size)*(completed.has(keys[index])?1:index===current?fraction:0),0);
  const count=keys.filter(key=>completed.has(key)).length;
  const percent=keys.length&&count===keys.length?100:Math.min(99,Math.max(previous.percent,Math.floor(finishedBytes/Math.max(1,totalBytes)*100)));
  return {completed:[...completed],copying:[...copying],percent,count,total:sources.length};
}

export function pendingCollectFiles<T extends {status:string}>(files:T[]):T[]{return files.filter(file=>file.status!=='Filed');}
export function recategorizePendingFiles<T extends {id:string;status:string;role:string;destinations?:string[]}>(files:T[],ids:string[],role:string):T[]{
  const selected=new Set(ids);
  return files.map(file=>selected.has(file.id)&&file.status!=='Filed'&&!file.destinations?.length?{...file,role}:file);
}
