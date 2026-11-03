import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewLayers,type PreviewLayer} from '../src/components/previewLayers.ts';
const a:PreviewLayer={id:0,source:'A',ready:true,failed:false};
test('an interrupted fade keeps every visible layer until a replacement is opaque',()=>{
  let layers=previewLayers([a],{type:'request',id:1,source:'B'});
  layers=previewLayers(layers,{type:'ready',id:1});
  layers=previewLayers(layers,{type:'request',id:2,source:'C'});
  assert.deepEqual(layers.map(l=>l.source),['A','B','C']);
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
