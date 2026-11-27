import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloseRequestHandler } from '../src/components/closeRequest.ts';

test('idle close is allowed without a confirmation or another close request', async () => {
  let prevented = false;
  const handler = createCloseRequestHandler({shouldWarn:()=>false, confirmClose:async()=>{throw new Error('unexpected confirmation');}, onError:()=>assert.fail('unexpected error')});
  await handler({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,false);
});
test('busy close follows the choice and permits a later attempt after cancelling', async () => {
  let allowed=false;
  const handler=createCloseRequestHandler({shouldWarn:()=>true,confirmClose:async()=>allowed,onError:()=>assert.fail('unexpected error')});
  let prevented=false;
  await handler({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  allowed=true;prevented=false;
  await handler({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,false);
});
test('repeated close requests cannot stack confirmations', async () => {
  let finish!:(allowed:boolean)=>void;
  let confirmations=0;
  const handler=createCloseRequestHandler({shouldWarn:()=>true,confirmClose:()=>{confirmations++;return new Promise<boolean>(resolve=>{finish=resolve;});},onError:()=>assert.fail('unexpected error')});
  let firstPrevented=false,secondPrevented=false;
  const first=handler({preventDefault:()=>{firstPrevented=true;}});
  await handler({preventDefault:()=>{secondPrevented=true;}});
  finish(true);await first;
  assert.equal(confirmations,1);assert.equal(firstPrevented,false);assert.equal(secondPrevented,true);
});
