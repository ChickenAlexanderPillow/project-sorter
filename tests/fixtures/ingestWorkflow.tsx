// Isolated production-component fixture. All IPC is in memory; no media is copied.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {mockIPC, mockConvertFileSrc} from '@tauri-apps/api/mocks';
import {IngestWorkspace} from '../../src/components/IngestWorkspace';
import '../../src/App.css';

const root='C:/fixture';
const sources=['Interview still.png','Product detail.png'].map((name,index)=>({path:`C:/card/${name}`,name,kind:'image' as const,role:'Stills',size:(index+1)*100_000_000,created:null,modified:null}));
const makeFile=(source:typeof sources[number],index:number)=>({id:String(index),batch_id:'fixture',collected_at:new Date().toISOString(),newly_collected:true,name:source.name,source:source.path,source_name:source.name,relative_path:source.name,inbox_path:`${root}/_INGEST/${source.name}`,role:source.role,size:source.size,sha256:'fixture',source_modified:null,source_created:null,timestamp_warning:null,status:'Verified',group_name:null,client:'ACME_PRODUCT',clients:['ACME_PRODUCT'],client_paths:['ACME_PRODUCT'],destinations:[],duplicate_of:null,counterpart_id:null});
let manifest={schema_version:1,files:[makeFile(sources[0],0)],reviewed_groups:[]};
let progress:unknown=null;
localStorage.setItem(`pepper.ingest.view:${root}`,JSON.stringify({step:1,staged:[sources[1]]}));
localStorage.setItem('pepper.import.previewCollapsed','false');
mockConvertFileSrc('asset');
// Use a local asset for the still preview instead of an unavailable filesystem URL.
(window as unknown as {__TAURI_INTERNALS__:{convertFileSrc:()=>string}}).__TAURI_INTERNALS__.convertFileSrc=()=>'/pepper-icon.png';
mockIPC(async(command,args)=>{
  switch(command){
    case 'ingest_load': return structuredClone(manifest);
    case 'media_resolve_files': return sources.filter(source=>(args?.paths as string[]).includes(source.path));
    case 'media_valid_client_paths': return [`${root}/ACME_PRODUCT`];
    case 'ingest_lease_status': return {locked:false,owner:null,stale:false};
    case 'ingest_progress': return progress;
    case 'media_prepare_preview': return;
    case 'ingest_save': manifest=structuredClone(args?.manifest as typeof manifest);return;
    case 'ingest_collect': {
      for(let i=0;i<=10;i++){
        progress={updated_at:new Date().toISOString(),phase:i===10?'verifying':'collecting',source:sources[1].path,completed:0,total:1,bytes_copied:sources[1].size*i/10,file_size:sources[1].size,completed_sources:[]};
        await new Promise(resolve=>setTimeout(resolve,900));
      }
      manifest.files.push(makeFile(sources[1],1));return structuredClone(manifest);
    }
    case 'ingest_preview_filing': return manifest.files.filter(file=>file.status!=='Filed').map(file=>({file_id:file.id,name:file.name,role:file.role,client:'ACME_PRODUCT',destination:`${root}/ACME_PRODUCT/${file.name}`,collision:false,issue:null}));
    case 'ingest_file': manifest.files=manifest.files.map(file=>({...file,status:'Filed',destinations:[`${root}/ACME_PRODUCT/${file.name}`]}));return structuredClone(manifest);
    default: throw new Error(`Unexpected fixture command: ${command}`);
  }
});
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh',padding:24,boxSizing:'border-box',display:'flex'}}><IngestWorkspace projectRoot={root} projectTitle="Ingest preview" clients={[{name:'ACME_PRODUCT',path:`${root}/ACME_PRODUCT`,status:'Active'}]} onBack={()=>{}} onCreateClient={async()=>{}}/></div>);
