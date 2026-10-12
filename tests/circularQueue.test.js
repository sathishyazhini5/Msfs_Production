import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {CircularService} from '../src/services/circularService.js';
import {CircularQueue,failurePolicy} from '../src/services/circularQueue.js';
import {database} from './helpers/controllerHarness.js';
const connection=process.env.CIRCULAR_TEST_DATABASE_URL;
const scope={user:{user_id:'sender@example.test'},role:'province admin',provinceCodes:['P1']};
let db,bootstrap,service,files;
const schema=`circular_test_${Date.now()}_${randomUUID().replaceAll('-','').slice(0,8)}`;
const integration=(name,fn)=>test(name,{skip:!connection},fn);
before(async()=>{
 if(!connection)return;
 assert.match(schema,/^circular_test_[a-z0-9_]+$/);
 bootstrap=new PrismaClient({datasources:{db:{url:connection}}});
 await bootstrap.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
 const url=new URL(connection);url.searchParams.set('schema',schema);
 db=new PrismaClient({datasources:{db:{url:url.toString()}}});
 const current=await db.$queryRaw`SELECT current_schema() AS name`;assert.equal(current[0].name,schema);
 const migration=await readFile(new URL('../src/prisma/migrations/20261012120000_circular_management/migration.sql',import.meta.url),'utf8');
 for(const statement of migration.split(';').filter(s=>s.trim()))await db.$executeRawUnsafe(statement);
});
after(async()=>{if(db)await db.$disconnect();if(bootstrap){assert.match(schema,/^circular_test_[a-z0-9_]+$/);await bootstrap.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await bootstrap.$disconnect();}});
beforeEach(async()=>{
 if(!db)return;
 await db.circularRecipient.deleteMany();await db.circular.deleteMany();await db.circularAttachment.deleteMany();files=new Map();
 const business=database({province_mst:[{province_code:'P1',province_name:'One',concretion_code:'C1'},{province_code:'P2',province_name:'Two',concretion_code:'C2'}],
 confreres_dtl:[{confrer_code:'A',province_code:'P1',first_name:'Alice',personal_mailid1:'alice@example.test',is_active:true},{confrer_code:'B',province_code:'P1',first_name:'Bob',personal_mailid1:'bob@example.test',is_active:true},{confrer_code:'C',province_code:'P1',first_name:'Carol',personal_mailid1:'carol@example.test',is_active:true}],scholastics_dtl:[],curia_advisors_dtl:[]});
 const facade={...business,circular:db.circular,circularAttachment:db.circularAttachment,circularRecipient:db.circularRecipient,$transaction:fn=>db.$transaction(fn)};
 service=new CircularService({db:facade,storage:{upload:async b=>{const key=randomUUID();files.set(key,b);return key;},download:async key=>files.get(key),remove:async key=>files.delete(key)},mailReady:()=>true,workerEnabled:()=>true});
});
async function draft(){const attachment=await service.upload(scope,{originalname:'circular.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-test private attachment')});return service.save(scope,{subject:'Test circular',message:'For mocked test transport only.',attachmentId:attachment.id,selection:{filters:{province:'P1',categories:['Confrere']},mode:'all',excludedKeys:[]}});}
async function queued(){const saved=await draft(),review=await service.review(scope,saved.id);const input={version:review.version,reviewToken:review.reviewToken,idempotencyKey:randomUUID()};await service.queue(scope,saved.id,input);return {id:saved.id,input};}
const queue=send=>new CircularQueue({db,send,download:async key=>files.get(key),concurrency:2});
const accepting=calls=>async options=>{assert.equal(options.cc,undefined);assert.equal(options.bcc,undefined);assert.ok(options.attachment.buffer.length>0);calls.push(options.to);return {accepted:[options.to],messageId:options.messageId};};
test('retry classification never retries an ambiguous post-DATA SMTP timeout',()=>{
 assert.equal(failurePolicy({command:'DATA',code:'ETIMEDOUT'},1,true).retry,false);
 assert.equal(failurePolicy({responseCode:450},1,true).retry,true);
 assert.equal(failurePolicy({responseCode:450},3,true).retry,false);
});
integration('durable draft, review, concurrent duplicate submissions and scope enforcement',async()=>{
 const saved=await draft(),review=await service.review(scope,saved.id),input={version:review.version,reviewToken:review.reviewToken,idempotencyKey:randomUUID()};
 assert.equal(review.counts.eligible,3);
 await assert.rejects(service.detail({...scope,user:{user_id:'another@example.test'}},saved.id),e=>e.status===404);
 await assert.rejects(service.detail({...scope,provinceCodes:['P2']},saved.id),e=>e.status===404);
 await assert.rejects(service.save(scope,{subject:'Edit',message:'Text',selection:saved.selection,version:999},saved.id),e=>e.status===409);
 await assert.rejects(service.queue(scope,saved.id,{...input,reviewToken:'stale'}),e=>e.status===409);
 await Promise.all([service.queue(scope,saved.id,input),service.queue(scope,saved.id,input)]);
 assert.equal(await db.circularRecipient.count(),3);
 await service.queue(scope,saved.id,input);assert.equal(await db.circularRecipient.count(),3);
 await assert.rejects(service.queue(scope,saved.id,{...input,idempotencyKey:randomUUID()}),e=>e.status===409);
 assert.equal((await service.list({...scope,provinceCodes:['P2']},{tab:'history'})).total,0);
 assert.equal((await service.list(scope,{tab:'history',search:'No match'})).total,0);
 const day=saved.created_at.toISOString().slice(0,10);
 assert.equal((await service.list(scope,{tab:'history',status:'Queued',from:day,to:day})).total,1);
 await assert.rejects(service.list(scope,{tab:'history',from:'2026-02-30'}),e=>e.status===400);
});
integration('multiple workers claim once, send separate envelopes and never fabricate delivery',async()=>{
 const {id}=await queued(),calls=[];const send=accepting(calls);
 await Promise.all([queue(send).runOnce(),queue(send).runOnce()]);await queue(send).runOnce();
 assert.equal(calls.length,3);assert.equal(new Set(calls).size,3);
 const row=await service.detail(scope,id);assert.equal(row.status,'Sent');assert.equal(row.sent_count,3);assert.ok(row.recipients.every(r=>r.delivered_at===null));
 await queue(send).runOnce();assert.equal(calls.length,3);
});
integration('safe transient retries are bounded and Retry Failed Only never resends successful recipients',async()=>{
 const {id}=await queued(),calls=[];let reject=true;
 const send=async options=>{calls.push(options.to);if(options.to==='bob@example.test' && reject)throw Object.assign(new Error('Test rejection'),{responseCode:550});return {accepted:[options.to]};};
 const worker=queue(send);await worker.runOnce();await worker.runOnce();
 assert.equal((await service.detail(scope,id)).status,'Partial Success');
 reject=false;assert.equal((await service.retry(scope,id)).queued,1);await worker.runOnce();
 assert.equal((await service.detail(scope,id)).status,'Sent');assert.equal(calls.filter(v=>v==='alice@example.test').length,1);assert.equal(calls.filter(v=>v==='carol@example.test').length,1);assert.equal(calls.filter(v=>v==='bob@example.test').length,2);
});
integration('automatic temporary failures stop at the configured attempt limit',async()=>{
 const {id}=await queued(),calls=[];const worker=queue(async options=>{calls.push(options.to);throw Object.assign(new Error('Test temporary rejection'),{responseCode:450});});
 for(let i=0;i<6;i++){await worker.runOnce();await db.circularRecipient.updateMany({where:{status:'Queued'},data:{next_attempt_at:new Date(0)}});}
 const row=await service.detail(scope,id);assert.equal(row.status,'Failed');assert.ok(row.recipients.every(r=>r.attempts===3));assert.equal(calls.length,9);
 await assert.rejects(service.retry(scope,id),e=>e.status===409);
});
integration('restart recovery resumes pre-SMTP reservations but quarantines uncertain submissions',async()=>{
 const {id}=await queued(),worker=queue(async options=>({accepted:[options.to]}));
 const reserved=await worker.claim();await db.circularRecipient.update({where:{id:reserved.id},data:{lease_until:new Date(0)}});await worker.recover();
 const recovered=await db.circularRecipient.findUnique({where:{id:reserved.id}});assert.equal(recovered.status,'Queued');assert.equal(recovered.attempts,0);
 const started=await worker.claim();await db.circularRecipient.update({where:{id:started.id},data:{smtp_started_at:new Date(),lease_until:new Date(0)}});await worker.recover();
 const uncertain=await db.circularRecipient.findUnique({where:{id:started.id}});assert.equal(uncertain.status,'Failed');assert.equal(uncertain.retryable,false);
 await worker.runOnce();await worker.runOnce();assert.equal((await service.detail(scope,id)).status,'Partial Success');
 await assert.rejects(service.retry(scope,id),e=>e.status===409);
});
integration('ambiguous SMTP failures and attachment corruption are never reported as sent',async()=>{
 const {id}=await queued();await queue(async()=>{throw Object.assign(new Error('Unknown acceptance'),{command:'DATA',code:'ETIMEDOUT'});}).runOnce();
 const rows=await db.circularRecipient.findMany({where:{circular_id:id}});assert.ok(rows.filter(r=>r.status==='Failed').every(r=>!r.retryable && !r.sent_at));
 let calls=0;for(const key of files.keys())files.set(key,Buffer.from('corrupted'));
 await queue(async()=>{calls++;return {accepted:[]};}).runOnce();assert.equal(calls,0);
});

