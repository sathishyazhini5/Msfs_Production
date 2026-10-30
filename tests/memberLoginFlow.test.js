import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { database, response, matches, loadController } from './helpers/controllerHarness.js';
import { MemberAccessService } from '../src/services/memberAccessService.js';
import { provisionCreatedMember } from '../src/services/memberCreationHook.js';
import { createMemberGuard } from '../src/middlewares/memberGuard.js';
import { memberRecordProjection } from '../src/utils/memberRecordPolicy.js';

function fixture() {
  const rows = {
    users_mst: [], memberAccess: [], memberPasswordToken: [],
    province_mst: [{province_code:'P1',concretion_code:'C1'}, {province_code:'P2',concretion_code:'C2'}],
    concretion_defination_mst: [{concretion_code:'C1',status:'Active'}],
    confreres_dtl: [
      {confrer_code:'F1',province_code:'P1',first_name:'Confrere',personal_mailid1:'confrere@example.test',is_active:true},
      {confrer_code:'F2',province_code:'P1',first_name:'Office',personal_mailid1:'',is_active:true},
    ],
    scholastics_dtl: [{scholastic_code:'S1',province_code:'P1',first_name:'Scholastic',personal_mailid1:'scholastic@example.test',is_active:true}],
    curia_advisors_dtl: [{confrer_code:'F2',province_code:'P1',personal_mailid1:'curia@example.test'}],
  };
  const db=database(rows);
  for (const model of ['users_mst','memberAccess']) {
    db[model].updateMany=async({where,data})=>{const found=rows[model].filter(row=>matches(row,where));found.forEach(row=>Object.assign(row,data));return {count:found.length};};
  }
  const create=db.memberAccess.create;
  db.memberAccess.create=({data})=>create({data:{enabled:true,password_changed_at:null,...data}});
  let token;
  db.memberPasswordToken={
    findUnique:async()=>token,
    upsert:async({create,update})=>{token=token?{...token,...update}:{...create};return token;},
    updateMany:async({where})=>{if(token?.user_id===where.user_id&&token.token_hash===where.token_hash&&token.attempts<5&&token.expires_at>new Date()){token.attempts++;return {count:1};}return {count:0};},
    deleteMany:async({where})=>{if(token?.user_id===where.user_id&&token.token_hash===where.token_hash){token=undefined;return {count:1};}return {count:0};},
  };
  return {db,rows};
}

test('each real member type provisions once, signs in directly, resets via private single-use link and preserves reset hash on rerun',async()=>{
  const {db,rows}=fixture();
  const {login}=await loadController('../../src/controllers/auth/userlogin.js',db);
  const sent=[];
  const service=new MemberAccessService({db,send:async mail=>sent.push(mail)});
  const identities=[['Confrere',rows.confreres_dtl[0]],['Scholastic',rows.scholastics_dtl[0]],['Curia',rows.curia_advisors_dtl[0]]];
  for (const [kind,person] of identities) {
    assert.equal((await provisionCreatedMember(db,kind,person)).status,'created');
    assert.equal((await provisionCreatedMember(db,kind,person)).reason,'already_initialized');
    const email=person.personal_mailid1;
    const signIn=async password=>{const res=response();let error;await login({body:{user_id:email.toUpperCase(),password}},res,e=>{error=e;});return {res,error};};
    const initial=await signIn('pass123');assert.equal(initial.error,undefined);assert.equal(initial.res.body.redirect,'/estatus');assert.equal(initial.res.body.data.person_kind,kind);
    let permitted=false;const req={method:'GET',path:'/estatus/confrere/filters'};
    await createMemberGuard(db)(req,response(initial.res.body.data),()=>{permitted=true;});assert.equal(permitted,true);assert.deepEqual(req.memberProvinceCodes,['P1']);
    for (const [method,path] of [['GET','/platform/dashboard'],['GET','/getusers'],['POST','/saveConfrere']]) {
      const denied=response(initial.res.body.data);await createMemberGuard(db)({method,path},denied,()=>assert.fail());assert.equal(denied.statusCode,403);
    }
    await service.requestResetLink(email);
    const mail=sent.at(-1);assert.equal(mail.to,email);assert.equal(mail.cc,undefined);
    const link=new URL(mail.text.match(/https:\/\/\S+/)[0]);const token=link.searchParams.get('token');assert.equal(token.length,64);assert.equal(link.searchParams.get('email'),email);
    const password='new-private-member-password';await service.resetPassword(email,token,password);
    await assert.rejects(service.resetPassword(email,token,password));
    const stale=response(initial.res.body.data);await createMemberGuard(db)({method:'GET',path:'/estatus/confrere'},stale,()=>assert.fail());assert.equal(stale.statusCode,401);
    assert.equal((await signIn('pass123')).error.status,401);assert.equal((await signIn(password)).error,undefined);
    const hash=rows.users_mst.find(row=>row.user_id===email).password;
    await provisionCreatedMember(db,kind,person);assert.equal(rows.users_mst.find(row=>row.user_id===email).password,hash);assert.equal(await bcrypt.compare(password,hash),true);
  }
  assert.equal(rows.users_mst.length,3);assert.equal(sent.length,3);
});

