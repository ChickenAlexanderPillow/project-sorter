import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPosterCache} from '../src/components/posterCache.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function harness(limit=48){
  const jobs:{path:string;signal:AbortSignal;resolve:(image:string)=>void;reject:(error:Error)=>void}[]=[];
  const cache=createPosterCache((path,signal)=>new Promise<string>((resolve,reject)=>{
    jobs.push({path,signal,resolve,reject});
    signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});
  }),limit);
  return {cache,jobs};
}

test('visible rows generate posters serially and cached rows need no decoder',async()=>{
  const {cache,jobs}=harness();const owner=Symbol();
  cache.setCandidates(owner,['A','B','A']);
  assert.deepEqual(jobs.map(job=>job.path),['A']);
  jobs[0].resolve('poster A');await flush();
  assert.equal(cache.get('A'),'poster A');
  assert.deepEqual(jobs.map(job=>job.path),['A','B']);
  jobs[1].resolve('poster B');await flush();
  cache.setCandidates(owner,['A','B']);await flush();
  assert.equal(jobs.length,2);
});

test('scrolling offscreen cancels the active read and replaces queued work',async()=>{
  const {cache,jobs}=harness();const owner=Symbol();
  cache.setCandidates(owner,['A','B']);
  cache.setCandidates(owner,['C']);
  assert.equal(jobs[0].signal.aborted,true);
  await flush();
  assert.deepEqual(jobs.map(job=>job.path),['A','C']);
  jobs[1].resolve('poster C');await flush();
  assert.equal(cache.get('A'),undefined);
  assert.equal(cache.get('C'),'poster C');
});

test('foreground loading or playback suspends background decoding',async()=>{
  const {cache,jobs}=harness();const list=Symbol(),player=Symbol();
  cache.setForeground(player,true);
  cache.setCandidates(list,['A']);
  assert.equal(jobs.length,0);
  cache.setForeground(player,false);
  assert.equal(jobs.length,1);
  cache.setForeground(player,true);await flush();
  assert.equal(jobs[0].signal.aborted,true);
  assert.equal(jobs.length,1);
  cache.setForeground(player,false);
  assert.equal(jobs.length,2);
  jobs[1].resolve('poster A');await flush();
});

test('failed previews do not block other rows or create a retry loop',async()=>{
  const {cache,jobs}=harness();
  cache.setCandidates(Symbol(),['broken','good']);
  jobs[0].reject(new Error('Unsupported codec'));await flush();
  assert.equal(jobs[1].path,'good');
  jobs[1].resolve('poster');await flush();
  assert.equal(jobs.length,2);
  assert.equal(cache.get('good'),'poster');
});

test('the image cache is bounded and never churns when a viewport exceeds its capacity',async()=>{
  const {cache,jobs}=harness(2);
  cache.setCandidates(Symbol(),['A','B','C']);
  jobs[0].resolve('poster A');await flush();
  jobs[1].resolve('poster B');await flush();
  assert.equal(jobs.length,2);
  cache.get('A');cache.put('C','poster C');
  assert.equal(cache.get('B'),undefined);
  assert.equal(cache.get('A'),'poster A');
  assert.equal(cache.get('C'),'poster C');
});

test('closing a view releases its background read and queued work',async()=>{
  const {cache,jobs}=harness();const owner=Symbol();
  cache.setCandidates(owner,['A','B']);
  cache.release(owner);await flush();
  assert.equal(jobs[0].signal.aborted,true);
  assert.equal(jobs.length,1);
});
