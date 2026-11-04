import { availableClientTypes, clientTypeLabel, isMariyaProject } from "./clientTypes";
import { InterviewTypeSelect, type HuddleTemplate } from "./InterviewTypeSelect";
import { MariyaSeasonSelect, useMariyaSeasons } from "./MariyaSeasonSelect";
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';

export type CreateIngestClient = (name:string,mode:string,template:string,season?:string)=>Promise<void>;
export function NewIngestClient({projectRoot,disabled,onCreate}:{projectRoot:string;disabled:boolean;onCreate:CreateIngestClient}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[mode,setMode]=useState('');
  const [template,setTemplate]=useState<HuddleTemplate>('VIDEO_CALL'),[creating,setCreating]=useState(false),[error,setError]=useState('');
  const mariyaProject = isMariyaProject(projectRoot);
  useEffect(() => {
    setOpen(false);
    setName('');
    setMode(mariyaProject ? 'MARIYAMEETS' : '');
    setTemplate('VIDEO_CALL');
    setError('');
  }, [projectRoot, mariyaProject]);
  const needsSeason = mariyaProject && mode==='MARIYAMEETS';
  const seasons = useMariyaSeasons(projectRoot,open&&needsSeason);
  const seasonPending = needsSeason && (seasons.loading || seasons.creating || !seasons.season);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!name.trim()||!mode||creating||seasonPending)return;
    const clean=name.trim();
    if(/[\\/:*?"<>|]/.test(clean)||/[. ]$/.test(clean)){setError('Use a client name without file-path characters or a trailing dot.');return;}
    setCreating(true);setError('');
    try{await onCreate(clean,mode,template,needsSeason?seasons.season:undefined);setName('');setMode(mariyaProject?'MARIYAMEETS':'');setTemplate('VIDEO_CALL');setOpen(false);}catch(error){setError(String(error));}finally{setCreating(false);}
  };
  return <section className={`ig-new-client-card ${open?'open':''}`} aria-label="New client">
    {!open?<button className="ig-new-client-placeholder" disabled={disabled} onClick={()=>setOpen(true)}><Plus size={17}/><span>New client</span></button>:<form aria-label="Create client" onSubmit={event=>void submit(event)}>
      <header className="ig-new-client-heading"><div><strong>New client</strong><span>Create a destination for these files</span></div><div className="ig-new-client-actions"><button type="button" className="ig-icon-button" aria-label="Cancel new client" title="Cancel" disabled={creating} onClick={()=>{setOpen(false);setError('');setTemplate('VIDEO_CALL');}}><X size={14}/></button></div></header>
      <fieldset disabled={disabled||creating}><label>Client name<input autoFocus aria-label="New client name" placeholder="Client name" value={name} onChange={event=>setName(event.target.value)}/></label>
        <span className="ig-new-client-label">Client type</span><div className="ig-new-client-modes">{availableClientTypes(projectRoot).map(value=><button key={value} type="button" aria-pressed={mode===value} onClick={()=>setMode(value)}>{clientTypeLabel(value)}</button>)}</div>
        {needsSeason&&<MariyaSeasonSelect selection={seasons}/>}
        {mode==='HUDDLE'&&<InterviewTypeSelect value={template} onChange={setTemplate}/>}
        {error&&<p className="ig-new-client-error" role="alert">{error}</p>}
        {creating&&<span className="ig-new-client-progress">Creating client…</span>}
        <button type="submit" className="ig-new-client-submit" disabled={disabled||creating||!name.trim()||!mode||seasonPending}>{creating?<LoaderCircle className="ig-spin" size={14}/>:<Check size={14}/>}<span>{creating?'Creating…':'Create client'}</span></button>
      </fieldset>
    </form>}
  </section>;
}