integration('deduplicated recipient snapshots persist independently of directory edits',async()=>{
 await service.db.confreres_dtl.create({data:{confrer_code:'DUPLICATE',province_code:'P1',first_name:'Duplicate record',personal_mailid1:'ALICE@example.test',is_active:true}});
 const saved=await draft(),review=await service.review(scope,saved.id);
 assert.equal(review.counts.selected,4);assert.equal(review.counts.eligible,3);assert.equal(review.counts.duplicates,1);
 await service.queue(scope,saved.id,{version:review.version,reviewToken:review.reviewToken,idempotencyKey:randomUUID()});
 const recipient=await db.circularRecipient.findUnique({where:{circular_id_email:{circular_id:saved.id,email:'alice@example.test'}}});
 assert.equal(recipient.snapshot.sources.length,2);
 await service.db.confreres_dtl.update({where:{confrer_code:'A'},data:{first_name:'Changed name',personal_mailid1:'changed@example.test'}});
 const snapshot=(await service.detail(scope,saved.id)).recipients.find(r=>r.email==='alice@example.test');assert.equal(snapshot.snapshot.name,'Alice');assert.equal(snapshot.email,'alice@example.test');
});

integration('attachment removal is private and cannot delete a referenced circular file',async()=>{
 const saved=await draft(),key=(await service.get(scope,saved.id)).attachment.blob_key;
 await assert.rejects(service.removeAttachment(scope,saved.attachment.id),e=>e.status===409);
 await assert.rejects(service.attachment({...scope,user:{user_id:'another@example.test'}},saved.attachment.id),e=>e.status===404);
 const updated=await service.save(scope,{subject:saved.subject,message:saved.message,selection:saved.selection,attachmentId:null,version:saved.version},saved.id);
 assert.equal(updated.attachment,null);
 await service.removeAttachment(scope,saved.attachment.id);assert.equal(files.has(key),false);
 await assert.rejects(service.attachment(scope,saved.attachment.id),e=>e.status===404);
});
