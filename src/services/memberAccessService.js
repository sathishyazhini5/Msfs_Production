import {randomBytes,randomInt,createHash,timingSafeEqual} from 'node:crypto';
import bcrypt from 'bcrypt';
export const MEMBER_ROLE='estatus member';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const normalizeEmail=value=>String(value || '').trim().toLowerCase();
const digest=value=>createHash('sha256').update(value).digest('hex');
export class MemberAccessService {
 constructor({db,send}){this.db=db;this.send=send;}
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
 async provision(scope,input) {
  const candidates=(await this.directory(scope)).filter(r=>r.kind===input.kind && r.code===input.code && r.province_code===input.province_code);
  if(candidates.length>1)throw fail('Multiple records match this identity. Correct the records before provisioning.',409);
  const row=candidates[0];
  if(!row)throw fail('Member not found in your authorized scope.',404);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) || row.email.length>100)throw fail('The member needs a valid email of at most 100 characters.');
  // Check the complete directory: shared addresses across tenants must not become account identities.
  const all=await this.directory({role:'super admin',provinceCodes:null});
  const identities=new Set(all.filter(r=>r.email===row.email).map(r=>`${r.kind==='Curia'?'Confrere':r.kind}:${r.code}:${r.kind==='Scholastic'?r.province_code+':':''}${r.concretion_code}`));
  if(identities.size!==1)throw fail('This email belongs to multiple identities. Correct the records before provisioning.',409);
  const existing=await this.db.users_mst.findMany({where:{user_id:{equals:row.email,mode:'insensitive'}}});
  if(existing.length)throw fail('An account already uses this email. Its role and identity were not changed.',409);
  const password=await bcrypt.hash(randomBytes(48).toString('hex'),12);
  try {await this.db.$transaction(async tx=>{
   await tx.users_mst.create({data:{user_id:row.email,user_type_code:'MEMBER',prov_concre_code:row.concretion_code,first_name:row.name.slice(0,100),password,role_code:'MEMBER',role_name:MEMBER_ROLE,created_by:scope.user.user_id,created_date:new Date()}});
   await tx.memberAccess.create({data:{user_id:row.email,person_kind:row.kind,person_code:row.code,province_code:row.province_code,concretion_code:row.concretion_code,created_by:scope.user.user_id}});
  });}catch(error){if(error.code==='P2002')throw fail('Account or member access already exists; nothing was overwritten.',409);throw error;}
  return {email:row.email,message:'Access provisioned. The member can use Forgot Password to securely set their password. No invitation was sent.'};
 }
 async active(user_id) {
  const access=await this.db.memberAccess.findUnique({where:{user_id}});
  if(!access?.enabled)throw fail('Member access is disabled.',403);
  const model=access.person_kind==='Scholastic'?'scholastics_dtl':access.person_kind==='Curia'?'curia_advisors_dtl':'confreres_dtl';
  const key=access.person_kind==='Scholastic'?'scholastic_code':'confrer_code';
  const row=await this.db[model].findFirst({where:{[key]:access.person_code,province_code:access.province_code,...(access.person_kind==='Curia'?{}:{is_active:true})}});
  if(access.person_kind==='Curia' && !await this.db.confreres_dtl.findFirst({where:{confrer_code:access.person_code,is_active:true}}))throw fail('Linked member is inactive.',403);
  const province=await this.db.province_mst.findUnique({where:{province_code:access.province_code}});
  if(!row || normalizeEmail(row.personal_mailid1)!==user_id || province?.concretion_code!==access.concretion_code)throw fail('Member identity changed. Contact your administrator.',403);
  return access;
 }
 async requestPassword(user_id) {
  user_id=normalizeEmail(user_id);await this.active(user_id);
  const prior=await this.db.memberPasswordToken.findUnique({where:{user_id}});
  if(prior && Date.now()-new Date(prior.created_at).getTime()<60000)throw fail('Wait one minute before requesting another code.',429);
  const otp=String(randomInt(100000,1000000));
  const data={token_hash:digest(user_id+':'+otp),expires_at:new Date(Date.now()+600000),attempts:0,created_at:new Date()};
  await this.db.memberPasswordToken.upsert({where:{user_id},create:{user_id,...data},update:data});
  await this.send({to:user_id,subject:'E-Status password setup',text:`Your E-Status verification code is ${otp}. It expires in 10 minutes. Do not share this code.`});
 }
 async resetPassword(user_id,otp,password) {
  user_id=normalizeEmail(user_id);
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
   await tx.users_mst.update({where:{user_id},data:{password:hash}});
  });
 }
}
