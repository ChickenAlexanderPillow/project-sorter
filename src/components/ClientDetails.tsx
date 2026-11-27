import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './ClientDetails.css';

// Keep the closing workspace untouched until scrolling finishes, then release
// its media, listeners and file views together outside the click/animation.
const WorkspaceContent = memo(function WorkspaceContent({ render }: { render: () => ReactNode; active: boolean }) {
  return render();
}, (previous, next) => !next.active || previous.render === next.render);

export function ClientDetails({ open, children }: { open: boolean; children: () => ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const lastHeight = useRef(320);

  useLayoutEffect(() => {
    if (open) return;
    root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media => media.pause());
  }, [open]);

  useEffect(() => {
    if (mounted === open) return;
    const element = root.current;
    if (!element) return;
    const viewport = element.closest<HTMLElement>('.table-scroll');
    let frame = 0;
    let paints = 0;
    const settle = () => {
      // Give the header and scroll motion a paint before doing media work.
      if (++paints < 2 || (!open && viewport?.dataset.clientScrolling === 'true')) {
        frame = requestAnimationFrame(settle);
        return;
      }
      startTransition(() => setMounted(open));
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [open, mounted]);

  useEffect(() => {
    const element = root.current;
    if (!element || !mounted || !open) return;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight) lastHeight.current = element.clientHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, open]);

  return <div ref={root} className="client-details" hidden={!open} inert={!open} aria-busy={open && !mounted}>
    {mounted ? <WorkspaceContent active={open} render={children} /> : open ?
      <div className="client-details-placeholder" style={{ height: lastHeight.current }} role="status" aria-label="Loading client workspace">
        <span /><span /><span />
      </div> : null}
  </div>;
}
