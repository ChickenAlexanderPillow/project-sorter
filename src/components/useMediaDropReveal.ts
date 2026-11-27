import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** One reversible timeline: details fade out before destinations fade in. */
export function useMediaDropReveal(active: boolean, ready: boolean, element: RefObject<HTMLDivElement | null>) {
  const [engaged, setEngaged] = useState(false);
  const position = useRef(0);
  const lastVisit = useRef(0);
  const recent = useRef(false);

  useLayoutEffect(() => {
    if (active) {
      recent.current = Date.now() - lastVisit.current < 1500;
      if (recent.current) { setEngaged(true); return; }
    } else if (position.current > 0) lastVisit.current = Date.now();
    const timer = window.setTimeout(() => setEngaged(active), active ? 70 : 50);
    return () => window.clearTimeout(timer);
  }, [active]);

  useLayoutEffect(() => {
    const overlay = element.current;
    const row = overlay?.parentElement;
    if (!overlay || !row) return;
    const paint = (phase: number) => {
      position.current = phase;
      row.style.setProperty('--client-drop-details-opacity', String(Math.max(0, 1 - phase * 2)));
      row.style.setProperty('--client-drop-regions-opacity', String(Math.max(0, phase * 2 - 1)));
      overlay.dataset.engaged = String(phase > 0);
      overlay.dataset.detailsVisible = String(phase < 0.5);
      overlay.dataset.visible = String(phase > 0.5);
      overlay.setAttribute('aria-hidden', String(phase <= 0.5));
    };
    const target = engaged && ready ? 1 : 0;
    const start = position.current;
    if (target === start) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(target);
      return;
    }
    const duration = Math.abs(target - start) * (recent.current ? 180 : 220);
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const fraction = Math.min(1, (now - began) / duration);
      const next = start + (target - start) * fraction;
      paint(next);
      if (fraction < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engaged, ready, element]);
}
