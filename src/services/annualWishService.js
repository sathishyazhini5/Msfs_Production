import {createHash} from 'node:crypto';
import {failurePolicy} from './circularQueue.js';
const escape=value=>String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function localCalendar(now=new Date(),timezone=process.env.APP_TIMEZONE || 'Asia/Kolkata') {
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 return {year:Number(parts.year),monthDay:parts.month+'-'+parts.day,date:parts.year+'-'+parts.month+'-'+parts.day};
}
export const wishBody=(event,name)=>event==='Ordination'
 ? `The ${name} family joyfully wishes you a blessed Ordination Anniversary! May God grant you good health, abundant grace, and continued blessings in your priestly ministry. Be assured of our prayers and support always.`
 : `The ${name} family joyfully wishes you a Happy Birthday! You are a precious gift to both your family and the ${name} family. We assure you of our prayers and wish you good health and God\u2019s abundant blessings always.`;
export function wishTemplate({event,name,recipient,logo}) {
 const body=wishBody(event,name),subject=event==='Ordination'?'Blessed Ordination Anniversary!':'Happy Birthday!';
 const greeting=`Dear ${recipient || 'Member'},`;
 return {subject,text:greeting+'\n\n'+body,html:`<div style="background:#f3f7fc;padding:24px;font-family:Arial,sans-serif"><div style="max-width:600px;margin:auto;background:white;border-radius:14px;overflow:hidden"><div style="background:#1976d2;color:white;padding:24px">${logo?'<img src="cid:congregation-logo" alt="'+escape(name)+' logo" style="max-height:64px;max-width:160px;background:white;padding:8px;border-radius:8px"/>':''}<h2 style="margin-bottom:0">${escape(name)}</h2></div><div style="padding:28px;line-height:1.8;color:#26334b"><p>${escape(greeting)}</p><p>${escape(body)}</p></div></div></div>`};
}
export class AnnualWishService {
 constructor({db,send,download,now=()=>new Date(),timezone,log=console}){Object.assign(this,{db,send,download,now,timezone,log});}
 async recipients(provinceCodes=null) {
  const day=localCalendar(this.now(),this.timezone);
  const [people,scholastics,provinces,congregations]=await Promise.all([
   this.db.confreres_dtl.findMany({where:{is_active:true}}),this.db.scholastics_dtl.findMany({where:{is_active:true}}),this.db.province_mst.findMany(),this.db.concretion_defination_mst.findMany()]);
  const rows=[];
  for(const [kind,list,key] of [['Confrere',people,'confrer_code'],['Scholastic',scholastics,'scholastic_code']])for(const p of list){
   const province=provinces.find(x=>x.province_code===p.province_code),congregation=congregations.find(x=>x.concretion_code===province?.concretion_code);
   if((provinceCodes && !provinceCodes.includes(p.province_code)) || !congregation || !p.personal_mailid1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.personal_mailid1.trim()))continue;
   for(const [event,field] of [['Birthday','birth_date'],['Ordination','ordination_date']]){
    if(!p[field])continue;
    // Business dates are PostgreSQL timestamp-without-timezone calendar dates.
    const date=new Date(p[field]).toISOString().slice(0,10);
    if(date.slice(5)!==day.monthDay || date>day.date || (event==='Ordination' && Number(date.slice(0,4))>=day.year))continue;
    rows.push({person_kind:kind,person_code:p[key],province_code:p.province_code,concretion_code:congregation.concretion_code,event,year:day.year,email:p.personal_mailid1.trim().toLowerCase(),name:congregation.concretion_name?.trim() || congregation.concretion_code,recipient:[p.first_name,p.middle_name,p.last_name].filter(Boolean).join(' ')});
   }
  }
  return rows;
 }
 async run(provinceCodes=null) {
  // A pre-SMTP crash can be retried; a post-SMTP crash stays quarantined to avoid duplicates.
  await this.db.annualWish.updateMany({where:{...(provinceCodes?{province_code:{in:provinceCodes}}:{}),status:'Processing',smtp_started_at:null,created_at:{lt:new Date(this.now().getTime()-300000)}},data:{status:'Retryable'}});
  const results={matching:0,sent:0,skipped:0,failed:0};
  for(const r of await this.recipients(provinceCodes)){
   results.matching++;
   const identity={person_identity:JSON.stringify([r.person_kind,r.person_code,r.person_kind==='Scholastic'?r.province_code:null]),concretion_code:r.concretion_code,person_kind:r.person_kind,person_code:r.person_code,province_code:r.province_code,event:r.event,year:r.year};
   let job;
   try{job=await this.db.annualWish.create({data:identity});}catch(error){
    if(error.code!=='P2002')throw error;
    const found=await this.db.annualWish.findFirst({where:{person_identity:identity.person_identity,event:r.event,year:r.year}});
    if(!found || found.concretion_code!==r.concretion_code || found.province_code!==r.province_code){results.skipped++;continue;}
    const attempt=found.attempts+1;
    const claimed=await this.db.annualWish.updateMany({where:{id:found.id,status:'Retryable',attempts:{lt:3}},data:{status:'Processing',attempts:{increment:1},created_at:this.now()}});
    if(!claimed.count){results.skipped++;continue;}job={...found,attempts:attempt};
   }
   let started=false;
   try {
    const branding=await this.db.congregationBranding.findUnique({where:{concretion_code:r.concretion_code}});
    let logo;
    if(branding?.logo_key){try{const buffer=await this.download(branding.logo_key);if(createHash('sha256').update(buffer).digest('hex')===branding.sha256)logo={buffer,mime_type:branding.mime_type};}catch{this.log.warn('Congregation wish logo unavailable; using text branding.');}}
    const template=wishTemplate({...r,logo});
    const reservation=await this.db.annualWish.updateMany({where:{id:job.id,status:'Processing',attempts:job.attempts,smtp_started_at:null},data:{smtp_started_at:this.now()}});
    if(!reservation.count){results.skipped++;continue;}started=true;
    const info=await this.send({to:r.email,...template,messageId:`<annual-wish-${job.id}@estatus>`,attachments:logo?[{filename:'congregation-logo.png',content:logo.buffer,contentType:logo.mime_type,cid:'congregation-logo'}]:[]});
    if(!info?.accepted?.some(email=>String(email).toLowerCase()===r.email))throw Error('SMTP acceptance not verified.');
    await this.db.annualWish.updateMany({where:{id:job.id,status:'Processing',attempts:job.attempts},data:{status:'Sent',sent_at:this.now(),last_error:null}});results.sent++;
   }catch(error){
    const policy=failurePolicy(error,job.attempts,started);
    await this.db.annualWish.updateMany({where:{id:job.id,status:'Processing',attempts:job.attempts},data:{status:policy.retry?'Retryable':policy.safe?'Failed':'Unknown',smtp_started_at:policy.safe?null:undefined,last_error:policy.message}});results.failed++;
   }
  }
  return results;
 }
}