test('member profile projection removes credentials, evaluations, emergency, medical and unknown fields recursively',()=>{
  const projected=memberRecordProjection({name:'Member',password:'secret',password_hash:'hash',blood_group_name:'medical',emergency_contact_no:'private',feedbacks:[{remarks:'private'}],current_designation:[{designation_name:'Rector',password:'hash',remarks:'private'}]});
  assert.deepEqual(projected,{name:'Member',current_designation:[{designation_name:'Rector'}]});
});

test('public Forgot Password keeps unknown/member responses generic and the existing Reset Password endpoint consumes member links',async()=>{
  const {db,rows}=fixture();await provisionCreatedMember(db,'Confrere',rows.confreres_dtl[0]);
  let mail;
  const controller=await loadController('../../src/controllers/Admin/admin.js',db,{send:async options=>{mail=options;}});
  const known=response(),unknown=response();
  await controller.forgotPassword({body:{user_id:'confrere@example.test'}},known);
  await controller.forgotPassword({body:{user_id:'unknown@example.test'}},unknown);
  assert.equal(known.statusCode,200);assert.deepEqual(known.body,unknown.body);
  const link=new URL(mail.text.match(/https:\/\/\S+/)[0]);
  const reset=response();await controller.resetPassword({body:{user_id:link.searchParams.get('email'),token:link.searchParams.get('token'),newPassword:'new-private-controller-password'}},reset);
  assert.equal(reset.statusCode,200);assert.equal(await bcrypt.compare('new-private-controller-password',rows.users_mst[0].password),true);
});

test('all three existing administrator login mappings and hashes remain unchanged',async()=>{
  const {db,rows}=fixture();
  rows.concretion_defination_mst.push({concretion_code:'conc001',status:'Active'});
  const quickcodes=[];db.quickcode_mst={findFirst:async({where})=>quickcodes.find(row=>row.quick_code===where.quick_code)};
  const {login}=await loadController('../../src/controllers/auth/userlogin.js',db);
  for (const [role,code,owner] of [['Super Admin','RN001','ALL'],['Province Admin','RN003','P1'],['Congregation Admin','RN002','conc001']]) {
    const password=await bcrypt.hash('existing-private-admin-password',10),user_id=`${code}@example.test`;
    rows.users_mst.push({user_id,password,role_code:code,role_name:role,prov_concre_code:owner,user_role_com_activity_mst:[]});
    quickcodes.push({quick_code:code,quickcode_name:role});
    const res=response();let error;await login({body:{user_id,password:'existing-private-admin-password'}},res,e=>{error=e;});
    assert.equal(error,undefined);assert.equal(res.body.data.role_name,role);assert.equal(res.body.data.password,undefined);assert.equal(rows.users_mst.at(-1).password,password);
  }
});
