export function markerViewport(duration:number,start:number,end=start){
  const span=Math.min(duration,Math.max(10,Math.max(0,end-start)*1.6));
  return {zoom:duration>0&&span>0?Math.max(1,duration/span):1,center:Math.max(span/2,Math.min(duration-span/2,(start+end)/2))};
}
export function timelineSecond(clientX:number,left:number,width:number,duration:number){
  return Math.max(0,Math.min(Math.floor(duration),Math.floor((clientX-left)/Math.max(1,width)*duration)));
}
export function moveRangeBoundary(start:number,end:number,target:number,boundary:'in'|'out',duration:number){
  const second=Math.max(0,Math.min(Math.floor(duration),Math.floor(target)));
  return boundary==='in'?{start:Math.min(end-1,second),end}:{start,end:Math.max(start+1,second)};
}
/** Keep overlapping blocks and their click targets on distinct rows. */
export function markerLanes(markers:{key:string;seconds:number;endSeconds?:number;selected?:boolean}[],duration:number,width:number){
  const ends:number[]=[],rows:Record<string,number>={};
  for(const marker of [...markers].sort((a,b)=>a.seconds-b.seconds||a.key.localeCompare(b.key))){
    const x=marker.seconds/Math.max(1,duration)*width;
    const isRange=marker.endSeconds!==undefined&&marker.endSeconds>marker.seconds;
    const span=isRange?Math.max(14,(marker.endSeconds!-marker.seconds)/Math.max(1,duration)*width):16;
    const margin=marker.selected&&isRange&&span>=64?11:0;
    const left=x-(isRange?margin:8),right=x+(isRange?span+margin:8);
    let row=ends.findIndex(end=>end+6<=left);
    if(row<0)row=ends.length;
    ends[row]=right;rows[marker.key]=row;
  }
  return {rows,count:Math.max(1,ends.length)};
}
