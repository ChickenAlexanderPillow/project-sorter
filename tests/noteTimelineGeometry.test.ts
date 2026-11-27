import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markerLanes,markerViewport,timelineSecond,moveRangeBoundary} from '../src/components/noteTimelineGeometry.ts';

test('a short range in a long recording gets a useful zoom with both ends visible',()=>{
  const view=markerViewport(1568,1365,1385);
  const span=1568/view.zoom;
  assert.equal(span,32);
  assert.ok(view.center-span/2<1365);
  assert.ok(view.center+span/2>1385);
});
test('focus stays within the recording at either edge and for a whole-recording range',()=>{
  assert.deepEqual(markerViewport(100,0),{zoom:10,center:5});
  assert.deepEqual(markerViewport(100,99),{zoom:10,center:95});
  assert.deepEqual(markerViewport(100,0,100),{zoom:1,center:50});
  assert.deepEqual(markerViewport(0,0),{zoom:1,center:0});
});
test('drag coordinates use the scrolled track origin and clamp to whole seconds',()=>{
  assert.equal(timelineSecond(150,-100,1000,100),25);
  assert.equal(timelineSecond(-200,-100,1000,100),0);
  assert.equal(timelineSecond(1200,-100,1000,100.9),100);
});
test('range handles cannot cross or leave the source and retain a one-second range',()=>{
  assert.deepEqual(moveRangeBoundary(10,20,25,'in',30),{start:19,end:20});
  assert.deepEqual(moveRangeBoundary(10,20,5,'out',30),{start:10,end:11});
  assert.deepEqual(moveRangeBoundary(10,20,-5,'in',30),{start:0,end:20});
  assert.deepEqual(moveRangeBoundary(10,20,45,'out',30),{start:10,end:30});
});
test('overlapping ranges and crowded point targets use distinct marker rows',()=>{
  const layout=markerLanes([
    {key:'a',seconds:3,endSeconds:8,selected:true},
    {key:'b',seconds:6,endSeconds:11},
    {key:'c',seconds:12},
    {key:'d',seconds:12},
  ],16,640);
  assert.notEqual(layout.rows.a,layout.rows.b);
  assert.notEqual(layout.rows.c,layout.rows.d);
  assert.equal(layout.rows.c,0);
});
