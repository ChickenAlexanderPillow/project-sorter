import { useLayoutEffect, useRef, type RefObject } from 'react';
import { animateClientScroll } from './clientScrollMotion';

export function useClientScrollPosition(tableScrollRef: RefObject<HTMLDivElement | null>, expandedName: string | undefined) {
  const expandedClientForScrollRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const container = tableScrollRef.current;
    const content = container?.querySelector<HTMLElement>(".client-list");
    const previousName = expandedClientForScrollRef.current;
    expandedClientForScrollRef.current = expandedName;
    if (!container || !content) return;
    if (!expandedName) {
      if (!previousName) return;
      const row = Array.from(container.querySelectorAll<HTMLElement>(".client-row"))
        .find((candidate) => candidate.dataset.clientName === previousName);
      if (!row) {
        content.style.removeProperty("min-height");
        return;
      }
      // Keep the expansion's scroll room while returning to a position the
      // collapsed list can support. Releasing it earlier clamps scrollTop.
      const rowOffset = row.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
      const lastSection = content.querySelector<HTMLElement>(":scope > .client-section:last-child");
      const contentStyle = getComputedStyle(content);
      const naturalHeight = lastSection
        ? lastSection.getBoundingClientRect().bottom - content.getBoundingClientRect().top
          + parseFloat(contentStyle.paddingBottom) + parseFloat(contentStyle.borderBottomWidth)
        : container.clientHeight;
      const target = Math.min(container.scrollTop + rowOffset, Math.max(0, naturalHeight - container.clientHeight));
      if (Math.abs(container.scrollTop - target) < 2) {
        content.style.removeProperty("min-height");
        return;
      }
      return animateClientScroll(container, target, () => content.style.removeProperty("min-height"));
    }
    const row = Array.from(container?.querySelectorAll<HTMLElement>(".client-row") ?? [])
      .find((candidate) => candidate.dataset.clientName === expandedName);
    if (!row) return;
    const reserveScrollSpace = () => {
      // Leave enough content below this row to reach the top, including for
      // the last client and when a workspace tab becomes shorter.
      const rowTop = row.getBoundingClientRect().top - content.getBoundingClientRect().top;
      content.style.minHeight = `${Math.ceil(Math.max(rowTop, container.scrollTop) + container.clientHeight)}px`;
    };
    reserveScrollSpace();
    const observer = new ResizeObserver(reserveScrollSpace);
    observer.observe(container);
    const rowOffset = row.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
    const cancelScroll = animateClientScroll(container, container.scrollTop + rowOffset);
    return () => {
      cancelScroll();
      observer.disconnect();
    };
  }, [expandedName, tableScrollRef]);
}
