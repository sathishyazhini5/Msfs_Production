import {randomUUID,createHash} from 'node:crypto';
import {MAX_ATTEMPTS} from './circularService.js';
import {circularTemplate} from './circularTemplate.js';

export function failurePolicy(error,attempts,started) {
  const code=Number(error.responseCode);
  const beforeData=['CONN','AUTH','EHLO','HELO','MAIL FROM','RCPT TO'].includes(error.command);
  const definiteRejection=code>=400 && code<600;
  const safe=!started || beforeData || definiteRejection;
  const temporary=!code || code<500;
  return {safe,retry:safe && temporary && attempts<MAX_ATTEMPTS,
    message:safe?`Mail submission failed${code?` (SMTP ${code})`:''}.`: 'UNKNOWN_OUTCOME: SMTP acceptance could not be verified. Reconcile with the mail provider before resending.'};
}
export class CircularQueue {
  constructor({db,send,download,concurrency=3}) {this.db=db;this.send=send;this.download=download;this.concurrency=Math.max(1,Math.min(5,Number(concurrency)||3));}
  async recover() {
    await this.db.$executeRaw`
      UPDATE "CircularRecipient" SET "status"=CASE WHEN "smtp_started_at" IS NULL THEN 'Queued' ELSE 'Failed' END,
      "retryable"=("smtp_started_at" IS NULL),
      "attempts"=CASE WHEN "smtp_started_at" IS NULL THEN GREATEST("attempts"-1,0) ELSE "attempts" END,
      "last_error"=CASE WHEN "smtp_started_at" IS NULL THEN NULL ELSE 'UNKNOWN_OUTCOME: Worker stopped during SMTP submission. Reconcile with the provider before resending.' END,
      "lease_token"=NULL,"lease_until"=NULL
      WHERE "status"='Processing' AND "lease_until"<NOW()`;
  }
  async claim() {
    const token=randomUUID();
    const rows=await this.db.$queryRaw`
      UPDATE "CircularRecipient" r SET "status"='Processing',"attempts"=r."attempts"+1,
      "lease_token"=${token}::uuid,"lease_until"=NOW()+INTERVAL '5 minutes',"smtp_started_at"=NULL
      FROM (SELECT x."id" FROM "CircularRecipient" x JOIN "Circular" c ON c."id"=x."circular_id"
        WHERE x."status"='Queued' AND x."attempts"<${MAX_ATTEMPTS} AND x."next_attempt_at"<=NOW()
          AND c."status" IN ('Queued','Processing')
        ORDER BY x."next_attempt_at",x."id" FOR UPDATE OF x SKIP LOCKED LIMIT 1) job
      WHERE r."id"=job."id" RETURNING r.*`;
    return rows[0] || null;
  }
  async refresh() {
    await this.db.$executeRaw`
      WITH counts AS (SELECT "circular_id",COUNT(*)::int total,
        COUNT(*) FILTER (WHERE "status"='Sent')::int sent,
        COUNT(*) FILTER (WHERE "status"='Failed')::int failed,
        COUNT(*) FILTER (WHERE "status"='Processing')::int processing,
        COUNT(*) FILTER (WHERE "status"='Queued')::int queued FROM "CircularRecipient" GROUP BY "circular_id")
      UPDATE "Circular" c SET "recipient_count"=n.total,"sent_count"=n.sent,"failed_count"=n.failed,
        "status"=CASE WHEN n.processing>0 OR (n.queued>0 AND n.sent+n.failed>0) THEN 'Processing'
          WHEN n.queued>0 THEN 'Queued' WHEN n.sent=n.total THEN 'Sent'
          WHEN n.sent>0 THEN 'Partial Success' ELSE 'Failed' END,
        "finished_at"=CASE WHEN n.processing+n.queued=0 THEN COALESCE(c."finished_at",NOW()) ELSE NULL END,
        "updated_at"=NOW() FROM counts n WHERE c."id"=n."circular_id" AND c."status" IN ('Queued','Processing')`;
  }
  async deliver(row,cache) {
    const guard={id:row.id,status:'Processing',lease_token:row.lease_token};
    let started=false;
    const heartbeat=setInterval(()=>{this.db.circularRecipient.updateMany({where:guard,data:{lease_until:new Date(Date.now()+300000)}}).catch(()=>{});},30000);
    heartbeat.unref?.();
    try {
      const circular=await this.db.circular.findUnique({where:{id:row.circular_id},include:{attachment:true}});
      if(!circular?.attachment)throw new Error('Missing persisted attachment.');
      if(!cache.has(circular.attachment.id))cache.set(circular.attachment.id,this.download(circular.attachment.blob_key));
      const buffer=await cache.get(circular.attachment.id);
      if(createHash('sha256').update(buffer).digest('hex')!==circular.attachment.sha256)throw new Error('Attachment checksum mismatch.');
      const content=circular.content_snapshot || {subject:circular.subject,message:circular.message,signature:circular.signature || '',circular_type:circular.circular_type || 'Circular',branding:{name:'MSFS eStatus'}};
      const template=circularTemplate(content);let logo;
      if(content.branding?.logo_key){
        const key=content.branding.logo_key;
        if(!cache.has(key))cache.set(key,this.download(key));
        const image=await cache.get(key);
        if(createHash('sha256').update(image).digest('hex')!==content.branding.sha256)throw new Error('Branding checksum mismatch.');
        logo={buffer:image,mime_type:content.branding.mime_type};
      }
      const marked=await this.db.circularRecipient.updateMany({where:guard,data:{smtp_started_at:new Date()}});
      if(marked.count!==1)return;
      started=true;
      const info=await this.send({to:row.email,subject:content.subject,...template,logo,
        messageId:`<circular-${row.id}@estatus.msfs>`,attachment:{filename:circular.attachment.filename,mime_type:circular.attachment.mime_type,buffer}});
      const accepted=Array.isArray(info?.accepted) && info.accepted.some(email=>String(email).trim().toLowerCase()===row.email);
      if(!accepted) {
        const rejected=Array.isArray(info?.rejected) && info.rejected.some(email=>String(email).trim().toLowerCase()===row.email);
        throw Object.assign(new Error('Mail transport did not confirm acceptance.'),rejected?{responseCode:550}:{});
      }
      await this.db.circularRecipient.updateMany({where:guard,data:{status:'Sent',sent_at:new Date(),provider_message_id:info.messageId || null,last_error:null,lease_token:null,lease_until:null,retryable:false}});
    } catch(error) {
      const policy=failurePolicy(error,row.attempts,started);
      await this.db.circularRecipient.updateMany({where:guard,data:{status:policy.retry?'Queued':'Failed',retryable:policy.safe,
        next_attempt_at:new Date(Date.now()+Math.min(60000,5000*2**(row.attempts-1))),last_error:policy.message,lease_token:null,lease_until:null}});
    } finally {clearInterval(heartbeat);}
  }
  async runOnce() {
    await this.recover();await this.refresh();
    const cache=new Map();
    const results=await Promise.allSettled(Array.from({length:this.concurrency},async()=>{const row=await this.claim();if(row)await this.deliver(row,cache);return Boolean(row);}));
    await this.refresh();
    const error=results.find(r=>r.status==='rejected');if(error)throw error.reason;
    return results.filter(r=>r.value).length;
  }
}
