import type { ReactNode } from 'react';
import { recordingTimeline, type Recording } from './recordingGroups';
import './RecordingTimeline.css';

export type RecordingPlacement={left:number;width:number};
export function RecordingPill({left,width}:RecordingPlacement){
  return <span className="recording-pill-track" aria-hidden="true"><i style={{left:`${left}%`,width:`${width}%`}}/></span>;
}
export function RecordingTimeline<T extends Recording>({files,children,className=''}:{files:T[];children:(file:T,placement:RecordingPlacement)=>ReactNode;className?:string}){
  const timeline=recordingTimeline(files);
  if(!timeline)return null;
  const time=(ns:bigint)=>new Date(Number(ns/1_000_000n)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  return <div className={`recording-timeline ${className}`} role="group" aria-label="Recording intervals">
    <div className="recording-timeline-scale"><span>{time(timeline.start)}</span><span>{time(timeline.end)}</span></div>
    {timeline.rows.map(({file,left,width})=>children(file,{left,width}))}
  </div>;
}
