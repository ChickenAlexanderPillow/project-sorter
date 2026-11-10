import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientRecordingFiles,clientOverlapGroups,clientAssetCategory,type ClientAsset} from '../src/components/clientFileGroups.ts';
const file=(path:string,kind='video'):ClientAsset=>({name:path.split('/').at(-1)!,path,relative_path:path,kind,variant:'Media',size:10,modified_ms:0});
const metadata=(start=0,duration=60)=>({start_ns:String(BigInt(Date.UTC(2026,0,1)+start*1000)*1_000_000n),duration_ns:String(BigInt(duration)*1_000_000_000n),start_source:'format.creation_time',duration_source:'stream.duration',warning:null,probe_error:null});
test('All retains projects, media, stills and supporting files in either view',()=>{
 const files=[file('edit/main.prproj','project'),file('raw/a.mp4'),file('audio/mic.wav','audio'),file('stills/a.png','image'),file('misc/notes.txt','other')];
 const before=JSON.stringify(files);const rows=clientRecordingFiles(files,{'raw/a.mp4':metadata(),'audio/mic.wav':metadata(30)});
 const groups=clientOverlapGroups(rows);assert.equal(groups[0].timeline,true);assert.deepEqual(groups[0].files.map(f=>f.path),['raw/a.mp4','audio/mic.wav']);
 assert.deepEqual(groups[1].files.map(f=>f.path),['edit/main.prproj','stills/a.png','misc/notes.txt']);assert.equal(groups.flatMap(g=>g.files).length,5);assert.equal(JSON.stringify(files),before);
 assert.deepEqual(files.map(clientAssetCategory),['Projects','Video','Audio','Stills','Other']);
});
test('missing intervals and projects never gain a pill from filesystem dates or injected metadata',()=>{
 const files=[file('a.mp4'),file('main.prproj','project')];const rows=clientRecordingFiles(files,{'main.prproj':metadata()});
 assert.ok(rows.every(row=>row.recording_metadata===null));assert.ok(clientOverlapGroups(rows).every(group=>!group.timeline));
});
test('timeline rows retain distinct paths for identical basenames across raw and proxy',()=>{
 const paths=['raw/take.mp4','proxy/take.mp4','audio/mic.wav'];const rows=clientRecordingFiles(paths.map(p=>file(p)),Object.fromEntries(paths.map(p=>[p,metadata()])));
 assert.equal(new Set(clientOverlapGroups(rows)[0].files.map(f=>f.id)).size,3);
});
