import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {provinceScopeWhere} from '../utils/dataScope.js';
import {recipientCentreSnapshots,matchesRecipient,recipientCounts,validateHistoryFilters,circularReport} from './circularReporting.js';
import {circularTemplate} from './circularTemplate.js';

export const CATEGORIES = ['Confrere', 'Scholastics', 'Curia'];
export const CIRCULAR_TYPES = ['Circular','Newsletter','Others'];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTEMPTS = 3;
export const fault = (message,status=400) => Object.assign(new Error(message),{status});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nameOf = row => [row.first_name,row.middle_name,row.last_name].map(v=>String(v || '').trim()).filter(Boolean).join(' ');
export const normalizeEmail = value => String(value || '').trim().toLowerCase();
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value) && !value.split('@')[0].startsWith('.') && !value.split('@')[0].endsWith('.') && !value.split('@')[0].includes('..');
export function actor(scope) {
  const id = scope.user?.user_id || scope.user?.sub || scope.user?.username;
  if (!id || typeof id !== 'string') throw fault('Your session is missing a sender identity. Please sign in again.',403);
  return id;
}
export function filtersOf(input={}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('Invalid recipient filters.');
  const province=input.province || 'ALL', search=input.search || '';
  const categories=input.categories?.length ? input.categories : CATEGORIES;
  if (typeof province !== 'string' || province.length>10 || typeof search !== 'string' || search.length>100 || !Array.isArray(categories) || categories.some(c=>!CATEGORIES.includes(c))) throw fault('Invalid recipient filters.');
  const provinces=input.provinces;
  if(provinces!==undefined && (!Array.isArray(provinces)||provinces.length>500||provinces.some(p=>typeof p!=='string'||!p||p==='ALL'||p.length>10)||new Set(provinces).size!==provinces.length))throw fault('Invalid province selection.');
  return {province,...(provinces!==undefined?{provinces}:{}),search:search.trim(),categories:CATEGORIES.filter(c=>categories.includes(c))};
}
export function selectionOf(input={}) {
  const filters=filtersOf(input.filters);
  if (!['individual','all'].includes(input.mode)) throw fault('Choose individual recipients or all matching recipients.');
  const keys=input.mode==='all' ? input.excludedKeys || [] : input.keys || [];
  if (!Array.isArray(keys) || keys.length>10000 || keys.some(k=>typeof k!=='string' || k.length>1000) || new Set(keys).size!==keys.length) throw fault('Invalid recipient selection.');
  return {filters,mode:input.mode,...(input.mode==='all'?{excludedKeys:keys}:{keys})};
}
export function summarizeRecipients(rows) {
  const missing=rows.filter(r=>!r.email).length, invalid=rows.filter(r=>r.email && !validEmail(r.email)).length;
  const groups=new Map();
  for(const row of rows) if(validEmail(row.email)) {
    const prior=groups.get(row.email);
    if(prior) prior.sources.push(row);
    else groups.set(row.email,{email:row.email,name:row.name,sources:[row]});
  }
  return {counts:{selected:rows.length,eligible:groups.size,missing,invalid,invalidTotal:missing+invalid,duplicates:rows.length-missing-invalid-groups.size},recipients:[...groups.values()]};
}
export function selectRecipients(rows,selection) {
  const ids=new Set(selection.mode==='all'?selection.excludedKeys:selection.keys);
  const available=new Set(rows.map(row=>row.key));
  if(selection.mode==='individual' && [...ids].some(id=>!available.has(id))) throw fault('Some recipients are no longer available in the selected scope. Clear the selection and choose again.');
  const selected=rows.filter(row=>selection.mode==='all'?!ids.has(row.key):ids.has(row.key));
  if(selected.length>10000) throw fault('A circular supports up to 10,000 selected recipient records. Refine your filters.');
  return {selected,...summarizeRecipients(selected)};
}
export function validateAttachment(file) {
  if(!file?.buffer?.length) throw fault('Choose a circular attachment.');
  if(file.buffer.length>MAX_ATTACHMENT_BYTES) throw fault('Attachments must be 10 MB or smaller.',413);
  const filename=path.basename(file.originalname || 'attachment').replace(/[^\p{L}\p{N} ._-]/gu,'_').slice(-180);
  const extension=path.extname(filename).toLowerCase(), b=file.buffer;
  const types={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  let matches=extension==='.pdf'?b.subarray(0,5).toString()==='%PDF-':extension==='.png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):['.jpg','.jpeg'].includes(extension)?b[0]===255 && b[1]===216 && b[2]===255:false;
  if(extension==='.docx' && b[0]===80 && b[1]===75) {
    try {
      const end=b.lastIndexOf(Buffer.from([80,75,5,6]));
      if(end<0 || end+22>b.length)throw new Error('Invalid archive.');
      let offset=b.readUInt32LE(end+16), total=0;const names=new Set(), count=b.readUInt16LE(end+10);
      if(count>10000)throw new Error('Too many archive entries.');
      for(let i=0;i<count;i++){
        if(offset+46>b.length || b.readUInt32LE(offset)!==0x02014b50)throw new Error('Invalid archive directory.');
        const len=b.readUInt16LE(offset+28);total+=b.readUInt32LE(offset+24);
        if(total>50*1024*1024 || offset+46+len>b.length)throw new Error('Expanded document is too large.');
        names.add(b.subarray(offset+46,offset+46+len).toString());
        offset+=46+len+b.readUInt16LE(offset+30)+b.readUInt16LE(offset+32);
      }
      matches=names.has('word/document.xml') && names.has('[Content_Types].xml') && !names.has('word/vbaProject.bin');
    } catch {matches=false;}
  }
  if(!types[extension] || !matches || (file.mimetype && file.mimetype!==types[extension] && file.mimetype!=='application/octet-stream')) throw fault('Upload a genuine PDF, DOCX, PNG or JPEG attachment.');
  return {filename,mime_type:types[extension],size:b.length,sha256:createHash('sha256').update(b).digest('hex')};
}
const publicAttachment = a => a && ({id:a.id,filename:a.filename,mime_type:a.mime_type,size:a.size});
const publicCircular = row => ({...row,attachment:publicAttachment(row.attachment)});
export const canAccess = (scope,row) => scope.provinceCodes===null || (row.province_codes.length>0 && row.province_codes.every(code=>scope.provinceCodes.includes(code)));
const pageOf=input=>{const page=Number(input.page || 1),pageSize=Number(input.pageSize || 25);if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fault('Invalid pagination.');return {page,pageSize};};

export class CircularService {
  constructor({db,storage,branding=null,mailReady=()=>false,workerEnabled=()=>false}) {this.db=db;this.storage=storage;this.branding=branding;this.mailReady=mailReady;this.workerEnabled=workerEnabled;}
  async provinces(scope) {return this.db.province_mst.findMany({where:{AND:[provinceScopeWhere(scope.provinceCodes),{province_code:{not:'ALL'}}]},select:{province_code:true,province_name:true,concretion_code:true},orderBy:{province_name:'asc'}});}
  async metadata(scope) {
    actor(scope);const provinces=await this.provinces(scope),masters=await this.db.apostolates_mst?.findMany({where:provinceScopeWhere(provinces.map(p=>p.province_code))}) || [];
    return {role:scope.role,provinces,categories:CATEGORIES,circularTypes:CIRCULAR_TYPES,centreTypes:[...new Map(masters.filter(m=>m.centre_type_code).map(m=>[m.centre_type_code,{value:m.centre_type_code,label:m.centre_type_name || m.centre_type_code}])).values()],branding:this.branding?await this.branding.public(scope):{name:'MSFS eStatus'},maxAttachmentBytes:MAX_ATTACHMENT_BYTES,allowedFileTypes:['.pdf','.docx','.png','.jpg','.jpeg'],sendConfigured:this.mailReady() && this.workerEnabled()};
  }
  async loadRecipients(scope,input) {
    const filters=filtersOf(input), provinces=await this.provinces(scope);
    if(filters.province!=='ALL' && !provinces.some(p=>p.province_code===filters.province)) throw fault('Province is outside your authorized scope.',403);
    if(filters.provinces!==undefined && scope.role!=='congregation admin')throw fault('Multi-province selection is available only to Congregation Admin.',403);
    if(filters.provinces?.some(code=>!provinces.some(p=>p.province_code===code)))throw fault('Province is outside your authorized congregation.',403);
    const codes=filters.provinces!==undefined?filters.provinces:filters.province==='ALL'?provinces.map(p=>p.province_code):[filters.province];
    const where=provinceScopeWhere(codes), selected=filters.categories;
    const [confreres,scholastics,curia]=await Promise.all([
      selected.includes('Confrere')?this.db.confreres_dtl.findMany({where:{...where,is_active:true},select:{confrer_code:true,province_code:true,first_name:true,middle_name:true,last_name:true,personal_mailid1:true}}):[],
      selected.includes('Scholastics')?this.db.scholastics_dtl.findMany({where:{...where,is_active:true},select:{scholastic_code:true,province_code:true,first_name:true,middle_name:true,last_name:true,personal_mailid1:true}}):[],
      selected.includes('Curia')?this.db.curia_advisors_dtl.findMany({where,select:{curia_code:true,confrer_code:true,province_code:true,division_type_code:true,division_code:true,personal_mailid1:true}}):[]
    ]);
    const linked=curia.length?await this.db.confreres_dtl.findMany({where:{confrer_code:{in:[...new Set(curia.map(c=>c.confrer_code))]},is_active:true},select:{confrer_code:true,first_name:true,middle_name:true,last_name:true,personal_mailid1:true}}):[];
    const personMap=new Map(linked.map(p=>[p.confrer_code,p]));
    const centresFor=await recipientCentreSnapshots(this.db,codes,[...new Set([...confreres,...curia].map(c=>c.confrer_code))],scholastics.map(s=>s.scholastic_code));
    const make=(row,category,keys,person=row)=>{
      const email=normalizeEmail(row.personal_mailid1 || person.personal_mailid1);
      return {key:JSON.stringify([category,...keys.map(k=>row[k])]),name:nameOf(person),category,province_code:row.province_code,province:provinces.find(p=>p.province_code===row.province_code)?.province_name || row.province_code,snapshotVersion:2,centres:centresFor(category,row.province_code,row.confrer_code || row.scholastic_code),email,emailStatus:!email?'Missing':validEmail(email)?'Valid':'Invalid'};
    };
    const rows=[...confreres.map(r=>make(r,'Confrere',['confrer_code','province_code'])),...scholastics.map(r=>make(r,'Scholastics',['scholastic_code','province_code'])),...curia.filter(r=>personMap.has(r.confrer_code)).map(r=>make(r,'Curia',['curia_code','confrer_code','province_code','division_type_code','division_code'],personMap.get(r.confrer_code)))];
    const needle=filters.search.toLowerCase();
    return {filters,codes,rows:rows.filter(r=>!needle || [r.name,r.email,r.category,r.province].some(v=>v.toLowerCase().includes(needle))).sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key))};
  }
  async recipients(scope,input) {
    actor(scope);const selection=selectionOf(input.selection || {filters:input,mode:'individual',keys:[]});
    const loaded=await this.loadRecipients(scope,selection.filters), {page,pageSize}=pageOf(input);
    const picked=selectRecipients(loaded.rows,selection);
    return {records:loaded.rows.slice((page-1)*pageSize,page*pageSize),matching:loaded.rows.length,page,pageSize,counts:picked.counts,matchingCounts:summarizeRecipients(loaded.rows).counts};
  }
  async upload(scope,file) {
    const owner_id=actor(scope), data=validateAttachment(file), province_codes=(await this.provinces(scope)).map(p=>p.province_code);
    if(!province_codes.length) throw fault('No authorized provinces are available.',403);
    const blob_key=await this.storage.upload(file.buffer,data.filename,data.mime_type);
    try {return publicAttachment(await this.db.circularAttachment.create({data:{id:randomUUID(),owner_id,province_codes,blob_key,...data}}));}
    catch(e){await this.storage.remove(blob_key).catch(()=>{});throw e;}
  }
  async get(scope,id) {
    actor(scope);if(!uuid(id))throw fault('Invalid circular identifier.');
    const row=await this.db.circular.findUnique({where:{id},include:{attachment:true}});
    if(!row || !canAccess(scope,row) || (row.status==='Draft' && row.sender_id!==actor(scope)))throw fault('Circular not found in your authorized scope.',404);
    return row;
  }
  async attachment(scope,id) {
    if(!uuid(id))throw fault('Invalid attachment identifier.');
    const row=await this.db.circularAttachment.findUnique({where:{id},include:{circular:true}});
    if(!row || !(row.circular?canAccess(scope,row.circular) && (row.circular.status!=='Draft' || row.circular.sender_id===actor(scope)):row.owner_id===actor(scope) && canAccess(scope,row)))throw fault('Attachment not found in your authorized scope.',404);
    return {metadata:row,buffer:await this.storage.download(row.blob_key)};
  }
  async removeAttachment(scope,id) {
    if(!uuid(id))throw fault('Invalid attachment identifier.');
    return this.db.$transaction(async tx=>{
      // The row lock also blocks a concurrent draft from linking a file being deleted.
      await tx.$queryRaw`SELECT "id" FROM "CircularAttachment" WHERE "id"=${id}::uuid FOR UPDATE`;
      const row=await tx.circularAttachment.findUnique({where:{id},include:{circular:true}});
      if(!row || row.owner_id!==actor(scope) || !canAccess(scope,row))throw fault('Attachment not found.',404);
      if(row.circular)throw fault('Remove the attachment from the saved draft before deleting it.',409);
      await this.storage.remove(row.blob_key);await tx.circularAttachment.delete({where:{id}});return {removed:true};
    },{timeout:120000});
  }
  async save(scope,input,id) {
    const sender_id=actor(scope);
    const circular_type=input.circularType ?? input.circular_type ?? 'Circular',signature=input.signature ?? '';
    if(!CIRCULAR_TYPES.includes(circular_type)||typeof signature!=='string'||signature.length>2000)throw fault('Choose a valid Circular Type and a signature up to 2,000 characters.');
    if(typeof input.subject!=='string' || input.subject.length>200 || /[\r\n]/.test(input.subject) || typeof input.message!=='string' || input.message.length>20000)throw fault('Use a subject up to 200 characters and a message up to 20,000 characters.');
    const selection=selectionOf(input.selection), loaded=await this.loadRecipients(scope,selection.filters), picked=selectRecipients(loaded.rows,selection);
    const draftCodes=loaded.codes.length?loaded.codes:(await this.provinces(scope)).map(p=>p.province_code);
    if(!draftCodes.length)throw fault('No authorized provinces are available.',403);
    const attachment_id=input.attachmentId || null;
    if(attachment_id) {
      if(!uuid(attachment_id))throw fault('Invalid attachment.');
      const attachment=await this.db.circularAttachment.findUnique({where:{id:attachment_id},include:{circular:true}});
      if(!attachment || attachment.owner_id!==sender_id || !canAccess(scope,attachment) || (attachment.circular && attachment.circular.id!==id))throw fault('Choose an attachment belonging to this draft and sender.',403);
    }
    const data={subject:input.subject.trim(),message:input.message.trim(),circular_type,signature:signature.trim(),selection,selection_summary:picked.counts,province_codes:picked.selected.length?[...new Set(picked.selected.map(r=>r.province_code))]:draftCodes,attachment_id};
    if(!id)return publicCircular(await this.db.circular.create({data:{id:randomUUID(),sender_id,sender_role:scope.role,...data},include:{attachment:true}}));
    if(!Number.isInteger(input.version) || input.version<1)throw fault('A valid draft version is required.');
    const prior=await this.get(scope,id);if(prior.sender_id!==sender_id)throw fault('Only the sender can edit this draft.',403);
    const updated=await this.db.circular.updateMany({where:{id,status:'Draft',version:input.version},data:{...data,version:{increment:1}}});
    if(updated.count!==1)throw fault('This draft changed or was already queued. Reload it before editing.',409);
    return publicCircular(await this.get(scope,id));
  }
  async review(scope,id) {
    const row=await this.get(scope,id);
    if(row.sender_id!==actor(scope) || row.status!=='Draft')throw fault('Only your unsent drafts can be reviewed.',409);
    if(!row.subject.trim() || !row.message.trim() || !row.attachment)throw fault('Subject, message and circular attachment are required.');
    const loaded=await this.loadRecipients(scope,row.selection.filters), picked=selectRecipients(loaded.rows,row.selection);
    if(!picked.recipients.length)throw fault('Select at least one recipient with a valid email.');
    const contentSnapshot={subject:row.subject,message:row.message,circular_type:row.circular_type || 'Circular',signature:row.signature || '',branding:this.branding?await this.branding.snapshot(scope):{name:'MSFS eStatus'}};
    const reviewToken=createHash('sha256').update(JSON.stringify([row.version,contentSnapshot,row.attachment.sha256,picked.counts,picked.recipients])).digest('hex');
    const previewBranding=this.branding?await this.branding.public(scope):contentSnapshot.branding;
    const preview=circularTemplate(contentSnapshot);preview.html=preview.html.replace('cid:congregation-logo',previewBranding.logoDataUrl || '');
    return {circular:publicCircular(row),counts:picked.counts,recipients:picked.recipients,reviewToken,version:row.version,contentSnapshot,emailPreview:preview};
  }
  async queue(scope,id,input) {
    const row=await this.get(scope,id), sender=actor(scope);
    if(row.sender_id!==sender)throw fault('Only the sender can send this circular.',403);
    if(typeof input.idempotencyKey!=='string' || !/^[a-z0-9-]{8,100}$/i.test(input.idempotencyKey))throw fault('A valid submission key is required.');
    const submission_key=`${id}:${input.idempotencyKey}`;
    if(row.status!=='Draft') {if(row.submission_key===submission_key)return publicCircular(row);throw fault('This circular has already been submitted.',409);}
    if(!this.mailReady() || !this.workerEnabled())throw fault('Sending is not configured. Configure Gmail and enable the circular worker first.',503);
    const review=await this.review(scope,id);
    if(input.version!==review.version || input.reviewToken!==review.reviewToken)throw fault('The draft or recipient list changed. Review the circular again.',409);
    return this.db.$transaction(async tx=>{
      const changed=await tx.circular.updateMany({where:{id,status:'Draft',version:review.version},data:{status:'Queued',content_snapshot:review.contentSnapshot,submission_key,queued_at:new Date(),version:{increment:1},recipient_count:review.recipients.length,selection_summary:review.counts,province_codes:[...new Set(review.recipients.flatMap(r=>r.sources.map(s=>s.province_code)))]}});
      if(!changed.count) {
        const existing=await tx.circular.findUnique({where:{id},include:{attachment:true}});
        if(existing.submission_key===submission_key)return publicCircular(existing);
        throw fault('This circular changed or was already submitted.',409);
      }
      await tx.circularRecipient.createMany({data:review.recipients.map(recipient=>({id:randomUUID(),circular_id:id,email:recipient.email,snapshot:recipient}))});
      return publicCircular(await tx.circular.findUnique({where:{id},include:{attachment:true}}));
    });
  }
  async detail(scope,id,input={}) {validateHistoryFilters(input);const row=await this.get(scope,id);const all=await this.db.circularRecipient.findMany({where:{circular_id:id},orderBy:{email:'asc'}});const recipients=input.province||input.centreType?all.filter(r=>matchesRecipient(r,input)):all;return {...publicCircular(row),recipients,matchingCounts:recipientCounts(recipients),totalCounts:recipientCounts(all)};}
  async list(scope,input) {
    actor(scope);const {page,pageSize}=pageOf(input), statuses=['Draft','Queued','Processing','Sent','Failed','Partial Success'];
    validateHistoryFilters(input);
    if(input.province && !(await this.provinces(scope)).some(p=>p.province_code===input.province))throw fault('Province is outside your authorized scope.',403);
    if(input.status && !statuses.includes(input.status))throw fault('Invalid circular status.');
    if(input.search && (typeof input.search!=='string'||input.search.length>100))throw fault('Search must be at most 100 characters.');
    for(const key of ['from','to'])if(input[key] && (typeof input[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input[key]) || !Number.isFinite(Date.parse(input[key])) || new Date(input[key]).toISOString().slice(0,10)!==input[key]))throw fault('Invalid history date.');
    if(input.from && input.to && input.from>input.to)throw fault('Start date must precede end date.');
    const where={status:input.tab==='drafts'?'Draft':input.status || {not:'Draft'},...(input.circularType?{circular_type:input.circularType}:{}),...(input.search?{subject:{contains:input.search,mode:'insensitive'}}:{}),...(input.from||input.to?{created_at:{...(input.from?{gte:new Date(`${input.from}T00:00:00+05:30`)}:{}),...(input.to?{lt:new Date(new Date(`${input.to}T00:00:00+05:30`).getTime()+86400000)}:{})}}:{})};
    if(input.tab==='drafts')where.sender_id=actor(scope);
    if(scope.provinceCodes!==null)where.province_codes={hasSome:scope.provinceCodes};
    let rows=(await this.db.circular.findMany({where,include:{attachment:true},orderBy:[{[input.sort || 'created_at']:input.direction || 'desc'},{id:'asc'}]})).filter(row=>canAccess(scope,row) && (row.status!=='Draft' || row.sender_id===actor(scope)));
    const recipients=rows.length?await this.db.circularRecipient.findMany({where:{circular_id:{in:rows.map(r=>r.id)}},orderBy:{email:'asc'}}):[];
    const historicalTypes=[...new Map(recipients.flatMap(r=>r.snapshot?.sources || []).flatMap(s=>s.centres || []).filter(c=>c.centre_type_code).map(c=>[c.centre_type_code,{value:c.centre_type_code,label:c.centre_type_name || c.centre_type_code}])).values()];
    rows=rows.map(row=>{const all=recipients.filter(r=>r.circular_id===row.id),matching=input.province||input.centreType?all.filter(r=>matchesRecipient(r,input)):all;return {...publicCircular(row),matchingCounts:recipientCounts(matching),totalCounts:recipientCounts(all)};}).filter(row=>!(input.province||input.centreType)||row.matchingCounts.total>0);
    if(input.exportAll)return circularReport(rows,recipients,input,this.branding?await this.branding.public(scope):{name:'MSFS eStatus'});
    return {records:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,historicalCentreTypes:historicalTypes};
  }
  async retry(scope,id) {
    const row=await this.get(scope,id);
    if(!this.mailReady() || !this.workerEnabled())throw fault('Sending is not configured.',503);
    if(!['Failed','Partial Success'].includes(row.status))throw fault('Only completed circulars with failed recipients can be retried.',409);
    return this.db.$transaction(async tx=>{
      const locked=await tx.circular.updateMany({where:{id,status:row.status,version:row.version},data:{status:'Queued',finished_at:null,version:{increment:1}}});
      if(!locked.count)throw fault('This circular is already being processed.',409);
      const changed=await tx.circularRecipient.updateMany({where:{circular_id:id,status:'Failed',retryable:true,attempts:{lt:MAX_ATTEMPTS}},data:{status:'Queued',next_attempt_at:new Date(),last_error:null,smtp_started_at:null,lease_token:null,lease_until:null}});
      if(!changed.count)throw fault('No safely retryable failures remain within the retry limit. Unknown SMTP outcomes need reconciliation.',409);
      await tx.circular.update({where:{id},data:{failed_count:{decrement:changed.count}}});
      return {queued:changed.count};
    });
  }
}
