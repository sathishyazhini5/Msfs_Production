import {assertCongregationAccess} from './congregationAccess.js';
import {initializeMember} from './memberInitialization.js';
import {randomBytes,randomInt,createHash,timingSafeEqual} from 'node:crypto';
import bcrypt from 'bcrypt';
export const MEMBER_ROLE='estatus member';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const normalizeEmail=value=>String(value || '').trim().toLowerCase();
const digest=value=>createHash('sha256').update(value).digest('hex');
export class MemberAccessService {
 constructor({db,send}){this.db=db;this.send=send;}
 async credentialIdentity(email) {
  const accounts=await this.db.users_mst.findMany({where:{user_id:{equals:normalizeEmail(email),mode:'insensitive'}}});
  if(accounts.length!==1 || accounts[0].role_name!==MEMBER_ROLE || accounts[0].role_code!=='MEMBER')throw fail('Member account is unavailable.',403);
  return accounts[0].user_id;
 }
 async directory(scope,search='') {
  if(!['super admin','congregation admin','province admin'].includes(scope.role))throw fail('Member provisioning requires an authorized administrator.',403);
  const provinces=await this.db.province_mst.findMany({where:scope.provinceCodes===null?{}:{province_code:{in:scope.provinceCodes}}});
  const where={province_code:{in:provinces.map(p=>p.province_code)}};
  const [confreres,scholastics,curia]=await Promise.all([this.db.confreres_dtl.findMany({where:{...where,is_active:true}}),this.db.scholastics_dtl.findMany({where:{...where,is_active:true}}),this.db.curia_advisors_dtl.findMany({where})]);
  const activeConfreres=await this.db.confreres_dtl.findMany({where:{is_active:true},select:{confrer_code:true,first_name:true,middle_name:true,last_name:true}});
  const names=new Map(activeConfreres.map(c=>[c.confrer_code,[c.first_name,c.middle_name,c.last_name].filter(Boolean).join(' ')]));
  const rows=[...confreres.map(r=>({...r,kind:'Confrere',code:r.confrer_code})),...scholastics.map(r=>({...r,kind:'Scholastic',code:r.scholastic_code})),...curia.filter(r=>activeConfreres.some(c=>c.confrer_code===r.confrer_code)).map(r=>({...r,kind:'Curia',code:r.confrer_code}))];
  const needle=String(search).trim().toLowerCase();
  return rows.map(r=>({kind:r.kind,code:r.code,province_code:r.province_code,concretion_code:provinces.find(p=>p.province_code===r.province_code)?.concretion_code,email:normalizeEmail(r.personal_mailid1),name:[r.first_name,r.middle_name,r.last_name].filter(Boolean).join(' ') || names.get(r.code) || r.code})).filter(r=>r.concretion_code && (!needle || [r.name,r.email,r.code].some(v=>v.toLowerCase().includes(needle))));
 }
 async provision(scope,input,options) {
  try{return await initializeMember(this,scope,input,options);}catch(error){if(error.code==='P2002')return {status:'conflict',reason:'concurrent_account_or_link'};throw error;}
 }
 async changeInitialPassword(user_id,currentPassword,password){
  if(typeof password!=='string'||password.length<12||password.length>128)throw fail('Use a password between 12 and 128 characters.');
  await this.active(user_id);
  const [account,access]=await Promise.all([this.db.users_mst.findUnique({where:{user_id}}),this.db.memberAccess.findUnique({where:{user_id}})]);
  if(!access.password_change_required)throw fail('Initial password has already been changed.');
  if(!account || !await bcrypt.compare(String(currentPassword || ''),account.password))throw fail('Current password is incorrect.',401);
  if(await bcrypt.compare(password,account.password))throw fail('Choose a new password different from the temporary password.');
  const hash=await bcrypt.hash(password,12);
  await this.db.$transaction(async tx=>{
   const changed=await tx.users_mst.updateMany({where:{user_id,password:account.password,role_code:'MEMBER'},data:{password:hash,updated_date:new Date()}});
   if(changed.count!==1)throw fail('Password changed concurrently. Sign in again.',409);
   await tx.memberAccess.update({where:{user_id},data:{password_change_required:false,password_changed_at:new Date(),welcome_status:access.welcome_status==='Sent'?'Sent':'Cancelled'}});
   await tx.memberPasswordToken.deleteMany({where:{user_id}});
  });
 }
 async active(user_id) {
  await assertCongregationAccess(this.db,{user_id});
  const access=await this.db.memberAccess.findUnique({where:{user_id},select:{user_id:true,person_kind:true,person_code:true,province_code:true,concretion_code:true,enabled:true,password_change_required:true,password_changed_at:true}});
  if(!access?.enabled)throw fail('Member access is disabled.',403);
  const model=access.person_kind==='Scholastic'?'scholastics_dtl':access.person_kind==='Curia'?'curia_advisors_dtl':'confreres_dtl';
  const key=access.person_kind==='Scholastic'?'scholastic_code':'confrer_code';
  const row=await this.db[model].findFirst({where:{[key]:access.person_code,province_code:access.province_code,...(access.person_kind==='Curia'?{}:{is_active:true})}});
  if(access.person_kind==='Curia' && !await this.db.confreres_dtl.findFirst({where:{confrer_code:access.person_code,is_active:true}}))throw fail('Linked member is inactive.',403);
  const province=await this.db.province_mst.findUnique({where:{province_code:access.province_code}});
  if(!row || normalizeEmail(row.personal_mailid1)!==normalizeEmail(user_id) || province?.concretion_code!==access.concretion_code)throw fail('Member identity changed. Contact your administrator.',403);
  return access;
 }
 async requestResetLink(user_id) {
  user_id=await this.credentialIdentity(user_id);await this.active(user_id);
  const prior=await this.db.memberPasswordToken.findUnique({where:{user_id}});
  if(prior && Date.now()-new Date(prior.created_at).getTime()<60000)return;
  const token=randomBytes(32).toString('hex');
  const data={token_hash:digest(user_id+':'+token),expires_at:new Date(Date.now()+600000),attempts:0,created_at:new Date()};
  await this.db.memberPasswordToken.upsert({where:{user_id},create:{user_id,...data},update:data});
  const url=new URL('/reset-password',process.env.MEMBER_LOGIN_URL || 'https://msfs.adminpro.co.in/login');
  url.searchParams.set('email',user_id);url.searchParams.set('token',token);
  await this.send({to:user_id,subject:'Reset your E-Status password',text:`Reset your password: ${url.toString()}\nThis single-use link expires in 10 minutes. If you did not request this, ignore this email.`});
 }
 async requestPassword(user_id) {
  user_id=await this.credentialIdentity(user_id);await this.active(user_id);
  const prior=await this.db.memberPasswordToken.findUnique({where:{user_id}});
  if(prior && Date.now()-new Date(prior.created_at).getTime()<60000)throw fail('Wait one minute before requesting another code.',429);
  const otp=String(randomInt(100000,1000000));
  const data={token_hash:digest(user_id+':'+otp),expires_at:new Date(Date.now()+600000),attempts:0,created_at:new Date()};
  await this.db.memberPasswordToken.upsert({where:{user_id},create:{user_id,...data},update:data});
  await this.send({to:user_id,subject:'E-Status password setup',text:`Your E-Status verification code is ${otp}. It expires in 10 minutes. Do not share this code.`});
 }
 async resetPassword(user_id,otp,password) {
  user_id=await this.credentialIdentity(user_id);
  if(typeof password!=='string' || password.length<12 || password.length>128)throw fail('Use a password between 12 and 128 characters.');
  await this.active(user_id);
  const token=await this.db.memberPasswordToken.findUnique({where:{user_id}});
  if(!token || token.attempts>=5 || new Date(token.expires_at)<=new Date())throw fail('Verification code is invalid or expired.');
  const count=await this.db.memberPasswordToken.updateMany({where:{user_id,token_hash:token.token_hash,attempts:{lt:5},expires_at:{gt:new Date()}},data:{attempts:{increment:1}}});
  if(!count.count || !timingSafeEqual(Buffer.from(token.token_hash),Buffer.from(digest(user_id+':'+String(otp)))))throw fail('Verification code is invalid or expired.');
  const hash=await bcrypt.hash(password,12);
  await this.db.$transaction(async tx=>{
   const used=await tx.memberPasswordToken.deleteMany({where:{user_id,token_hash:token.token_hash,expires_at:{gt:new Date()}}});
   if(!used.count)throw fail('Verification code has already been used.');
   await tx.users_mst.update({where:{user_id},data:{password:hash,updated_date:new Date()}});
   await tx.memberAccess.update({where:{user_id},data:{password_change_required:false,password_changed_at:new Date(),welcome_status:'Cancelled'}});
  });
 }
}
