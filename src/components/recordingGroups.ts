export type RecordingMetadata = {
  start_ns:string|null; duration_ns:string|null; start_source:string|null; duration_source:string|null;
  embedded_times?:{source:string;value:string}[]; warning:string|null; probe_error:string|null;
};
export type Recording = {
  id:string; name:string; source_created:string|null; source_modified:string|null;
  timestamp_warning:string|null; group_id?:string|null; group_name:string|null;
  recording_metadata?:RecordingMetadata|null;
};
const earliest=315_532_800_000_000_000n;
const maxDuration=604_800_000_000_000n;
// One validated interval is shared by suggestions and the visual. Legacy file dates
// alone cannot establish an interval, and copy-preservation warnings aren't media dates.
export function recordingInterval(file:Recording, now=Date.now()) {
  const m=file.recording_metadata;
  if(!m||m.warning||m.probe_error||!m.start_ns||!m.duration_ns||
    !/^\d+$/.test(m.start_ns)||!/^\d+$/.test(m.duration_ns)||
    !/^(format\.creation_time|stream\.\d+\.creation_time|filesystem_created|filesystem_modified)$/.test(m.start_source||'')||
    !['stream.duration','format.duration'].includes(m.duration_source||''))return null;
  if(m.start_source?.startsWith('filesystem_')&&file.timestamp_warning)return null;
  const start=BigInt(m.start_ns),duration=BigInt(m.duration_ns);
  if(start<earliest||start>BigInt(Math.trunc(now+86_400_000))*1_000_000n||duration<=0n||duration>maxDuration)return null;
  return {start,end:start+duration};
}
export function recordingTimeline<T extends Recording>(files:T[]) {
  const intervals=files.map(file=>({file,interval:recordingInterval(file)}));
  if(intervals.some(item=>!item.interval))return null;
  if(!intervals.length)return null;
  const start=intervals.reduce((min,item)=>item.interval!.start<min?item.interval!.start:min,intervals[0].interval!.start);
  const end=intervals.reduce((max,item)=>item.interval!.end>max?item.interval!.end:max,intervals[0].interval!.end);
  const span=Number(end-start);
  return {start,end,rows:intervals.map(({file,interval})=>({file,left:Number(interval!.start-start)/span*100,width:Number(interval!.end-interval!.start)/span*100}))};
}
export function recordingGroups<T extends Recording>(files:T[]) {
  const groups:{id:string;name:string;files:T[];automatic:boolean}[]=[];
  const loose:T[]=[];
  for(const file of files){
    const id=file.group_id||(file.group_name?`legacy:${file.group_name}`:null);
    if(id&&!id.startsWith('auto:')&&!id.startsWith('suggested-')){const existing=groups.find(group=>group.id===id);if(existing)existing.files.push(file);else groups.push({id,name:file.group_name||'Recording',files:[file],automatic:false});}
    else loose.push(file);
  }
  const dated=loose.flatMap(file=>{const interval=recordingInterval(file);return interval?[{file,...interval}]:[];})
    .sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:a.file.id.localeCompare(b.file.id));
  const used=new Set<string>();
  for(let i=0;i<dated.length;){
    const first=dated[i];const batch=[first.file];let end=first.end,j=i+1;
    // Positive overlap, transitively connected. Merely touching endpoints is not
    // simultaneous recording, so adjacent takes remain separate.
    while(j<dated.length&&dated[j].start<end){end=dated[j].end>end?dated[j].end:end;batch.push(dated[j++].file);}
    if(batch.length>1){
      const date=new Date(Number(first.start/1_000_000n));
      groups.push({id:`auto:${first.file.id}`,name:date.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),files:batch,automatic:true});
      batch.forEach(file=>used.add(file.id));
    }
    i=j;
  }
  const unsorted=loose.filter(file=>!used.has(file.id));
  if(unsorted.length)groups.push({id:'unsorted',name:'No overlap match',files:unsorted,automatic:false});
  return groups;
}
