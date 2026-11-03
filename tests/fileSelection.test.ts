import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectFilePaths} from '../src/components/fileSelection.ts';

const files=['clean-a','clean-b','raw-a','raw-b'];
test('plain selection replaces; Ctrl adds and toggles without duplicates',()=>{
  assert.deepEqual(selectFilePaths(['clean-a'],files,'raw-a','clean-a',false,true),['clean-a','raw-a']);
  assert.deepEqual(selectFilePaths(['clean-a','raw-a'],files,'clean-a','raw-a',false,true),['raw-a']);
  assert.deepEqual(selectFilePaths(['clean-a','raw-a'],files,'raw-b','raw-a'),['raw-b']);
});
test('Shift ranges follow display order across the Clean/Raw divider in either direction',()=>{
  assert.deepEqual(selectFilePaths([],files,'raw-a','clean-b',true),['clean-b','raw-a']);
  assert.deepEqual(selectFilePaths([],files,'clean-a','raw-b',true),files);
  assert.deepEqual(selectFilePaths(['raw-b'],files,'clean-b','clean-a',true,true),['raw-b','clean-a','clean-b']);
});
test('hidden selections and missing anchors cannot leak into a drag',()=>{
  assert.deepEqual(selectFilePaths(['hidden','raw-a'],files,'clean-a','missing',true),['clean-a']);
  assert.deepEqual(selectFilePaths(['hidden','raw-a'],files,'clean-a',null,false,true),['raw-a','clean-a']);
});
