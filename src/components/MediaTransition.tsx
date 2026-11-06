import {useEffect,useLayoutEffect,useReducer,useRef,type ReactNode} from 'react';
import {previewLayers} from './previewLayers';
import './MediaTransition.css';

const FADE_MS=150;

/** Keep the painted frame until its replacement is ready, including type changes. */
export function MediaTransition({source,render,onError}:{source:string;render:(source:string,onReady:()=>void,onError:()=>void)=>ReactNode;onError?:()=>void}) {
  const [layers,dispatch]=useReducer(previewLayers,[{id:0,source,ready:false,failed:false}]);
  const current=useRef({source,id:0}),root=useRef<HTMLDivElement>(null);
  const sequence=useRef(0);
  const timers=useRef(new Set<ReturnType<typeof setTimeout>>());
  const animations=useRef(new Map<HTMLElement,Animation>());
  const revealing=useRef(new Set<number>());
  const freeze=()=>{
    // Preserve the actual blended frame if a click interrupts a crossfade.
    animations.current.forEach((animation,element)=>{
      element.style.opacity=getComputedStyle(element).opacity;
      animation.cancel();
    });
    animations.current.clear();
    timers.current.forEach(clearTimeout);
    timers.current.clear();
  };
  useLayoutEffect(()=>{
    if(current.current.source===source)return;
    freeze();
    revealing.current.clear();
    root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause());
    // Normalize the newest displayed frame before discarding older fade layers.
    const newest=root.current?.querySelector<HTMLElement>('.pepper-media-layer.ready:last-child');
    newest?.querySelectorAll<HTMLElement>('.pepper-media-visual').forEach(element=>{element.style.opacity='1';});
    current.current={source,id:++sequence.current};
    dispatch({type:'request',...current.current});
  },[source]);
  useEffect(()=>()=>{
    timers.current.forEach(clearTimeout);
    animations.current.forEach(animation=>animation.cancel());
  },[]);
  const reveal=(id:number,failed=false)=>{
    if(id!==current.current.id)return;
    if(revealing.current.has(id)){
      if(failed){dispatch({type:'failed',id});onError?.();}
      return;
    }
    revealing.current.add(id);
    if(id!==current.current.id)return;
    const incoming=root.current?.querySelector<HTMLElement>(`[data-preview-layer="${id}"]`);
    if(!incoming)return;
    const outgoing=Array.from(root.current!.querySelectorAll<HTMLElement>('.pepper-media-layer.ready'));
    const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:FADE_MS;
    // A failed load renders its replacement after dispatch, so animate its
    // wrapper instead of the media element that is about to be removed.
    const incomingVisuals=failed?[incoming]:Array.from(incoming.querySelectorAll<HTMLElement>('.pepper-media-visual'));
    const animate=(element:HTMLElement,to:number,from?:number)=>{
      const start=from??Number(getComputedStyle(element).opacity);
      animations.current.get(element)?.cancel();
      element.style.opacity=String(to);
      if(duration){
        const animation=element.animate([{opacity:start},{opacity:to}],{duration,easing:'ease-out'});
        animations.current.set(element,animation);
      }
    };
    outgoing.forEach(layer=>layer.querySelectorAll<HTMLElement>('.pepper-media-visual').forEach(element=>animate(element,0)));
    incomingVisuals.forEach(element=>animate(element,1,0));
    dispatch({type:failed?'failed':'ready',id});
    if(failed)onError?.();
    const timer=setTimeout(()=>{
      timers.current.delete(timer);
      if(id!==current.current.id)return;
      animations.current.forEach(animation=>animation.cancel());
      animations.current.clear();
      dispatch({type:'settled',id});
    },duration+30);
    timers.current.add(timer);
  };
  const controlsLayer=layers.filter(layer=>layer.ready).slice(-1)[0]?.id;
  return <div ref={root} className="pepper-media-transition" aria-busy={!layers[layers.length-1]?.ready}>
    {layers.map((layer,index)=>{
      const active=index===layers.length-1&&layer.ready;
      return <div key={layer.id} data-preview-layer={layer.id} className={`pepper-media-layer${layer.ready?' ready':''}${layer.id===controlsLayer?' controls-current':''}`} inert={!active} aria-hidden={!active}>
        {layer.failed?<div className="ig-preview-placeholder pepper-media-visual" role="status"><span>This format cannot be previewed here.</span></div>:render(layer.source,()=>reveal(layer.id),()=>reveal(layer.id,true))}
      </div>;
    })}
  </div>;
}
