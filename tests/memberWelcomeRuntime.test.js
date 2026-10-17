import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberWelcomeRuntime } from '../src/workers/memberWelcomeRuntime.js';

test('welcome runtime is inert unless explicitly enabled and mail-configured',async()=>{
  for(const [enabled,ready] of [[false,true],[true,false]]){
    const worker=createMemberWelcomeRuntime({enabled:()=>enabled,mailReady:()=>ready,db:{memberAccess:{findMany:()=>assert.fail()}},service:{recover:()=>assert.fail()}});
    worker.start();await worker.stop();
  }
});

test('enabled runtime drains the persisted queue once and stops without sending duplicates',async()=>{
  let delivered=0,release;const done=new Promise(resolve=>{release=resolve;});
  const worker=createMemberWelcomeRuntime({enabled:()=>true,mailReady:()=>true,db:{memberAccess:{findMany:async()=>[{user_id:'private@example.test'}]}},service:{recover:async()=>{},deliver:async()=>{delivered++;release();}}});
  worker.start();await done;await worker.stop();assert.equal(delivered,1);
});
