import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pendingIngestSources} from '../src/components/pendingIngestSources.ts';
const copied={source:String.raw`E:\Card`,relative_path:'clips/Interview.mov',inbox_path:String.raw`Z:\Project\_INGEST\sources\batch\clips\Interview.mov`,size:100,source_modified:'123456789',status:'Verified',sha256:'verified'};
const input={path:String.raw`E:\Card\clips\Interview.mov`,size:100,modified:'123456789'};
test('reopening Collect excludes the previously verified source version',()=>{
 assert.deepEqual(pendingIngestSources([input],[copied]),[]);
 assert.deepEqual(pendingIngestSources([{...input,path:String.raw`\\?\E:\Card\clips\Interview.mov`}],[copied]),[]);
 assert.deepEqual(pendingIngestSources([input],[{...copied,source:input.path,relative_path:'Interview.mov',status:'Filed'}]),[]);
});
test('new cards, changed files, failed copies and uncertain versions remain visible',()=>{
 for(const file of [{...input,path:String.raw`F:\Card\clips\Interview.mov`},{...input,size:101},{...input,modified:'changed'},{...input,modified:null}])assert.equal(pendingIngestSources([file],[copied]).length,1);
 assert.equal(pendingIngestSources([input],[{...copied,status:'Failed'}]).length,1);
 assert.equal(pendingIngestSources([input],[{...copied,sha256:''}]).length,1);
});
test('partial batches retain only the sources that still need collection',()=>{
 const newFile={...input,path:String.raw`E:\Card\clips\New.mov`};
 assert.deepEqual(pendingIngestSources([input,newFile],[copied]),[newFile]);
});
