import { useId, useLayoutEffect, useRef } from "react";
import type { DragEventHandler, ReactNode, RefObject } from "react";
import "./ClientScrollArea.css";

type Props = {
  scrollRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  children: ReactNode;
};

export function ClientScrollArea({ scrollRef, busy, onDragOver, children }: Props) {
  const viewportId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    const content = viewport?.firstElementChild;
    if (!viewport || !rail || !thumb || !content) return;

    let overflowing = false;
    let frame = 0;
    let trackHeight = 0;
    let thumbHeight = 0;
    let maxScroll = 0;
    let drag: { pointerId: number; y: number; scrollTop: number } | null = null;
    const syncPosition = () => {
      frame = 0;
      if (!overflowing) return;
      const top = (viewport.scrollTop / maxScroll) * (trackHeight - thumbHeight);
      thumb.style.transform = `translateY(${top}px)`;
      thumb.setAttribute("aria-valuenow", String(Math.round(viewport.scrollTop)));
    };
    const schedulePosition = () => {
      if (!frame && overflowing) frame = requestAnimationFrame(syncPosition);
    };
    const measure = () => {
      const height = viewport.clientHeight;
      const scrollHeight = viewport.scrollHeight;
      overflowing = scrollHeight > height + 1;
      rail.dataset.visible = String(overflowing);
      thumb.tabIndex = overflowing ? 0 : -1;
      if (overflowing) {
        trackHeight = height;
        maxScroll = scrollHeight - height;
        thumbHeight = Math.min(height, Math.max(28, (height / scrollHeight) * height));
        rail.style.height = `${height}px`;
        thumb.style.height = `${thumbHeight}px`;
        thumb.setAttribute("aria-valuemax", String(Math.round(maxScroll)));
        syncPosition();
      }
      // Preserve the last thumb geometry during fade-out, even after overflow ends.
    };
    const pointerDown = (event: PointerEvent) => {
      if (!overflowing || event.button !== 0) return;
      event.preventDefault();
      if (event.target !== thumb) {
        const y = event.clientY - rail.getBoundingClientRect().top;
        viewport.scrollTop = ((y - thumbHeight / 2) / Math.max(1, trackHeight - thumbHeight)) * maxScroll;
      }
      drag = { pointerId: event.pointerId, y: event.clientY, scrollTop: viewport.scrollTop };
      rail.setPointerCapture(event.pointerId);
      thumb.focus({ preventScroll: true });
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      viewport.scrollTop = drag.scrollTop + ((event.clientY - drag.y) / Math.max(1, trackHeight - thumbHeight)) * maxScroll;
    };
    const pointerEnd = () => { drag = null; };
    const keyDown = (event: KeyboardEvent) => {
      let next: number;
      switch (event.key) {
        case "ArrowDown": next = viewport.scrollTop + 40; break;
        case "ArrowUp": next = viewport.scrollTop - 40; break;
        case "PageDown": next = viewport.scrollTop + viewport.clientHeight * .9; break;
        case "PageUp": next = viewport.scrollTop - viewport.clientHeight * .9; break;
        case "Home": next = 0; break;
        case "End": next = maxScroll; break;
        default: return;
      }
      event.preventDefault();
      viewport.scrollTop = next;
    };
    const wheelOnRail = (event: WheelEvent) => {
      // Only the narrow scrollbar rail needs forwarding. Wheel input over the
      // actual client list is handled entirely by the browser.
      if (event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      viewport.scrollBy({ top: event.deltaY * unit, left: event.deltaX * unit, behavior: "instant" });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", schedulePosition, { passive: true });
    rail.addEventListener("pointerdown", pointerDown);
    rail.addEventListener("pointermove", pointerMove);
    rail.addEventListener("lostpointercapture", pointerEnd);
    rail.addEventListener("wheel", wheelOnRail, { passive: false });
    thumb.addEventListener("keydown", keyDown);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", schedulePosition);
      rail.removeEventListener("pointerdown", pointerDown);
      rail.removeEventListener("pointermove", pointerMove);
      rail.removeEventListener("lostpointercapture", pointerEnd);
      rail.removeEventListener("wheel", wheelOnRail);
      thumb.removeEventListener("keydown", keyDown);
    };
  }, [scrollRef]);

  return (
    <div className={`client-scroll-area${busy ? " busy" : ""}`}>
      <div id={viewportId} className="table-scroll" ref={scrollRef} onDragOver={onDragOver}>
        {children}
      </div>
      <div className="client-scrollbar-rail" ref={railRef}>
        <div ref={thumbRef} role="scrollbar" aria-label="Scroll clients" aria-orientation="vertical" aria-controls={viewportId} aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={-1} />
      </div>
    </div>
  );
}
