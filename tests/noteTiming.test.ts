import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNoteTime, parseNoteTime, validNoteRange } from '../src/components/noteTiming.ts';

test('whole-second formatting matches player readouts and handles minute and hour boundaries',()=>{
  assert.equal(formatNoteTime(59.9996),'00:00:59');
  assert.equal(formatNoteTime(3599.9996),'00:59:59');
  assert.equal(formatNoteTime(3600),'01:00:00');
  assert.equal(parseNoteTime(formatNoteTime(1364.869)),1364);
});
test('input normalizes legacy fractional values to seconds and rejects invalid components',()=>{
  assert.equal(parseNoteTime('22:44.869'),1364);
  assert.equal(parseNoteTime('01:22:44.01'),4964);
  assert.equal(parseNoteTime('00:00:01:12'),1);
  for(const value of ['-00:01','00:60:00','00:00:60','00:00:01.1234','00:00:01:25','bad'])assert.equal(parseNoteTime(value),null,value);
});
test('ranges must be ordered, nonempty and within the source duration',()=>{
  assert.ok(validNoteRange(10,11,20));
  assert.ok(validNoteRange(0,20,20));
  assert.ok(validNoteRange(20,null,20));
  for(const [start,end] of [[10.1,11],[10,10.5],[10,10],[10,9],[10,21],[-1,10],[NaN,10],[10,Infinity]])assert.equal(validNoteRange(start,end,20),false);
  assert.equal(validNoteRange(null,10,20),false);
});
