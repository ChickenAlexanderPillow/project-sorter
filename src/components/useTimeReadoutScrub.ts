import { useEffect, type RefObject } from 'react';

/** Drag any player's time readout to seek; Shift gives finer whole-second control. */
export function useTimeReadoutScrub(root: RefObject<HTMLElement|null>) {
  useEffect(()=>{
    const node=root.current;if(!node)return;
    let drag:{id:number;x:number;time:number;lastX:number;media:HTMLMediaElement;target:HTMLElement;moved:boolean}|null=null;
    let suppressClickUntil=0;
    const selector='.media-time-group,[data-time-scrub]';
    const decorate=()=>node.querySelectorAll<HTMLElement>(selector).forEach(time=>{
      time.classList.add('pepper-time-scrub');
      if(!time.matches('[data-time-scrub]')||!time.title)time.title='Drag left or right to scrub. Hold Shift for finer timing.';
    });
    decorate();const observer=new MutationObserver(decorate);observer.observe(node,{childList:true,subtree:true});
    const down=(event:PointerEvent)=>{
      const target=(event.target as Element).closest<HTMLElement>(selector);
      const media=node.querySelector<HTMLMediaElement>('video,audio');
      if(event.button!==0||!target||!media||!Number.isFinite(media.duration)||media.duration<=0)return;
      drag={id:event.pointerId,x:event.clientX,lastX:event.clientX,time:media.currentTime,media,target,moved:false};
      target.setPointerCapture(event.pointerId);
      if(!target.matches('input'))event.preventDefault();event.stopPropagation();
    };
    const move=(event:PointerEvent)=>{
      if(!drag||event.pointerId!==drag.id)return;
      if(!drag.moved&&Math.abs(event.clientX-drag.x)<3)return;
      if(!drag.moved){drag.media.pause();drag.moved=true;drag.target.classList.add('is-scrubbing');}
      // Accumulate small deltas so changing Shift mid-drag never jumps the playhead.
      const secondsPerPixel=event.shiftKey ? .05 : .25;
      drag.time=Math.max(0,Math.min(drag.media.duration,drag.time+(event.clientX-drag.lastX)*secondsPerPixel));
      drag.lastX=event.clientX;drag.media.currentTime=Math.min(Math.floor(drag.media.duration),Math.round(drag.time));
      node.dispatchEvent(new Event('pepper-time-scrub'));
      event.preventDefault();event.stopPropagation();
    };
    const finish=(event:PointerEvent)=>{
      if(!drag||drag.id!==event.pointerId)return;
      const ended=drag;drag=null;ended.target.classList.remove('is-scrubbing');
      if(ended.target.hasPointerCapture(event.pointerId))ended.target.releasePointerCapture(event.pointerId);
      if(ended.moved){suppressClickUntil=performance.now()+300;event.preventDefault();event.stopPropagation();}
    };
    const click=(event:MouseEvent)=>{
      if(performance.now()<suppressClickUntil&&(event.target as Element).closest(selector)){event.preventDefault();event.stopPropagation();suppressClickUntil=0;}
    };
    node.addEventListener('pointerdown',down,true);node.addEventListener('pointermove',move,true);
    node.addEventListener('pointerup',finish,true);node.addEventListener('pointercancel',finish,true);node.addEventListener('lostpointercapture',finish,true);node.addEventListener('click',click,true);
    return()=>{
      observer.disconnect();
      if(drag){drag.target.classList.remove('is-scrubbing');if(drag.target.hasPointerCapture(drag.id))drag.target.releasePointerCapture(drag.id);}
      node.removeEventListener('pointerdown',down,true);node.removeEventListener('pointermove',move,true);
      node.removeEventListener('pointerup',finish,true);node.removeEventListener('pointercancel',finish,true);node.removeEventListener('lostpointercapture',finish,true);node.removeEventListener('click',click,true);
    };
  },[root]);
}
