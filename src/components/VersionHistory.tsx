import { useLayoutEffect, useRef, type ReactNode } from "react";

export function VersionHistory({ label, children }: { label: string; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const update = () => {
      viewport.dataset.scrollable = String(viewport.scrollHeight > viewport.clientHeight + 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    update();
    return () => observer.disconnect();
  }, []);

  return <div className="version-list" ref={viewportRef} role="group" aria-label={label}>
    <div className="version-history-content" ref={contentRef}>{children}</div>
  </div>;
}
