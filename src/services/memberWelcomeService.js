import bcrypt from 'bcrypt';
import {MemberAccessService} from './memberAccessService.js';
import {createHash} from 'node:crypto';
import {failurePolicy} from './circularQueue.js';
import {INITIAL_MEMBER_PASSWORD} from './memberInitialization.js';
import {withExploreMore} from './emailFooter.js';
const escape=value=>String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function memberWelcomeTemplate({email,name,congregation,logo,loginUrl=process.env.MEMBER_LOGIN_URL || 'https://msfs.adminpro.co.in/login'}){
 const text=`Dear ${name || 'Member'},\n\nYour ${congregation} E-Status account is ready.\nLogin email: ${email}\nInitial password: ${INITIAL_MEMBER_PASSWORD}\nLog in: ${loginUrl}\nYou can reset your password using Forgot Password on the login page. Your account provides read-only E-Status directory access.`;
 return withExploreMore({subject:`${congregation} — E-Status account`,text,html:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0d274c"><div style="padding:24px;background:#081a32;color:white">${logo?'<img src="cid:congregation-logo" alt="Congregation logo" style="max-width:160px;max-height:70px;object-fit:contain"/>':''}<h2>${escape(congregation)}</h2></div><div style="padding:24px"><p>Dear ${escape(name || 'Member')},</p><p>Your read-only E-Status account is ready.</p><p>Login email: ${escape(email)}<br>Initial password: ${INITIAL_MEMBER_PASSWORD}</p><p>You can reset your password using Forgot Password on the login page.</p><a href="${escape(loginUrl)}" style="display:inline-block;background:#0874d8;color:white;padding:12px 24px;text-decoration:none">Log In to E-Status</a></div></div>`});
}
export class MemberWelcomeService{
 constructor({db,send,download}){Object.assign(this,{db,send,download});}
 async deliver(user_id){
  const row=await this.db.memberAccess.findUnique({where:{user_id}});
  if(!row || !row.enabled || !row.password_initialized_at || row.password_changed_at || !['Pending','Retryable'].includes(row.welcome_status))return {status:'not_pending'};
  const claimed=await this.db.memberAccess.updateMany({where:{user_id,welcome_status:row.welcome_status,welcome_attempts:row.welcome_attempts},data:{welcome_status:'Sending',welcome_attempts:{increment:1},welcome_started_at:null}});
  if(!claimed.count)return {status:'already_claimed'};
  const attempt=row.welcome_attempts+1;let started=false;
  try{
   const [account,congregation,branding]=await Promise.all([this.db.users_mst.findUnique({where:{user_id}}),this.db.concretion_defination_mst.findUnique({where:{concretion_code:row.concretion_code}}),this.db.congregationBranding.findUnique({where:{concretion_code:row.concretion_code}})]);
   if(!account || !congregation)throw new Error('Account branding unavailable.');
   await new MemberAccessService({db:this.db}).active(user_id);
   if(!await bcrypt.compare(INITIAL_MEMBER_PASSWORD,account.password)){await this.db.memberAccess.updateMany({where:{user_id,welcome_status:'Sending',welcome_attempts:attempt},data:{welcome_status:'Cancelled'}});return {status:'superseded'};}
   let logo;
   if(branding?.logo_key && this.download){try{const buffer=await this.download(branding.logo_key);if(createHash('sha256').update(buffer).digest('hex')===branding.sha256)logo={buffer,mime_type:branding.mime_type};}catch{/* Text branding remains usable. */}}
   const fence=await this.db.memberAccess.updateMany({where:{user_id,welcome_status:'Sending',welcome_attempts:attempt,password_changed_at:null},data:{welcome_started_at:new Date()}});
   if(!fence.count)return {status:'superseded'};
   started=true;
   const info=await this.send({to:user_id,...memberWelcomeTemplate({email:user_id,name:account.first_name,congregation:congregation.concretion_name || 'Congregation',logo}),messageId:`<member-welcome-${createHash('sha256').update(user_id).digest('hex')}@adminpro>`,attachments:logo?[{filename:'congregation-logo.png',content:logo.buffer,contentType:logo.mime_type,cid:'congregation-logo'}]:[]});
   if(!info?.accepted?.some(email=>String(email).toLowerCase()===user_id.toLowerCase()))throw new Error('SMTP acceptance not verified.');
   await this.db.memberAccess.updateMany({where:{user_id,welcome_status:'Sending',welcome_attempts:attempt},data:{welcome_status:'Sent',welcome_sent_at:new Date(),welcome_error:null}});
   return {status:'sent'};
  }catch(error){
   const policy=failurePolicy(error,attempt,started);
   await this.db.memberAccess.updateMany({where:{user_id,welcome_status:'Sending',welcome_attempts:attempt},data:{welcome_status:policy.retry?'Retryable':policy.safe?'Failed':'Unknown',welcome_error:policy.message}});
   return {status:policy.retry?'retryable':policy.safe?'failed':'unknown'};
  }
 }
 async recover(){
  // Reclaim only known pre-SMTP crashes; unknown SMTP outcomes require reconciliation.
  await this.db.memberAccess.updateMany({where:{welcome_status:'Sending',welcome_started_at:null},data:{welcome_status:'Retryable'}});
  await this.db.memberAccess.updateMany({where:{welcome_status:'Sending',welcome_started_at:{lt:new Date(Date.now()-900000)}},data:{welcome_status:'Unknown',welcome_error:'SMTP outcome requires reconciliation.'}});
 }
}
