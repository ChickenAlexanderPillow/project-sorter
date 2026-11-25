import {LoaderCircle} from 'lucide-react';

export function IngestProgressBar({phase,name,percent,completed,total}:{phase:string;name?:string;percent:number|null;completed:number;total:number}){
  return <span className="ig-ingest-progress" role="status" aria-live="polite">
    <span className="ig-ingest-progress-label"><LoaderCircle size={13} className="ig-spin"/><span>{phase}{name&&<strong title={name}>{name}</strong>}</span>{total>0&&<small>{completed} / {total}</small>}{percent!==null&&<b>{percent}%</b>}</span>
    <span className="ig-ingest-progress-track" role="progressbar" aria-label="Overall ingest progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined}><span className={percent===null?'indeterminate':''} style={percent===null?undefined:{width:percent+'%'}}/></span>
  </span>;
}
