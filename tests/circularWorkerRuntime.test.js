import test from 'node:test';
import assert from 'node:assert/strict';
import {createCircularWorkerRuntime} from '../src/workers/circularWorkerRuntime.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({enabled=true,connect=async()=>{},run=async()=>0}={}) {
 const calls={connect:0,disconnect:0,batches:0};
 const db={$connect:async()=>{calls.connect++;await connect();},$disconnect:async()=>{calls.disconnect++;}};
 const worker=createCircularWorkerRuntime({db,queue:{runOnce:async()=>{calls.batches++;return run();}},enabled:()=>enabled,mailReady:()=>true,log:{info(){},error(){}},pollMs:60000});
 return {worker,calls};
}
test('starts once only after successful connection and promptly interrupts idle polling',async()=>{
 const gate=deferred();const {worker,calls}=fixture({connect:()=>gate.promise});
 const first=worker.start();assert.equal(worker.start(),first);assert.equal(calls.batches,0);
 gate.resolve();assert.equal(await first,true);assert.equal(calls.connect,1);assert.equal(calls.batches,1);
 await worker.stop();assert.equal(calls.disconnect,1);
});
test('shutdown drains an in-flight mocked email batch and never starts another',async()=>{
 const gate=deferred();let mockEmails=0;
 const {worker,calls}=fixture({run:async()=>{await gate.promise;mockEmails++;return 1;}});
 await worker.start();const stop=worker.stop();assert.equal(worker.stop(),stop);
 await tick();assert.equal(calls.disconnect,0);gate.resolve();await stop;
 assert.equal(mockEmails,1);assert.equal(calls.batches,1);assert.equal(calls.disconnect,1);
});
test('disabled worker never connects or processes jobs',async()=>{
 const {worker,calls}=fixture({enabled:false});assert.equal(await worker.start(),false);
 await worker.stop();assert.equal(calls.connect,0);assert.equal(calls.batches,0);
});
test('shutdown during initialization cannot start the queue afterwards',async()=>{
 const gate=deferred();const {worker,calls}=fixture({connect:()=>gate.promise});
 const start=worker.start();const stop=worker.stop();gate.resolve();assert.equal(await start,false);await stop;assert.equal(calls.batches,0);
});
test('database failure does not process mail and remains cleanly stoppable',async()=>{
 const {worker,calls}=fixture({connect:async()=>{throw Error('test database unavailable');}});
 await assert.rejects(worker.start(),/test database/);await worker.stop();assert.equal(calls.batches,0);assert.equal(calls.disconnect,1);
});
