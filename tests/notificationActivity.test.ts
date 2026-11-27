import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityPercent, finishBackgroundActivity, getBackgroundActivities, reportBackgroundActivity } from '../src/components/notificationActivity.ts';

test('progress is based on measured work and unknown totals are not fabricated',()=>{
  assert.equal(activityPercent(25,100),25);
  assert.equal(activityPercent(5,0),null);
  assert.equal(activityPercent(undefined,100),null);
  assert.equal(activityPercent(500,100),100);
  assert.equal(activityPercent(-10,100),0);
});
test('background work retains the latest progress independently of mounted views and removes finished jobs',()=>{
  const base={id:'drive-test',kind:'drive' as const,title:'Copying to drive',context:'Client',detail:'Camera.mov',percent:5};
  reportBackgroundActivity(base);
  const initial=getBackgroundActivities();
  reportBackgroundActivity({...base,percent:75});
  assert.equal(initial.find(item=>item.id===base.id)?.percent,5);
  assert.equal(getBackgroundActivities().filter(item=>item.id===base.id).length,1);
  assert.equal(getBackgroundActivities().find(item=>item.id===base.id)?.percent,75);
  finishBackgroundActivity(base.id);
  assert(!getBackgroundActivities().some(item=>item.id===base.id));
});
