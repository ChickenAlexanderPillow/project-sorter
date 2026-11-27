export const CLIENT_SCROLL_DURATION = 240;

/** One fixed-duration motion for both disclosure directions; never updates React. */
export function animateClientScroll(viewport: HTMLElement, target: number, complete: () => void = () => {}) {
  const start = viewport.scrollTop;
  const end = Math.max(0, target);
  let frame = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    viewport.removeEventListener('wheel', interrupt);
    viewport.removeEventListener('touchstart', interrupt);
    viewport.removeEventListener('pointerdown', interrupt);
    viewport.removeEventListener('keydown', interrupt);
    delete viewport.dataset.clientScrolling;
    complete();
  };
  const interrupt = () => finish();
  if (Math.abs(start - end) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    viewport.scrollTop = end;
    finish();
    return finish;
  }
  viewport.dataset.clientScrolling = 'true';
  viewport.addEventListener('wheel', interrupt, { passive: true });
  viewport.addEventListener('touchstart', interrupt, { passive: true });
  viewport.addEventListener('pointerdown', interrupt);
  viewport.addEventListener('keydown', interrupt);
  let started: number | undefined;
  const step = (now: number) => {
    started ??= now;
    const progress = Math.min(1, (now - started) / CLIENT_SCROLL_DURATION);
    const eased = 1 - (1 - progress) ** 3;
    viewport.scrollTop = start + (end - start) * eased;
    if (progress < 1) frame = requestAnimationFrame(step);
    else finish();
  };
  frame = requestAnimationFrame(step);
  return finish;
}
