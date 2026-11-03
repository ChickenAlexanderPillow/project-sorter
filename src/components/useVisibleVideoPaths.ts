import {useEffect,useState,type RefObject} from 'react';

/** IntersectionObserver includes clipping by the file pane and the app viewport. */
export function useVisibleVideoPaths(container:RefObject<HTMLDivElement|null>,rowsKey:string) {
  const [paths,setPaths]=useState<string[]>([]);
  useEffect(()=>{
    const rows=Array.from(container.current?.querySelectorAll<HTMLElement>('[data-preview-kind="video"]')??[]);
    const visible=new Set<Element>();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const observer=new IntersectionObserver(entries=>{
      entries.forEach(entry=>{if(entry.isIntersecting)visible.add(entry.target);else visible.delete(entry.target);});
      clearTimeout(timer);
      // Let scrolling settle before starting new NAS reads.
      timer=setTimeout(()=>{
        const next=rows.filter(row=>visible.has(row)).map(row=>row.dataset.previewPath!);
        setPaths(previous=>previous.length===next.length&&previous.every((path,index)=>path===next[index])?previous:next);
      },80);
    },{threshold:0.01});
    rows.forEach(row=>observer.observe(row));
    if(!rows.length)setPaths(previous=>previous.length?[]:previous);
    return()=>{observer.disconnect();clearTimeout(timer);};
  },[container,rowsKey]);
  return paths;
}
