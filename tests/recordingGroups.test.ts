import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingGroups, type Recording } from '../src/components/recordingGroups.ts';

const recording=(id:string,minutes:number|null,extra:Partial<Recording>={}):Recording=>({id,name:`${id}.mp4`,source_created:minutes===null?null:String((Date.UTC(2026,9,30)+minutes*60_000)*1_000_000),source_modified:null,timestamp_warning:null,group_id:null,group_name:null,...extra});
test('nearby video and audio group automatically without chaining across the show',()=>{
  const groups=recordingGroups([recording('camera',0),recording('audio',4),recording('next-camera',8),recording('next-audio',9)]);
  assert.deepEqual(groups.map(group=>group.files.map(file=>file.id)),[['camera','audio'],['next-camera','next-audio']]);
});
test('missing and suspect dates stay unsorted while established groups survive',()=>{
  const files=[recording('no-date',null),recording('suspect',0,{timestamp_warning:'Uncertain date'}),recording('solo',40),recording('established',0,{group_id:'saved',group_name:'Interview'})];
  const before=JSON.stringify(files);const groups=recordingGroups(files);
  assert.deepEqual(groups.find(group=>group.id==='unsorted')?.files.map(file=>file.id),['no-date','suspect','solo']);
  assert.equal(groups.find(group=>group.id==='saved')?.name,'Interview');
  assert.equal(JSON.stringify(files),before);
});
test('late audio joins unassigned video and previous automatic groups are reconsidered',()=>{
  const video=recording('camera',0);
  assert.equal(recordingGroups([video])[0].id,'unsorted');
  const audio=recording('audio',1,{name:'recorder.wav'});
  assert.deepEqual(recordingGroups([video,audio])[0].files.map(file=>file.id),['camera','audio']);
  const previous=recording('older-camera',0,{group_id:'suggested-older-camera',group_name:'Old automatic group'});
  assert.deepEqual(recordingGroups([previous,audio])[0].files.map(file=>file.id),['older-camera','audio']);
});

test('five-minute boundary is inclusive without rounding the next nanosecond into the group',()=>{
  const start=recording('start',0);
  const exact=recording('exact',5);
  const beyond=recording('beyond',5,{source_created:String(BigInt(exact.source_created!)+1n)});
  const groups=recordingGroups([beyond,exact,start]);
  assert.deepEqual(groups[0].files.map(file=>file.id),['start','exact']);
  assert.deepEqual(groups.find(group=>group.id==='unsorted')?.files.map(file=>file.id),['beyond']);
});

test('invalid dates never suggest a match and missing creation time uses modification time',()=>{
  const base=recording('base',0);
  const fallback=recording('fallback',null,{source_modified:base.source_created});
  const invalid=['NaN','Infinity','-1','0','1e18','1.5','999999999999999999999999999'].map((source_created,i)=>recording(`invalid-${i}`,0,{source_created}));
  const groups=recordingGroups([base,fallback,...invalid]);
  assert.deepEqual(groups[0].files.map(file=>file.id),['base','fallback']);
  assert.deepEqual(groups.find(group=>group.id==='unsorted')?.files.map(file=>file.id),invalid.map(file=>file.id));
});

test('automatic group identity and order are stable for shuffled files with equal timestamps',()=>{
  const files=[recording('b',0),recording('a',0),recording('d',20),recording('c',20)];
  const before=JSON.stringify(files);
  assert.deepEqual(recordingGroups(files),recordingGroups([...files].reverse()));
  assert.equal(JSON.stringify(files),before);
  assert.deepEqual(recordingGroups(files).map(group=>group.id),['auto:a','auto:c']);
});

test('each input appears exactly once across many sessions, missing dates, and saved groups',()=>{
  const files=Array.from({length:200},(_,i)=>recording(`clip-${i}`,i%13===0?null:i*2,{timestamp_warning:i%17===0?'Check date':null,...(i%23===0?{group_id:'manual',group_name:'Interview'}:{})}));
  const groups=recordingGroups(files);
  const output=groups.flatMap(group=>group.files.map(file=>file.id));
  assert.equal(output.length,files.length);
  assert.equal(new Set(output).size,files.length);
  assert.deepEqual([...output].sort(),files.map(file=>file.id).sort());
  for(const group of groups.filter(group=>group.automatic)){
    assert.ok(group.files.every(file=>!file.timestamp_warning&&file.source_created));
    const times=group.files.map(file=>BigInt(file.source_created!));
    assert.ok(times.at(-1)!-times[0]<=300_000_000_000n);
  }
});

