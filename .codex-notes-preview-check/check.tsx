import React from 'react';
import {createRoot} from 'react-dom/client';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';
import {ClientFiles} from '../src/components/ClientFiles';
import '../src/App.css';
import '../src/components/ClientWorkspace.css';
import '../src/components/ImportSelection.css';
import '../src/components/MediaTransition.css';
mockWindows('main');
const video={name:'Preview recording.mp4',path:'fixture.mp4',relative_path:'01_MEDIA/fixture.mp4',kind:'video',variant:'Raw',size:1000000,modified_ms:0};
const audio={...video,name:'Preview audio.m4a',path:'fixture.m4a',relative_path:'01_MEDIA/fixture.m4a',kind:'audio'};
const project={...video,name:'Example edit.aep',path:'fixture.aep',relative_path:'02_EDIT/Example.aep',kind:'project'};
let tasks=[
 {id:'task-a',text:'Review the opening section',completed:false,references:[{id:'clip',relative_path:video.relative_path,name:video.name,timecode:''},{id:'range-a',relative_path:video.relative_path,name:video.name,timecode:'00:00:03',end_timecode:'00:00:08',text:'First range'}]},
 {id:'task-b',text:'Check the overlapping section',completed:false,references:[{id:'range-b',relative_path:video.relative_path,name:video.name,timecode:'00:00:06',end_timecode:'00:00:11',text:'Overlapping range'}]},
 {id:'task-audio',text:'Listen to the audio',completed:false,references:[{id:'audio-range',relative_path:audio.relative_path,name:audio.name,timecode:'00:00:02',end_timecode:'00:00:07',text:'Audio range'}]}
];
mockIPC((cmd,payload:any)=>{
 if(cmd==='client_edit_notes_load')return structuredClone(tasks);
 if(cmd==='client_edit_notes_save'){tasks=structuredClone(payload.tasks);return structuredClone(tasks);}
 if(cmd==='client_files_list'){const category=payload.category;return {files:category==='all'?[video,audio,project]:category==='edit'?[project]:category==='video'?[video]:category==='audio'?[audio]:[],folders:[],truncated:false};}
 return null;
},{shouldMockEvents:true});
(window as any).__TAURI_INTERNALS__.convertFileSrc=()=>'/'+'.codex-notes-preview-check/media.mp4';
createRoot(document.getElementById('root')!).render(<main className="app" style={{display:'block',padding:'24px',boxSizing:'border-box',minHeight:'100vh'}}><div className="client-workspace"><ClientFiles projectRoot="fixture" clientPath="fixture-client" onContextMenu={()=>{}}/></div></main>);

const sizes=document.createElement('output');sizes.setAttribute('aria-label','Preview dimensions');sizes.style.cssText='position:fixed;bottom:3px;left:80px;color:#aaa;background:#222;font:10px monospace;z-index:100';document.body.append(sizes);setInterval(()=>{const q=(s:string)=>document.querySelector(s)?.getBoundingClientRect();const c=q('.cf-note-preview'),p=q('.note-preview-console'),a=q('.note-playback-actions'),e=q('.note-marker-editor');sizes.textContent=JSON.stringify({viewport:innerWidth,card:c&&[Math.round(c.x),Math.round(c.width)],console:p&&[Math.round(p.x),Math.round(p.width)],actions:a&&Math.round(a.right),editor:e&&Math.round(e.right)});},1000);
