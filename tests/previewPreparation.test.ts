import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewPreparation} from '../src/components/previewPreparation.ts';

test('hover and selection share one access check and revisits use the completed check',async()=>{
  let calls=0;
  let finish!:()=>void;
  const cache=createPreviewPreparation(()=>{calls++;return new Promise<void>(resolve=>{finish=resolve;});});
  const hover=cache.prepare('clip.mp4');
  assert.equal(cache.prepare('clip.mp4'),hover);
  assert.equal(cache.isPrepared('clip.mp4'),false);
  finish();
  await hover;
  await cache.prepare('clip.mp4');
  assert.equal(calls,1);
  assert.equal(cache.isPrepared('clip.mp4'),true);
});

test('an offline file can be retried after the NAS returns',async()=>{
  let calls=0;
  const cache=createPreviewPreparation(async()=>{if(++calls===1)throw new Error('Offline');});
  await assert.rejects(cache.prepare('clip.mp4'),/Offline/);
  assert.equal(cache.isPrepared('clip.mp4'),false);
  await cache.prepare('clip.mp4');
  assert.equal(cache.isPrepared('clip.mp4'),true);
  assert.equal(calls,2);
});

test('preparation cache stays bounded and retains recently used paths',async()=>{
  const cache=createPreviewPreparation(async()=>{},2);
  await cache.prepare('A');
  await cache.prepare('B');
  await cache.prepare('A');
  await cache.prepare('C');
  assert.equal(cache.isPrepared('A'),true);
  assert.equal(cache.isPrepared('B'),false);
  assert.equal(cache.isPrepared('C'),true);
});
