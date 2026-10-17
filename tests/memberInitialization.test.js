import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import {database,response,matches,loadController} from './helpers/controllerHarness.js';
import {MemberAccessService} from '../src/services/memberAccessService.js';
import {canonicalMembers} from '../src/services/memberInitialization.js';
import {MemberWelcomeService,memberWelcomeTemplate} from '../src/services/memberWelcomeService.js';
import {createMemberGuard} from '../src/middlewares/memberGuard.js';
const scope={role:'super admin',provinceCodes:null,user:{user_id:'operator'}};
function fixture(){
 const rows={users_mst:[],memberAccess:[],memberPasswordToken:[],province_mst:[{province_code:'P1',concretion_code:'C1'},{province_code:'P2',concretion_code:'C2'}],concretion_defination_mst:[{concretion_code:'C1',concretion_name:'First Family',status:'Active'}],congregationBranding:[],confreres_dtl:[{confrer_code:'F1',province_code:'P1',first_name:'First',personal_mailid1:'first@example.test',is_active:true}],curia_advisors_dtl:[{confrer_code:'F1',province_code:'P1',personal_mailid1:'first@example.test'}],scholastics_dtl:[{scholastic_code:'S1',province_code:'P1',first_name:'Second',personal_mailid1:'second@example.test',is_active:true}]};
 const db=database(rows);
 for(const [model,records] of Object.entries(rows))db[model].updateMany=async({where,data})=>{const found=records.filter(row=>matches(row,where));for(const row of found)for(const [key,value]of Object.entries(data))row[key]=value?.increment!==undefined?(row[key] || 0)+value.increment:value;return {count:found.length};};
 for(const model of ['users_mst','memberAccess']){const create=db[model].create;db[model].create=async({data})=>{if(rows[model].some(r=>r.user_id===data.user_id))throw Object.assign(new Error('duplicate'),{code:'P2002'});return create({data:model==='memberAccess'?{enabled:true,password_initialized_at:null,password_changed_at:null,password_change_required:false,welcome_status:'NotRequested',welcome_attempts:0,...data}:data});};}
 return {db,rows,service:new MemberAccessService({db})};
}
const confrere={kind:'Confrere',code:'F1',province_code:'P1'},curia={...confrere,kind:'Curia'},scholastic={kind:'Scholastic',code:'S1',province_code:'P1'};
test('dry-run is read-only; Confrere/Curia overlap gets one hashed temporary account; reruns preserve passwords',async()=>{
 const {db,rows,service}=fixture();
 assert.equal(canonicalMembers(await service.directory(scope)).length,2);
 assert.equal((await service.provision(scope,confrere,{dryRun:true})).status,'created');assert.equal(rows.users_mst.length,0);
 assert.equal((await service.provision(scope,curia)).status,'created');
 assert.equal(rows.users_mst.length,1);assert.notEqual(rows.users_mst[0].password,'pass123');assert.equal(await bcrypt.compare('pass123',rows.users_mst[0].password),true);
 assert.equal(rows.memberAccess[0].password_change_required,false);assert.equal(rows.memberAccess[0].welcome_status,'Pending');
 const hash=rows.users_mst[0].password;assert.equal((await service.provision(scope,confrere)).reason,'already_initialized');assert.equal(rows.users_mst[0].password,hash);
 await service.provision(scope,scholastic);assert.equal(rows.users_mst.length,2);
 rows.memberAccess[0].password_change_required=true;
 await service.changeInitialPassword('first@example.test','pass123','a-new-private-password');
 assert.equal(rows.memberAccess[0].password_change_required,false);assert.ok(rows.memberAccess[0].password_changed_at);
 const changed=rows.users_mst[0].password;await service.provision(scope,curia,{legacyUninitialized:new Set(['first@example.test'])});assert.equal(rows.users_mst[0].password,changed);
 assert.equal(await bcrypt.compare('pass123',changed),false);assert.equal(await bcrypt.compare('a-new-private-password',changed),true);
 await assert.rejects(service.changeInitialPassword('first@example.test','pass123','another-private-password'));
 const guard=createMemberGuard(db),res=response({user_id:'second@example.test',role_name:'estatus member'});
 let passed=false;await guard({method:'GET',path:'/estatus/confrere'},res,()=>{passed=true;});assert.equal(passed,true);
 const denied=response({user_id:'first@example.test',role_name:'estatus member'});await guard({method:'GET',path:'/dashboard'},denied,()=>assert.fail());assert.equal(denied.statusCode,403);
});
test('administrator, shared/missing emails and foreign provinces never get reset or converted',async()=>{
 const {rows,service}=fixture();
 rows.users_mst.push({user_id:'first@example.test',role_name:'province admin',role_code:'RN003',password:'untouched'});
 assert.equal((await service.provision(scope,confrere)).reason,'administrator_or_other_role');assert.equal(rows.users_mst[0].password,'untouched');
 rows.scholastics_dtl[0].personal_mailid1='first@example.test';assert.equal((await service.provision(scope,confrere)).reason,'shared_email');
 rows.scholastics_dtl[0].personal_mailid1='';assert.equal((await service.provision(scope,scholastic)).reason,'missing_or_invalid_email');
 await assert.rejects(service.provision({...scope,role:'province admin',provinceCodes:['P2']},confrere),e=>e.status===404);
});
test('unknown legacy hashes require explicit review; known defaults initialize once',async()=>{
 const {rows,service}=fixture();await service.provision(scope,confrere);
 const link=rows.memberAccess[0];link.password_initialized_at=null;link.password_change_required=false;
 rows.users_mst[0].password=await bcrypt.hash('already-chosen-private-password',12);
 assert.equal((await service.provision(scope,confrere)).reason,'legacy_password_requires_review');
 const old=rows.users_mst[0].password;assert.equal(rows.users_mst[0].password,old);
 // Simulate operator-certified unused old initialization, never enabled by default.
 const result=await service.provision(scope,confrere,{legacyUninitialized:new Set(['first@example.test'])});assert.equal(result.status,'initialized');
 assert.equal((await service.provision(scope,confrere,{legacyUninitialized:new Set(['first@example.test'])})).reason,'already_initialized');
});
test('welcome outbox sends privately once; safe retries preserve identity and unknown SMTP outcomes are quarantined',async()=>{
 const {db,rows,service}=fixture();await service.provision(scope,confrere);let calls=0;const previews=[];
 const mail=new MemberWelcomeService({db,send:async options=>{calls++;previews.push(options);if(calls===1)throw Object.assign(new Error('connection'),{command:'CONN'});return {accepted:[options.to]};}});
 assert.equal((await mail.deliver('first@example.test')).status,'retryable');assert.equal((await mail.deliver('first@example.test')).status,'sent');
 assert.equal((await mail.deliver('first@example.test')).status,'not_pending');assert.equal(calls,2);
 for(const preview of previews){assert.match(preview.text,/Initial password: pass123/);assert.match(preview.text,/https:\/\/msfs.adminpro.co.in\/login/);assert.match(preview.html,/Explore More/);assert.match(preview.text,/https:\/\/msfs.adminpro.co.in\//);assert.match(preview.html,/First Family/);}
 await service.provision(scope,scholastic);const unknown=new MemberWelcomeService({db,send:async()=>{throw Object.assign(new Error('timeout'),{command:'DATA'});}});
 assert.equal((await unknown.deliver('second@example.test')).status,'unknown');assert.equal(rows.memberAccess[1].welcome_status,'Unknown');assert.equal((await unknown.deliver('second@example.test')).status,'not_pending');
 assert.ok(memberWelcomeTemplate({email:'x@example.test',congregation:'A < B'}).html.includes('A &lt; B'));
});

test('initial member login lands directly in E-Status; changed passwords revoke sessions; inactive congregation is blocked',async()=>{
 const {db,rows,service}=fixture();await service.provision(scope,confrere);
 const {login}=await loadController('../../src/controllers/auth/userlogin.js',db);
 const signIn=async password=>{const res=response();let error;await login({body:{user_id:'FIRST@example.test',password}},res,e=>{error=e;});return {res,error};};
 const first=await signIn('pass123');assert.equal(first.error,undefined);assert.equal(first.res.body.redirect,'/estatus');assert.equal(first.res.body.data.password_change_required,false);
 rows.memberAccess[0].password_change_required=true;
 await service.changeInitialPassword('first@example.test','pass123','my-new-member-password');
 const changed=await signIn('my-new-member-password');assert.equal(changed.error,undefined);assert.equal(changed.res.body.redirect,'/estatus');assert.equal(changed.res.body.data.password_change_required,false);
 assert.equal((await signIn('pass123')).error.status,401);
 const allowed=response({user_id:'first@example.test',role_name:'estatus member',password_version:changed.res.body.data.password_version});let next=false;await createMemberGuard(db)({method:'GET',path:'/estatus/confrere'},allowed,()=>{next=true;});assert.equal(next,true);assert.deepEqual(allowed.statusCode,200);
 const stale=response({user_id:'first@example.test',role_name:'estatus member',password_change_required:true});await createMemberGuard(db)({method:'GET',path:'/estatus/confrere'},stale,()=>assert.fail());assert.equal(stale.statusCode,401);
 rows.concretion_defination_mst[0].status='Inactive';assert.equal((await signIn('my-new-member-password')).error.status,403);
});
