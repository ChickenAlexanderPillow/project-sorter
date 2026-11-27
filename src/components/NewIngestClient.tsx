import { clientTypeLabel } from "./clientTypes";
import { InterviewTypeSelect, type HuddleTemplate } from "./InterviewTypeSelect";
import { ProjectSeasonSelect, useProjectSeasons } from "./MariyaSeasonSelect";
import type { WorkspaceClientType } from "./workspaceTypes";
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';

export type CreateIngestClient = (name:string,mode:string,template:string,season?:string)=>Promise<void>;
export function NewIngestClient({projectRoot,disabled,onCreate,clientTypes,defaultClientType}:{projectRoot:string;disabled:boolean;onCreate:CreateIngestClient;clientTypes:WorkspaceClientType[];defaultClientType:string}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[mode,setMode]=useState('');
  const [template,setTemplate]=useState<HuddleTemplate>('VIDEO_CALL'),[creating,setCreating]=useState(false),[error,setError]=useState('');
  const preferredMode = defaultClientType;
  useEffect(() => {
    setOpen(false);
    setName('');
    setMode(preferredMode);
    setTemplate('VIDEO_CALL');
    setError('');
  }, [projectRoot, preferredMode]);
  const selectedType=clientTypes.find(type=>type.id===mode);
  const needsSeason = Boolean(selectedType?.features.includes('seasons'));
  const seasons = useProjectSeasons(projectRoot,open&&needsSeason);
  const seasonPending = needsSeason && (seasons.loading || seasons.creating || !seasons.season);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!name.trim()||!mode||creating||seasonPending)return;
    const clean=name.trim();
    if(/[\\/:*?"<>|]/.test(clean)||/[. ]$/.test(clean)){setError('Use a client name without file-path characters or a trailing dot.');return;}
    setCreating(true);setError('');
    try{await onCreate(clean,mode,template,needsSeason?seasons.season:undefined);setName('');setMode(preferredMode);setTemplate('VIDEO_CALL');setOpen(false);}catch(error){setError(String(error));}finally{setCreating(false);}
  };
  return <section className={`ig-new-client-card ${open?'open':''}`} aria-label="New client">
    {!open?<button className="ig-new-client-placeholder" disabled={disabled} onClick={()=>setOpen(true)}><Plus size={17}/><span>New client</span></button>:<form aria-label="Create client" onSubmit={event=>void submit(event)}>
      <header className="ig-new-client-heading"><div><strong>New client</strong><span>Create a destination for these files</span></div><div className="ig-new-client-actions"><button type="button" className="ig-icon-button" aria-label="Cancel new client" title="Cancel" disabled={creating} onClick={()=>{setOpen(false);setError('');setTemplate('VIDEO_CALL');}}><X size={14}/></button></div></header>
      <fieldset disabled={disabled||creating}><label>Client name<input autoFocus aria-label="New client name" placeholder="Client name" value={name} onChange={event=>setName(event.target.value)}/></label>
        <span className="ig-new-client-label">Client type</span><div className="ig-new-client-modes">{clientTypes.map(value=><button key={value.id} type="button" aria-pressed={mode===value.id} onClick={()=>setMode(value.id)}>{clientTypeLabel(value.id,Object.fromEntries(clientTypes.map(type=>[type.id.toLowerCase(),type.name])))}</button>)}</div>
        {needsSeason&&<ProjectSeasonSelect selection={seasons}/>}
        {(selectedType?.featureOptions.premiere_project?.length??0)>1&&<InterviewTypeSelect value={template} onChange={setTemplate}/>}
        {error&&<p className="ig-new-client-error" role="alert">{error}</p>}
        {creating&&<span className="ig-new-client-progress">Creating client…</span>}
        <button type="submit" className="ig-new-client-submit" disabled={disabled||creating||!name.trim()||!mode||seasonPending}>{creating?<LoaderCircle className="ig-spin" size={14}/>:<Check size={14}/>}<span>{creating?'Creating…':'Create client'}</span></button>
      </fieldset>
    </form>}
  </section>;
}
