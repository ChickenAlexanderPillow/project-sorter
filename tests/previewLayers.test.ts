import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewLayers,type PreviewLayer} from '../src/components/previewLayers.ts';
const a:PreviewLayer={id:0,source:'A',ready:true,failed:false};
test('an interrupted fade retains only the newest displayed frame',()=>{
  let layers=previewLayers([a],{type:'request',id:1,source:'B'});
  layers=previewLayers(layers,{type:'ready',id:1});
  layers=previewLayers(layers,{type:'request',id:2,source:'C'});
  assert.deepEqual(layers.map(l=>l.source),['B','C']);
  layers=previewLayers(layers,{type:'settled',id:1});
  assert.deepEqual(layers.map(l=>l.source),['B','C']);
  assert.equal(layers[0].ready,true);
});
test('slow abandoned loads and failures cannot replace the newest selection',()=>{
  let layers=previewLayers([a],{type:'request',id:1,source:'slow'});
  layers=previewLayers(layers,{type:'request',id:2,source:'latest'});
  const current=layers;
  assert.equal(previewLayers(layers,{type:'ready',id:1}),current);
  assert.equal(previewLayers(layers,{type:'failed',id:1}),current);
  layers=previewLayers(layers,{type:'ready',id:2});
  layers=previewLayers(layers,{type:'settled',id:2});
  assert.deepEqual(layers,[{id:2,source:'latest',ready:true,failed:false}]);
});

test('video to audio retains the video until the audio is ready',()=>{
  const video={...a,source:'interview.mp4'};
  let layers=previewLayers([video],{type:'request',id:1,source:'interview.wav'});
  assert.deepEqual(layers[0],video);
  assert.equal(layers[1].ready,false);
  layers=previewLayers(layers,{type:'ready',id:1});
  assert.equal(layers.length,2);
  layers=previewLayers(layers,{type:'settled',id:1});
  assert.equal(layers.length,1);
  assert.equal(layers[0].source,'interview.wav');
});

test('rapid video audio image selections discard the unready intermediate file',()=>{
  let layers=previewLayers([{...a,source:'interview.mp4'}],{type:'request',id:1,source:'interview.wav'});
  layers=previewLayers(layers,{type:'request',id:2,source:'photo.jpg'});
  assert.deepEqual(layers.map(layer=>layer.source),['interview.mp4','photo.jpg']);
  const waiting=layers;
  assert.equal(previewLayers(layers,{type:'ready',id:1}),waiting);
  assert.equal(previewLayers(layers,{type:'failed',id:1}),waiting);
});

test('rapid switching never retains more than two live surfaces',()=>{
  let layers:PreviewLayer[]=[a];
  for(let id=1;id<100;id++){
    layers=previewLayers(layers,{type:'request',id,source:String(id)});
    assert.ok(layers.length<=2);
    layers=previewLayers(layers,{type:'ready',id});
  }
});

test('poster and decoder readiness events cannot repeatedly restart a revealed preview',()=>{
  const layers=previewLayers([a],{type:'ready',id:0});
  assert.equal(previewLayers(layers,{type:'ready',id:0}),layers);
  const failed=previewLayers(layers,{type:'failed',id:0});
  assert.equal(previewLayers(failed,{type:'failed',id:0}),failed);
});
