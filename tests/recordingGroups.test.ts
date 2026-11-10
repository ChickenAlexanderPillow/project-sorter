import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingGroups, recordingInterval, recordingTimeline, type Recording } from '../src/components/recordingGroups.ts';
const base=BigInt(Date.UTC(2026,0,1))*1_000_000n;
const recording=(id:string,start=0,duration=60,extra:Partial<Recording>={}):Recording=>({id,name:`${id}.mp4`,source_created:base.toString(),source_modified:null,timestamp_warning:null,group_id:null,group_name:null,recording_metadata:{start_ns:(base+BigInt(start)*1_000_000_000n).toString(),duration_ns:(BigInt(duration)*1_000_000_000n).toString(),start_source:'format.creation_time',duration_source:'stream.duration',warning:null,probe_error:null},...extra});
const ids=(files:Recording[])=>recordingGroups(files).map(g=>g.files.map(f=>f.id));
test('direct overlap with mixed audio and video',()=>{assert.deepEqual(ids([recording('camera'),recording('mic',30,60,{name:'mic.wav'})]),[['camera','mic']]);});
test('later import batches join earlier media and can merge previous suggestions',()=>{
 const first=Object.assign(recording('camera-a',0,30),{batch_id:'card-one',newly_collected:false});
 const second=Object.assign(recording('camera-b',180,30),{batch_id:'card-two',newly_collected:false});
 assert.equal(recordingGroups([first,second])[0].id,'unsorted');
 const mic=Object.assign(recording('mic',20,180,{name:'mic.wav'}),{batch_id:'recorder-later',newly_collected:true});
 assert.deepEqual(ids([second,mic,first]),[['camera-a','mic','camera-b']]);
 const alreadyGrouped=recording('previous',0,30,{group_id:'auto:camera-a',group_name:'Earlier suggestion'});
 assert.deepEqual(ids([alreadyGrouped,first,second,mic]),[['camera-a','previous','mic','camera-b']]);
});
test('continuous audio transitively bridges camera stop and restart',()=>{assert.deepEqual(ids([recording('first',0,30),recording('mic',20,200,{name:'mic.wav'}),recording('restart',180,60)]),[['first','mic','restart']]);});
test('non-overlap never uses the old five minute rule; touching edges do not overlap',()=>{
  for(const start of [60,61,120,300])assert.equal(recordingGroups([recording('a'),recording('b',start)])[0].id,'unsorted');
});
test('one nanosecond positive overlap is sufficient',()=>{const a=recording('a'),b=recording('b',60);b.recording_metadata!.start_ns=(BigInt(b.recording_metadata!.start_ns!)-1n).toString();assert.equal(recordingGroups([a,b])[0].automatic,true);});
test('missing, invalid, suspect and legacy metadata stay unsorted',()=>{
 const invalid:Recording[]=[recording('legacy',0,60,{recording_metadata:undefined})];
 for(const [key,values] of Object.entries({start_ns:[null,'0','-1','NaN','1.5','999999999999999999999'],duration_ns:[null,'0','-1','Infinity','1e9','604800000000001'],start_source:[null,'unknown'],duration_source:[null,'guess'],warning:['Conflicting timestamps'],probe_error:['Unavailable']})){
  for(const value of values){const f=recording(`bad-${invalid.length}`);Object.assign(f.recording_metadata!,{[key]:value});invalid.push(f);}
 }
 assert.deepEqual(ids([recording('a'),recording('b'),...invalid]),[['a','b'],invalid.map(f=>f.id)]);
});
test('filesystem fallback requires explicit provenance and available duration',()=>{
 const f=recording('fallback');f.recording_metadata!.start_source='filesystem_modified';
 assert.ok(recordingInterval(f));assert.equal(f.recording_metadata!.start_source,'filesystem_modified');
 f.timestamp_warning='Suspect date';assert.equal(recordingInterval(f),null);
 f.timestamp_warning=null;f.recording_metadata!.duration_ns=null;assert.equal(recordingInterval(f),null);
});
test('manual IDs and legacy named groups survive invalid metadata and never absorb suggestions',()=>{
 const files=[recording('manual',0,60,{group_id:'saved',group_name:'Interview',recording_metadata:null}),recording('manual2',0,60,{group_id:'saved',group_name:'Interview'}),recording('legacy',0,60,{group_name:'Named'}),recording('a'),recording('b')];
 const before=JSON.stringify(files);const groups=recordingGroups(files);assert.deepEqual(groups.map(g=>g.id),['saved','legacy:Named','auto:a']);assert.deepEqual(groups[0].files.map(f=>f.id),['manual','manual2']);assert.equal(JSON.stringify(files),before);
});
test('previous automatic assignments are reconsidered and equal starts sort stably',()=>{
 const files=[recording('b'),recording('a',0,60,{group_id:'suggested-old',group_name:'Old'})];assert.deepEqual(recordingGroups(files),recordingGroups([...files].reverse()));assert.equal(recordingGroups(files)[0].id,'auto:a');
});
test('shared scale faithfully positions short, long and widely separated manual intervals',()=>{
 const files=[recording('long',0,10000),recording('short',1,1),recording('distant',20000,10)];const t=recordingTimeline(files)!;
 assert.equal(t.rows[0].left,0);assert.equal(t.rows[0].width,10000/20010*100);assert.equal(t.rows[1].width,1/20010*100);assert.equal(t.rows[2].left+t.rows[2].width,100);assert.ok(t.rows.every((r,i)=>r.file===files[i]));
 assert.equal(recordingTimeline([recording('unknown',0,60,{recording_metadata:null})]),null);
});
test('each file appears once with nested overlaps, isolated recordings and manual groups',()=>{
 const files=Array.from({length:200},(_,i)=>recording(`clip-${i}`,i*30,45,i%17===0?{recording_metadata:null}:i%23===0?{group_id:'manual',group_name:'Interview'}:{}));
 const output=recordingGroups(files).flatMap(g=>g.files.map(f=>f.id));assert.equal(output.length,files.length);assert.equal(new Set(output).size,files.length);
});
