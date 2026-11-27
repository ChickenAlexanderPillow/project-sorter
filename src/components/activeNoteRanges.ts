import {parseNoteTime} from './noteTiming.ts';

/** Out is exclusive: adjacent ranges do not both light up at their shared boundary. */
export function noteRangeContains(time:number,start:number,end?:number){
  return Number.isFinite(time)&&end!==undefined&&end>start&&time>=start&&time<end;
}
export function activeNoteRangeIds(markers:{taskId:string;referenceId:string;timecode:string;end_timecode?:string}[],time:number){
  return markers.filter(marker=>{
    const first=parseNoteTime(marker.timecode),last=marker.end_timecode?parseNoteTime(marker.end_timecode):null;
    return first!==null&&last!==null&&noteRangeContains(time,first,last);
  }).map(marker=>`${marker.taskId}:${marker.referenceId}`);
}
