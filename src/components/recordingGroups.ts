export type Recording = {
  id:string; name:string; source_created:string|null; source_modified:string|null;
  timestamp_warning:string|null; group_id?:string|null; group_name:string|null;
};

// Times are only an organising hint. Missing or suspect dates never imply a match.
export function recordingGroups<T extends Recording>(files:T[]) {
  const groups:{id:string;name:string;files:T[];automatic:boolean}[]=[];
  const loose:T[]=[];
  for(const file of files){
    const id=file.group_id||(file.group_name?`legacy:${file.group_name}`:null);
    if(id&&!id.startsWith('auto:')&&!id.startsWith('suggested-')){const existing=groups.find(group=>group.id===id);if(existing)existing.files.push(file);else groups.push({id,name:file.group_name||'Recording',files:[file],automatic:false});}
    else loose.push(file);
  }
  const dated=loose.flatMap(file=>{
    const raw=file.source_created||file.source_modified;
    if(file.timestamp_warning||!raw||!/^\d+$/.test(raw))return [];
    const time=BigInt(raw);
    // Reject dates outside JavaScript's displayable range; preserve nanosecond
    // precision for the grouping boundary instead of rounding through Number.
    if(time<=0n||time>8_640_000_000_000_000n*1_000_000n)return [];
    return [{file,time}];
  }).sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:a.file.id.localeCompare(b.file.id));
  const used=new Set<string>();
  for(let i=0;i<dated.length;){
    const first=dated[i];const batch=[first.file];let j=i+1;
    // Anchor the window to the first recording, avoiding a chain across a whole show.
    while(j<dated.length&&dated[j].time-first.time<=300_000_000_000n)batch.push(dated[j++].file);
    if(batch.length>1){
      const date=new Date(Number(first.time/1_000_000n));
      groups.push({id:`auto:${first.file.id}`,name:date.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),files:batch,automatic:true});
      batch.forEach(file=>used.add(file.id));
    }
    i=j;
  }
  const unsorted=loose.filter(file=>!used.has(file.id));
  if(unsorted.length)groups.push({id:'unsorted',name:'No time match',files:unsorted,automatic:false});
  return groups;
}
