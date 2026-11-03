import {useEffect,useLayoutEffect,useReducer,useRef,type ReactNode} from 'react';
import {previewLayers} from './previewLayers';
import './MediaTransition.css';

/** Retain visible layers through interrupted fades; discard obsolete decoders. */
export function MediaTransition({source,render,onError}:{source:string;render:(source:string,onReady:()=>void,onError:()=>void)=>ReactNode;onError?:()=>void}) {
  const [layers,dispatch]=useReducer(previewLayers,[{id:0,source,ready:false,failed:false}]);
  const current=useRef({source,id:0}),root=useRef<HTMLDivElement>(null);
  const frames=useRef(new Set<number>()),timers=useRef(new Set<ReturnType<typeof setTimeout>>());
  useLayoutEffect(()=>{
    if(current.current.source===source)return;
    current.current={source,id:current.current.id+1};
    dispatch({type:'request',...current.current});
  },[source]);
  useLayoutEffect(()=>{
    root.current?.querySelectorAll<HTMLMediaElement>('[inert] video,[inert] audio').forEach(media=>media.pause());
  },[layers]);
  useEffect(()=>()=>{frames.current.forEach(cancelAnimationFrame);timers.current.forEach(clearTimeout);},[]);
  const reveal=(id:number,failed=false)=>{
    if(id!==current.current.id)return;
    // A cached decoder may finish before its first paint. Give opacity zero a
    // committed frame, so it cannot appear fully opaque for one frame.
    const frame=requestAnimationFrame(()=>{
      frames.current.delete(frame);
      const next=requestAnimationFrame(()=>{
        frames.current.delete(next);
        if(id!==current.current.id)return;
        dispatch({type:failed?'failed':'ready',id});
        if(failed)onError?.();
        const timer=setTimeout(()=>{timers.current.delete(timer);dispatch({type:'settled',id});},550);
        timers.current.add(timer);
      });
      frames.current.add(next);
    });
    frames.current.add(frame);
  };
  return <div ref={root} className="pepper-media-transition" aria-busy={!layers[layers.length-1]?.ready}>
    {layers.map((layer,index)=>{
      const active=index===layers.length-1&&layer.ready;
      return <div key={layer.id} className={`pepper-media-layer${layer.ready?' ready':''}`} inert={!active} aria-hidden={!active}>
        {layer.failed?<div className="ig-preview-placeholder" role="status"><span>This format can’t be previewed here.</span></div>:render(layer.source,()=>reveal(layer.id),()=>reveal(layer.id,true))}
      </div>;
    })}
  </div>;
}
