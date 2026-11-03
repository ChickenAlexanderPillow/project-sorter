import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';

/** Lazily mount once, retain state on return, and silence hidden media. */
export function RetainedView({active,children,id,labelledBy}:{active:boolean;children:ReactNode;id?:string;labelledBy?:string}) {
  const [visited,setVisited]=useState(active);
  const root=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(active)setVisited(true);
    else root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause());
  },[active]);
  return <div ref={root} hidden={!active} inert={!active} id={id} role={labelledBy?'tabpanel':undefined} aria-labelledby={labelledBy} className="pepper-retained-view">{(active||visited)&&children}</div>;
}
