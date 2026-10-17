import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcrypt';
import {MemberAccessService,MEMBER_ROLE} from '../src/services/memberAccessService.js';
import {AnnualWishService,localCalendar,wishBody,wishTemplate} from '../src/services/annualWishService.js';
import {memberRouteAllowed,createMemberGuard} from '../src/middlewares/memberGuard.js';
import {database,response,loadController} from './helpers/controllerHarness.js';
const scope={role:'province admin',provinceCodes:['P1'],user:{user_id:'administrator'}};
function fixture(){
 const users=[],links=[];
 const rows={users_mst:users,memberAccess:links,province_mst:[{province_code:'P1',concretion_code:'C1'},{province_code:'P2',concretion_code:'C2'}],concretion_defination_mst:[{concretion_code:'C1',concretion_name:'First Family'},{concretion_code:'C2',concretion_name:'Second Family'}],confreres_dtl:[{confrer_code:'F1',province_code:'P1',first_name:'Alice',personal_mailid1:'alice@example.test',is_active:true,birth_date:new Date('1980-10-14'),ordination_date:new Date('2010-10-14')},{confrer_code:'F2',province_code:'P2',first_name:'Bob',personal_mailid1:'bob@example.test',is_active:true,birth_date:new Date('1985-10-14'),ordination_date:null}],scholastics_dtl:[],curia_advisors_dtl:[],congregationBranding:[]};
 const db=database(rows);const create=db.memberAccess.create;db.memberAccess.create=args=>create({data:{enabled:true,...args.data}});
 return {db,rows,users,links};
}
test('provisioning validates province, shared emails, duplicate records and privileged accounts',async()=>{
 const {db,rows,users}=fixture(),service=new MemberAccessService({db});
 await assert.rejects(service.provision(scope,{kind:'Confrere',code:'F2',province_code:'P2'}),e=>e.status===404);
 users.push({user_id:'ALICE@example.test',role_name:'super admin'});
 assert.equal((await service.provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'})).status,'conflict');
 assert.equal(users[0].role_name,'super admin');users.length=0;
 rows.confreres_dtl[1].personal_mailid1='alice@example.test';
 assert.equal((await service.provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'})).status,'conflict');
 rows.confreres_dtl[1].personal_mailid1='bob@example.test';
 const result=await service.provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'});
 assert.equal(result.email,'alice@example.test');assert.equal(users[0].role_name,MEMBER_ROLE);assert.ok(users[0].password.startsWith('$2'));
 assert.equal((await service.active(result.email)).concretion_code,'C1');
 rows.confreres_dtl[0].personal_mailid1='changed@example.test';await assert.rejects(service.active(result.email),e=>e.status===403);
});
test('member API guard permits congregation directories only and does not affect administrator routes',async()=>{
 for(const path of ['/reports','/circulars','/getusers','/estatus/confrere/export','/platform/dashboard'])assert.equal(memberRouteAllowed('GET',path),false);
 assert.equal(memberRouteAllowed('POST','/estatus/confrere'),false);assert.equal(memberRouteAllowed('GET','/estatus/confrere/record/F1'),true);
 const {db,rows}=fixture();const service=new MemberAccessService({db});await service.provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'});
 await db.memberAccess.update({where:{user_id:'alice@example.test'},data:{password_change_required:false,password_changed_at:new Date()}});
 const guard=createMemberGuard(db),req={method:'GET',path:'/estatus/confrere'},res=response({role_name:MEMBER_ROLE,user_id:'alice@example.test',password_version:rows.memberAccess[0].password_changed_at.getTime()});let passed=false;
 await guard(req,res,()=>{passed=true;});assert.equal(passed,true);assert.deepEqual(req.memberProvinceCodes,['P1']);
 const denied=response({role_name:MEMBER_ROLE,user_id:'alice@example.test'});await guard({method:'GET',path:'/reports'},denied,()=>assert.fail());assert.equal(denied.statusCode,403);
 const admin=response({role_name:'province admin'});await guard({method:'POST',path:'/existing-admin-action'},admin,()=>{passed=true;});
});
test('member password login returns read-only role and E-Status redirect without quickcode/default role fallback',async()=>{
 const {db,users}=fixture();await new MemberAccessService({db}).provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'});users[0].password=await bcrypt.hash('private-test-password',10);await db.memberAccess.update({where:{user_id:'alice@example.test'},data:{password_change_required:false,password_changed_at:new Date()}});
 const {login}=await loadController('../../src/controllers/auth/userlogin.js',db);
 const res=response();let error;await login({body:{user_id:'ALICE@example.test',password:'private-test-password'}},res,e=>{error=e;});assert.equal(error,undefined);assert.equal(res.body.redirect,'/estatus');assert.equal(res.body.data.role_name,MEMBER_ROLE);assert.ok(res.body.accessToken);assert.equal(res.body.data.password,undefined);
});
test('exact birthday and ordination content, escaped branding, separate greeting and timezone date',()=>{
 assert.equal(wishBody('Ordination','First Family'),'The First Family family joyfully wishes you a blessed Ordination Anniversary! May God grant you good health, abundant grace, and continued blessings in your priestly ministry. Be assured of our prayers and support always.');
 assert.equal(wishBody('Birthday','First Family'),'The First Family family joyfully wishes you a Happy Birthday! You are a precious gift to both your family and the First Family family. We assure you of our prayers and wish you good health and God’s abundant blessings always.');
 assert.deepEqual(localCalendar(new Date('2026-10-13T19:00:00Z'),'Asia/Kolkata'),{year:2026,monthDay:'10-14',date:'2026-10-14'});
 const template=wishTemplate({event:'Birthday',name:'A < B',recipient:'Person',logo:null});assert.ok(template.text.startsWith('Dear Person,\n\n'));assert.ok(template.html.includes('A &lt; B'));assert.ok(!template.html.includes('<img'));
});
function annualFixture(){
 const {db,rows}=fixture(),jobs=[];let calls=[];
 function matches(row,where){return Object.entries(where).every(([key,value])=>value && typeof value==='object' && !(value instanceof Date)?(value.lt!==undefined?row[key]<value.lt:false):row[key]===value);}
 db.annualWish={create:async({data})=>{if(jobs.some(j=>j.person_identity===data.person_identity && j.event===data.event && j.year===data.year))throw Object.assign(Error('duplicate'),{code:'P2002'});const row={id:randomUUID(),status:'Processing',attempts:1,smtp_started_at:null,created_at:new Date(),...data};jobs.push(row);return {...row};},findFirst:async({where})=>{const row=jobs.find(j=>matches(j,where));return row?{...row}:null;},update:async({where,data})=>{const j=jobs.find(j=>j.id===where.id);for(const [k,v]of Object.entries(data))if(v!==undefined)j[k]=v;return {...j};},updateMany:async({where,data})=>{let count=0;for(const j of jobs)if(matches(j,where)){count++;for(const[k,v]of Object.entries(data))j[k]=v?.increment?j[k]+v.increment:v;}return {count};}};
 const service=new AnnualWishService({db,now:()=>new Date('2026-10-14T06:00:00Z'),timezone:'Asia/Kolkata',send:async opts=>{calls.push(opts);return {accepted:[opts.to]};},download:async()=>Buffer.from('logo')});
 return {db,rows,jobs,calls,service};
}
test('actual dates and congregation boundaries, both events on same day, no ineligible ordination and concurrent annual deduplication',async()=>{
 const {service,calls,jobs}=annualFixture();await Promise.all([service.run(),service.run()]);assert.equal(calls.length,3);assert.equal(jobs.length,3);assert.equal(jobs.filter(j=>j.status==='Sent').length,3);
 assert.ok(calls.filter(c=>c.to==='bob@example.test').every(c=>c.text.includes('Second Family') && !c.text.includes('First Family')));
 assert.equal(calls.filter(c=>c.to==='alice@example.test').length,2);await service.run();assert.equal(calls.length,3);
 const scoped=annualFixture();await scoped.service.run(['P1']);assert.equal(scoped.calls.length,2);
});
test('uncertain SMTP failure never reports sent and remains deduplicated on restart',async()=>{
 const f=annualFixture();f.service.send=async()=>{throw Object.assign(Error('timeout'),{command:'DATA'});};await f.service.run();assert.ok(f.jobs.every(j=>j.status==='Unknown'));await f.service.run();assert.equal(f.jobs.length,3);assert.ok(f.jobs.every(j=>j.attempts===1));
});

test('Scholastic and Curia accounts link actual records and congregation without inventing category mappings',async()=>{
 const scholastic=fixture();scholastic.rows.scholastics_dtl.push({scholastic_code:'S1',province_code:'P1',first_name:'Student',personal_mailid1:'student@example.test',is_active:true});
 const service=new MemberAccessService({db:scholastic.db});await service.provision(scope,{kind:'Scholastic',code:'S1',province_code:'P1'});assert.equal((await service.active('student@example.test')).person_kind,'Scholastic');
 const curia=fixture();curia.rows.curia_advisors_dtl.push({confrer_code:'F1',province_code:'P1',personal_mailid1:'alice@example.test'});
 const offices=new MemberAccessService({db:curia.db});await offices.provision(scope,{kind:'Curia',code:'F1',province_code:'P1'});assert.equal((await offices.active('alice@example.test')).person_kind,'Confrere');
 curia.rows.confreres_dtl[0].is_active=false;await assert.rejects(offices.active('alice@example.test'),e=>e.status===403);
});
test('member password setup uses hashed scoped single-use codes, throttling and mocked email only',async()=>{
 const {db,users}=fixture();let token,sent;
 db.memberPasswordToken={findUnique:async()=>token,upsert:async({create,update})=>{token=token?{...token,...update}:{...create};return token;},updateMany:async({where})=>{if(token && token.user_id===where.user_id && token.token_hash===where.token_hash && token.attempts<5 && token.expires_at>new Date()){token.attempts++;return {count:1};}return {count:0};},deleteMany:async({where})=>{if(token?.token_hash===where.token_hash){token=null;return {count:1};}return {count:0};}};
 const service=new MemberAccessService({db,send:async options=>{sent=options;}});await service.provision(scope,{kind:'Confrere',code:'F1',province_code:'P1'});
 await service.requestPassword('alice@example.test');const otp=sent.text.match(/\b\d{6}\b/)[0];assert.equal(sent.to,'alice@example.test');assert.notEqual(token.token_hash,otp);assert.equal(token.token_hash.length,64);
 await assert.rejects(service.requestPassword('alice@example.test'),e=>e.status===429);
 await assert.rejects(service.resetPassword('alice@example.test',otp,'short'));
 await service.resetPassword('alice@example.test',otp,'a-private-long-password');assert.equal(token,null);assert.equal(await bcrypt.compare('a-private-long-password',users[0].password),true);
 await assert.rejects(service.resetPassword('alice@example.test',otp,'a-private-long-password'));
});
test('tenant logo is attached only for its own recipients and missing logos have clean text fallback',async()=>{
 const {createHash}=await import('node:crypto');const f=annualFixture();const buffer=Buffer.from('logo');f.rows.congregationBranding.push({concretion_code:'C1',logo_key:'first-private-logo',mime_type:'image/png',sha256:createHash('sha256').update(buffer).digest('hex')});let downloaded;
 f.service.download=async key=>{downloaded=key;return buffer;};await f.service.run();assert.equal(downloaded,'first-private-logo');
 for(const mail of f.calls){if(mail.to==='alice@example.test'){assert.equal(mail.attachments[0].cid,'congregation-logo');assert.ok(mail.html.includes('cid:congregation-logo'));}else{assert.equal(mail.attachments.length,0);assert.ok(!mail.html.includes('cid:congregation-logo'));}}
});

test('annual deduplication survives province changes and still permits the next year',async()=>{
 const f=annualFixture();await f.service.run();f.rows.confreres_dtl[0].province_code='P2';await f.service.run();assert.equal(f.calls.length,3);
 f.service.now=()=>new Date('2027-10-14T06:00:00Z');await f.service.run();assert.equal(f.calls.length,6);
});

test('a recovered reservation fences out the original stalled worker before SMTP',async()=>{
 const {createHash}=await import('node:crypto');const f=annualFixture();const buffer=Buffer.from('logo');f.rows.congregationBranding.push({concretion_code:'C1',logo_key:'logo',mime_type:'image/png',sha256:createHash('sha256').update(buffer).digest('hex')});
 let release,entered,downloads=0;const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 f.service.download=async()=>{downloads++;if(downloads===1){entered();await gate;}return buffer;};
 const original=f.service.run();await waiting;f.jobs[0].created_at=new Date('2026-10-14T05:00:00Z');
 await f.service.run();release();await original;assert.equal(f.calls.length,3);assert.equal(f.jobs.filter(j=>j.status==='Sent').length,3);
});

test('the existing single anniversary schedule uses application timezone and cannot send in development by default',async()=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../src/middlewares/anniversaryJob.js',import.meta.url),'utf8');
 const original=process.env.ANNIVERSARY_EMAILS_ENABLED;const originalTimezone=process.env.APP_TIMEZONE;
 try{
  process.env.APP_TIMEZONE='Asia/Kolkata';
  for(const [environment,flag,enabled] of [['development',undefined,false],['production',undefined,true],['production','false',false],['development','true',true]]){
   if(flag===undefined)delete process.env.ANNIVERSARY_EMAILS_ENABLED;else process.env.ANNIVERSARY_EMAILS_ENABLED=flag;
   const key='schedule_'+randomUUID().replaceAll('-','');let sends=0;const registrations=[];
   globalThis[key]={cron:{schedule:(expression,callback,options)=>{registrations.push({expression,callback,options});return {stop(){}};}},run:async()=>{sends++;}};
   let code=source.replace("import {NODE_ENV} from '../config/index.js';",`const NODE_ENV=${JSON.stringify(environment)};`).replace("import cron from 'node-cron';",`const cron=globalThis.${key}.cron;`).replace("import {sendTodayAnniversaries} from '../controllers/Msfs/anniversarynotification.js';",`const sendTodayAnniversaries=globalThis.${key}.run;`).replace("import {logger} from '../utils/logger.js';",'const logger={error(){}};');
   try{await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')+'#'+key);assert.equal(registrations.length,1);assert.equal(registrations[0].expression,'0 0 * * *');assert.equal(registrations[0].options.timezone,'Asia/Kolkata');assert.equal(registrations[0].options.scheduled,enabled);if(enabled)await registrations[0].callback();assert.equal(sends,enabled?1:0);}finally{delete globalThis[key];}
  }
 }finally{if(original===undefined)delete process.env.ANNIVERSARY_EMAILS_ENABLED;else process.env.ANNIVERSARY_EMAILS_ENABLED=original;if(originalTimezone===undefined)delete process.env.APP_TIMEZONE;else process.env.APP_TIMEZONE=originalTimezone;}
});
