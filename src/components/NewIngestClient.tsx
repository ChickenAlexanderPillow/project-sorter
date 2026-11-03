import { MariyaSeasonSelect, useMariyaSeasons } from "./MariyaSeasonSelect";
import { useState } from 'react';
import { Check, LoaderCircle, Plus, X } from 'lucide-react';

export type CreateIngestClient = (name:string,mode:string,template:string,season?:string)=>Promise<void>;
export function NewIngestClient({projectRoot,disabled,onCreate}:{projectRoot:string;disabled:boolean;onCreate:CreateIngestClient}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[mode,setMode]=useState('');
  const [template,setTemplate]=useState('PHYSICAL'),[creating,setCreating]=useState(false),[error,setError]=useState('');
  const needsSeason = mode==='MARIYAMEETS' && projectRoot.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase()==='8_mariya meets';
  const seasons = useMariyaSeasons(projectRoot,open&&needsSeason);
  const seasonPending = needsSeason && (seasons.loading || !seasons.season);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!name.trim()||!mode||creating||seasonPending)return;
    const clean=name.trim();
    if(/[\\/:*?"<>|]/.test(clean)||/[. ]$/.test(clean)){setError('Use a client name without file-path characters or a trailing dot.');return;}
    setCreating(true);setError('');
    try{await onCreate(clean,mode,template,needsSeason?seasons.season:undefined);setName('');setMode('');setOpen(false);}catch(error){setError(String(error));}finally{setCreating(false);}
  };
  return <section className={`ig-new-client-card ${open?'open':''}`} aria-label="New client">
    {!open?<button className="ig-new-client-placeholder" disabled={disabled} onClick={()=>setOpen(true)}><Plus size={17}/><span>New client</span></button>:<form aria-label="Create client" onSubmit={event=>void submit(event)}>
      <header><div className="ig-new-client-actions"><button type="button" className="ig-icon-button" aria-label="Cancel new client" title="Cancel" disabled={creating} onClick={()=>{setOpen(false);setError('');}}><X size={14}/></button><button type="submit" className="ig-icon-button ig-new-client-confirm" aria-label="Create client" title="Create client" disabled={disabled||creating||!name.trim()||!mode||seasonPending}>{creating?<LoaderCircle className="ig-spin" size={14}/>:<Check size={15}/>}</button></div></header>
      <fieldset disabled={disabled||creating}><label>Client name<input autoFocus aria-label="New client name" placeholder="Client name" value={name} onChange={event=>setName(event.target.value)}/></label>
        <span className="ig-new-client-label">Mode</span><div className="ig-new-client-modes">{['EXHIBITOR','HUDDLE','PRODUCT','MARIYAMEETS','SOCIAL'].map(value=><button key={value} type="button" aria-pressed={mode===value} onClick={()=>setMode(value)}>{value==='MARIYAMEETS'?'Mariya Meets':value.charAt(0)+value.slice(1).toLowerCase()}</button>)}</div>
        {needsSeason&&<MariyaSeasonSelect selection={seasons}/>}
        {mode==='HUDDLE'&&<div className="ig-new-client-templates"><button type="button" aria-pressed={template==='PHYSICAL'} onClick={()=>setTemplate('PHYSICAL')}>In person</button><button type="button" aria-pressed={template==='VIDEO_CALL'} onClick={()=>setTemplate('VIDEO_CALL')}>Video call</button></div>}
        {error&&<p className="ig-new-client-error" role="alert">{error}</p>}
        {creating&&<span className="ig-new-client-progress">Creating client…</span>}
      </fieldset>
    </form>}
  </section>;
}
