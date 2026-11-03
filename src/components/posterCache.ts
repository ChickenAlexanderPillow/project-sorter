type Capture=(path:string,signal:AbortSignal)=>Promise<string>;

/** One disposable decoder, a bounded image cache, and foreground-first scheduling. */
export function createPosterCache(capture:Capture,limit=48) {
  const images=new Map<string,string>();
  const failed=new Map<string,number>();
  const candidates=new Map<symbol,readonly string[]>();
  const foreground=new Set<symbol>();
  const listeners=new Set<()=>void>();
  let active:{path:string;controller:AbortController}|undefined;
  const notify=()=>listeners.forEach(listener=>listener());
  const wanted=()=>[...new Set([...candidates.values()].flat())].slice(0,limit);
  const pump=()=>{
    if(active||foreground.size)return;
    const path=wanted().find(path=>!images.has(path)&&(failed.get(path)??0)<Date.now());
    if(!path)return;
    const job={path,controller:new AbortController()};
    active=job;
    void capture(path,job.controller.signal).then(image=>{
      if(!job.controller.signal.aborted)put(path,image);
    }).catch(()=>{
      if(!job.controller.signal.aborted){
        failed.set(path,Date.now()+30_000);
        if(failed.size>limit)failed.delete(failed.keys().next().value!);
      }
    }).finally(()=>{
      if(active===job)active=undefined;
      pump();
    });
  };
  const reconcile=()=>{
    if(active&&(foreground.size||!wanted().includes(active.path)))active.controller.abort();
    pump();
  };
  const put=(path:string,image:string)=>{
    images.delete(path);images.set(path,image);failed.delete(path);
    if(images.size>limit)images.delete(images.keys().next().value!);
    notify();
  };
  return {
    get(path:string){
      const image=images.get(path);
      if(image){images.delete(path);images.set(path,image);}
      return image;
    },
    put,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    setCandidates(owner:symbol,paths:readonly string[]){candidates.set(owner,paths);reconcile();},
    setForeground(owner:symbol,busy:boolean){if(busy)foreground.add(owner);else foreground.delete(owner);reconcile();},
    release(owner:symbol){candidates.delete(owner);foreground.delete(owner);reconcile();},
    invalidate(path:string){
      images.delete(path);failed.delete(path);
      if(active?.path===path)active.controller.abort();
      notify();pump();
    },
  };
}
