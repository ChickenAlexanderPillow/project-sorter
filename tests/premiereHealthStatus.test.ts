import {test} from 'node:test';
import assert from 'node:assert/strict';
import {statusFor} from '../src/components/premiereHealthStatus.ts';

test('available local files remain warnings and never enter the NAS list', () => {
  const statuses = ['available_local', 'available_nas', 'available_after_season_move'];
  assert.equal(statusFor('available_local'), 'local');
  assert.deepEqual(statuses.filter(status => statusFor(status) === 'found'), ['available_nas']);
});

test('missing, inaccessible and moved files retain distinct warnings', () => {
  assert.equal(statusFor('missing_local'), 'missing');
  assert.equal(statusFor('missing_nas'), 'missing');
  assert.equal(statusFor('unavailable_local'), 'unavailable');
  assert.equal(statusFor('unavailable_nas'), 'unavailable');
  assert.equal(statusFor('available_after_season_move'), 'moved');
  assert.equal(statusFor('new_unrecognised_status'), 'unknown');
});
