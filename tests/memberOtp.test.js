import test from 'node:test';
import assert from 'node:assert/strict';
import {MemberOtpService} from '../src/services/memberOtpService.js';
import {memberRouteAllowed} from '../src/middlewares/memberGuard.js';
import {database} from './helpers/controllerHarness.js';
function fixture() {
  let challenge; const sessions=new Map(), sent=[];
  const valid=(row,where)=>row && Object.entries(where).every(([key,value])=>value?.lt!==undefined?row[key]<value.lt:value?.gt!==undefined?row[key]>value.gt:row[key]===value);
  const db={
    memberOtpChallenge:{
      findUnique:async()=>challenge,
      upsert:async({create,update})=>challenge=challenge?{...challenge,...update}:create,
      updateMany:async({where,data})=>{if(!valid(challenge,where))return {count:0};challenge.attempts+=data.attempts.increment;return {count:1};},
      deleteMany:async({where})=>{if(!valid(challenge,where))return {count:0};challenge=undefined;return {count:1};},
    },
    memberOtpSession:{create:async({data})=>{sessions.set(data.id,data);return data;},findUnique:async({where})=>sessions.get(where.id),update:async({where,data})=>Object.assign(sessions.get(where.id),data)},
    $transaction:async fn=>fn(db),
  };
  const identities=[{kind:'Confrere',code:'C1',province_code:'P1',concretion_code:'CON1'}];
  const service=new MemberOtpService(db,async mail=>sent.push(mail));
  service.identities=async()=>identities;
  const otp=()=>sent[0].text.match(/\b\d{6}\b/)[0];
  return {db,service,sent,identities,otp,get challenge(){return challenge;}};
}
test('OTP is hashed, cooldown enforced, consumed once, and scanner GET does not revoke',async()=>{
  const f=fixture();await f.service.request(' MEMBER@example.test ');await f.service.request('member@example.test');
  assert.equal(f.sent.length,1);assert.notEqual(f.challenge.digest,f.otp());
  const {session}=await f.service.verify('member@example.test',f.otp(),null,'Test browser');
  await assert.rejects(f.service.verify('member@example.test',f.otp()),/invalid or expired/);
  assert.equal((await f.service.active(session.id)).id,session.id);
  const link=new URL(f.sent[1].text.match(/http\S+/)[0]);
  await f.service.revoke(session.id,link.searchParams.get('token'));
  assert.equal((await f.service.active(session.id)).id,session.id);
  await assert.rejects(f.service.revoke(session.id,'wrong',true),/invalid or expired/);
  await f.service.revoke(session.id,link.searchParams.get('token'),true);
  await assert.rejects(f.service.active(session.id),/revoked/);
});
test('expired codes and codes with five wrong attempts cannot authenticate',async()=>{
  const f=fixture();await f.service.request('member@example.test');
  for(let i=0;i<5;i++)await assert.rejects(f.service.verify('member@example.test','wrong'),/invalid or expired/);
  await assert.rejects(f.service.verify('member@example.test',f.otp()),/invalid or expired/);
  const g=fixture();await g.service.request('member@example.test');g.challenge.expires_at=new Date(0);
  await assert.rejects(g.service.verify('member@example.test',g.otp()),/invalid or expired/);
});
test('identity choice is required after mailbox proof and activation is rechecked',async()=>{
  const f=fixture();f.identities.push({kind:'Scholastic',code:'S1',province_code:'P1',concretion_code:'CON1'});
  await f.service.request('member@example.test');
  await assert.rejects(f.service.verify('member@example.test','wrong'),/invalid or expired/);
  const result=await f.service.verify('member@example.test',f.otp());assert.equal(result.choices.length,2);
  const {session}=await f.service.verify('member@example.test',f.otp(),result.choices[1]);assert.equal(session.identity.kind,'Scholastic');
  f.identities.length=0;await assert.rejects(f.service.active(session.id),/no longer active/);
});
test('read-only member routes allow directory exports and block admin and direct mutations',()=>{
  for(const path of ['/estatus/obituary','/estatus/obituary/export','/estatus/confrere/record/C1'])assert.equal(memberRouteAllowed('GET',path),true);
  for(const method of ['POST','PUT','DELETE','PATCH'])assert.equal(memberRouteAllowed(method,'/estatus/obituary'),false);
  assert.equal(memberRouteAllowed('GET','/dashboard-details'),false);assert.equal(memberRouteAllowed('POST','/SaveProvince'),false);
});
test('identity lookup uses all three real tables and rechecks member and congregation activation',async()=>{
 const person={confrer_code:'C1',province_code:'P1',personal_mailid1:'member@example.test',is_active:true};
 const congregation={concretion_code:'CON1',status:'Active'};
 const db=database({confreres_dtl:[person],scholastics_dtl:[{...person,scholastic_code:'S1'}],curia_advisors_dtl:[{...person,curia_code:'CUR1',division_type_code:'D1',division_code:'DIV1'}],province_mst:[{province_code:'P1',concretion_code:'CON1'}],concretion_defination_mst:[congregation]});
 const service=new MemberOtpService(db);assert.deepEqual((await service.identities(person.personal_mailid1)).map(row=>row.kind),['Confrere','Scholastic','Curia']);
 congregation.status='Inactive';assert.deepEqual(await service.identities(person.personal_mailid1),[]);
 congregation.status='Active';person.is_active=false;assert.deepEqual((await service.identities(person.personal_mailid1)).map(row=>row.kind),['Scholastic']);
});
