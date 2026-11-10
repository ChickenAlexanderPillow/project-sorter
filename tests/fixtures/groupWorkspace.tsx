// Run npm run dev, then open /tests/fixtures/groupWorkspace.html.
// Uses the production component and CSS; no NAS files or Tauri calls are needed.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {GroupWorkspace} from '../../src/components/GroupWorkspace';
import '../../src/App.css';
import '../../src/components/IngestWorkspace.css';
const base=BigInt(Date.UTC(2026,0,1,12))*1_000_000n;
const file=(id:string,start:number,duration:number)=>({id,name:id,inbox_path:'',role:id.endsWith('.wav')?'Raw audio':'Full-resolution video',status:'Verified',client:null,clients:[],client_paths:[],source_created:null,source_modified:null,timestamp_warning:null,group_name:null,recording_metadata:{start_ns:(base+BigInt(start)*1_000_000_000n).toString(),duration_ns:(BigInt(duration)*1_000_000_000n).toString(),start_source:'format.creation_time',duration_source:'stream.duration',warning:null,probe_error:null}});
const files=[file('Camera A.mp4',0,120),file('Microphone.wav',30,180),file('Camera B.mp4',180,90),file('Long microphone.wav',3600,7200),file('Short take.mp4',3601,1),file('Distant take.mp4',10750,40),file('Camera restart A.mp4',16000,30),file('Bridge microphone.wav',16020,200),file('Camera restart B.mp4',16180,60),{...file('Missing interval.mp4',20000,30),recording_metadata:null}];
createRoot(document.getElementById('root')!).render(<div className="ig-workspace" style={{margin:24,padding:24,height:'calc(100vh - 48px)'}}><GroupWorkspace projectRoot="fixture" files={files} clients={[{name:'ACME_PRODUCT',path:'ACME_PRODUCT'}]} disabled={false} onAssign={()=>{}} onCreateClient={async()=>{}}/></div>);
