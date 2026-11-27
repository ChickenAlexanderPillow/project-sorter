import {test} from 'node:test';
import assert from 'node:assert/strict';
import {noteRangeContains,activeNoteRangeIds} from '../src/components/activeNoteRanges.ts';

test('highlight starts at In and ends at Out',()=>{
  assert.equal(noteRangeContains(9.99,10,20),false);
  assert.equal(noteRangeContains(10,10,20),true);
  assert.equal(noteRangeContains(19.99,10,20),true);
  assert.equal(noteRangeContains(20,10,20),false);
  assert.equal(noteRangeContains(21,10,20),false);
});
test('all overlapping ranges highlight independently of selection',()=>{
  const markers=[
    {taskId:'a',referenceId:'one',timecode:'00:00:10',end_timecode:'00:00:20'},
    {taskId:'b',referenceId:'two',timecode:'00:00:15',end_timecode:'00:00:25'},
    {taskId:'c',referenceId:'point',timecode:'00:00:17'},
  ];
  assert.deepEqual(activeNoteRangeIds(markers,17),['a:one','b:two']);
  assert.deepEqual(activeNoteRangeIds(markers,20),['b:two']);
  assert.deepEqual(activeNoteRangeIds(markers,25),[]);
});
test('missing, reversed or invalid ranges never highlight',()=>{
  assert.equal(noteRangeContains(10,10),false);
  assert.equal(noteRangeContains(10,20,10),false);
  assert.equal(noteRangeContains(NaN,10,20),false);
  assert.deepEqual(activeNoteRangeIds([{taskId:'a',referenceId:'bad',timecode:'invalid',end_timecode:'00:00:20'}],15),[]);
});
