import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animateClientScroll, CLIENT_SCROLL_DURATION } from '../src/components/clientScrollMotion.ts';

test('disclosure scrolls smoothly in both directions, cancels and respects reduced motion', () => {
  const original = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, matchMedia: globalThis.matchMedia };
  let frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let reduced = false;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = frame => { frames.delete(frame); };
  globalThis.matchMedia = (() => ({ matches: reduced })) as typeof matchMedia;
  const tick = (time: number) => {
    const pending = [...frames.values()];
    frames = new Map();
    pending.forEach(callback => callback(time));
  };
  class Viewport extends EventTarget { scrollTop = 0; dataset: Record<string, string> = {}; }
  try {
    const viewport = new Viewport();
    let completions = 0;
    const scroll = (target: number) => animateClientScroll(viewport as unknown as HTMLElement, target, () => completions++);
    scroll(600);
    tick(0); tick(60);
    assert.ok(viewport.scrollTop > 0 && viewport.scrollTop < 600);
    const quarter = viewport.scrollTop;
    tick(120);
    assert.ok(viewport.scrollTop > quarter && viewport.scrollTop < 600);
    tick(CLIENT_SCROLL_DURATION);
    assert.equal(viewport.scrollTop, 600);
    assert.equal(completions, 1);
    assert.equal(viewport.dataset.clientScrolling, undefined);

    scroll(0);
    tick(300); tick(360);
    assert.ok(viewport.scrollTop > 0 && viewport.scrollTop < 600, 'collapse has intermediate positions');
    tick(300 + CLIENT_SCROLL_DURATION);
    assert.equal(viewport.scrollTop, 0);
    assert.equal(completions, 2);

    const cancel = scroll(400);
    tick(600); tick(660);
    viewport.dispatchEvent(new Event('wheel'));
    const interrupted = viewport.scrollTop;
    tick(1000); cancel();
    assert.equal(viewport.scrollTop, interrupted, 'user input stops automated scrolling');
    assert.equal(completions, 3, 'cleanup completes once');
    assert.equal(frames.size, 0);

    const cancelBeforeReplacement = scroll(500);
    tick(1100);
    cancelBeforeReplacement();
    assert.equal(frames.size, 0, 'superseded motion releases its callback');
    reduced = true;
    scroll(90);
    assert.equal(viewport.scrollTop, 90);
    assert.equal(viewport.dataset.clientScrolling, undefined);
    assert.equal(frames.size, 0, 'reduced motion schedules no animation');
  } finally {
    Object.assign(globalThis, original);
  }
});
