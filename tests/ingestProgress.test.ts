import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceCollectProgress,emptyCollectProgress,pendingCollectFiles,recategorizePendingFiles} from '../src/components/ingestProgress.ts';
const sources=[{path:'E:/small.mov',size:100},{path:'E:/large.mov',size:900}];
const snapshot=(source:string,phase='collecting',bytes_copied=0,file_size=0,completed_sources:string[]=[])=>({source,phase,bytes_copied,file_size,completed_sources,completed:0,total:1});
test('global progress spans all sources and weights a large file by bytes',()=>{
 let state=advanceCollectProgress(emptyCollectProgress(),sources,snapshot(sources[0].path,'collecting',50,100));
 assert.equal(state.percent,4);
 state=advanceCollectProgress(state,sources,snapshot(sources[1].path,'collecting',450,900));
 assert.equal(state.count,1);assert.equal(state.total,2);assert.equal(state.percent,50);
});
test('verification does not make progress go backwards or finish before readback',()=>{
 let state=advanceCollectProgress(emptyCollectProgress(),sources,snapshot(sources[0].path,'collecting',100,100));
 assert.equal(state.percent,9);assert.equal(state.count,0);
 state=advanceCollectProgress(state,sources,snapshot(sources[0].path,'verifying'));
 assert.equal(state.percent,9);assert.equal(state.count,0);
 state=advanceCollectProgress(state,sources,snapshot(sources[0].path,'collecting',100,100,[sources[0].path]));
 assert.equal(state.percent,10);assert.equal(state.count,1);
 state=advanceCollectProgress(state,sources,snapshot('', 'complete'));
 assert.equal(state.percent,100);assert.equal(state.count,2);
});
test('completed paths persist across backend source counter resets',()=>{
 let state=advanceCollectProgress(emptyCollectProgress(),sources,snapshot(sources[0].path,'collecting',100,100,[sources[0].path]));
 state=advanceCollectProgress(state,sources,snapshot(sources[1].path,'inventorying'));
 assert.equal(state.count,1);assert.equal(state.percent,10);
 state=advanceCollectProgress(state,sources,snapshot(sources[1].path,'collecting',900,900,[sources[1].path]));
 assert.equal(state.count,2);assert.equal(state.percent,100);
});
test('stale completed-source hints in inventory and initial hashing cannot complete a new batch',()=>{
 for(const phase of ['inventorying','metadata','verifying']){
  const state=advanceCollectProgress(emptyCollectProgress(),sources,snapshot(sources[0].path,phase,0,0,[sources[0].path]));
  assert.equal(state.count,0);assert.equal(state.percent,0);
 }
});
test('copied and assigned media remain in Collect until successfully filed',()=>{
 const copied={id:'a',status:'Verified',client:'ACME'},unassigned={id:'b',status:'Verified',client:null},filed={id:'c',status:'Filed',client:'ACME'};
 assert.deepEqual(pendingCollectFiles([copied,unassigned,filed]),[copied,unassigned]);
 assert.deepEqual(pendingCollectFiles([{...copied,status:'Filed'},unassigned,filed]),[unassigned]);
});
test('recategorising preserves original evidence and assignments and never edits filed media',()=>{
 const pending={id:'a',status:'Verified',role:'Full-resolution video',sha256:'evidence',client_paths:['ACME'],destinations:[] as string[]};
 const filed={...pending,id:'b',status:'Filed',destinations:['final.mov']};
 const partial={...pending,id:'c',destinations:['one-client.mov']};
 const next=recategorizePendingFiles([pending,filed,partial],['a','b','c'],'Stock');
 assert.equal(next[0].role,'Stock');assert.equal(next[0].sha256,'evidence');assert.deepEqual(next[0].client_paths,['ACME']);
 assert.equal(next[1],filed);assert.equal(next[2],partial);assert.equal(pending.role,'Full-resolution video');
});
