import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {CircularService} from '../src/services/circularService.js';
import {CircularQueue} from '../src/services/circularQueue.js';
import {BrandingService,validateLogo} from '../src/services/brandingService.js';
import {circularTemplate} from '../src/services/circularTemplate.js';
import {PlatformService} from '../src/services/platformService.js';
import {provinceMutationAllowed} from '../src/utils/tenantHierarchy.js';
import {parseDirectoryQuery,directorySql} from '../src/services/estatusService.js';
import {database,response} from './helpers/controllerHarness.js';
const scope={role:'congregation admin',provinceCodes:['P1','P2'],user:{user_id:'admin@test.invalid',concretion_code:'C1'}};
function png(){
  const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),data.length+8);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(){
  const tables={
    province_mst:[{province_code:'P1',province_name:'One',concretion_code:'C1'},{province_code:'P2',province_name:'Two',concretion_code:'C1'},{province_code:'P3',province_name:'Foreign',concretion_code:'C2'}],
    concretion_defination_mst:[{concretion_code:'C1',concretion_name:'First Congregation',status:'Active',created_date:new Date('2026-01-01')},{concretion_code:'C2',concretion_name:'Second Congregation',status:'Inactive',created_date:new Date('2026-01-02')},{concretion_code:'C3',concretion_name:'Legacy',status:null}],users_mst:[{user_id:'u1'},{user_id:'u2'}],
    congregationBranding:[],
    confreres_dtl:[{confrer_code:'F1',province_code:'P1',first_name:'One',personal_mailid1:'one@test.invalid',is_active:true},{confrer_code:'F2',province_code:'P2',first_name:'Two',personal_mailid1:'two@test.invalid',is_active:true},{confrer_code:'F3',province_code:'P3',first_name:'Foreign',personal_mailid1:'foreign@test.invalid',is_active:true}],
    scholastics_dtl:[{scholastic_code:'S1',province_code:'P2',first_name:'Scholar',personal_mailid1:'one@test.invalid',is_active:true}],
    curia_advisors_dtl:[{curia_code:'U1',confrer_code:'F2',province_code:'P2',division_type_code:'T',division_code:'D',personal_mailid1:'office@test.invalid'}],
    centre_dtl:[{province_code:'P1',division_type_code:'T',division_code:'D',centre_code:'CENT',centre_name:'School One',apostolate_code:'A',centre_type_code:'SCHOOL'},{province_code:'P2',division_type_code:'T',division_code:'D',centre_code:'CENT',centre_name:'House Two',apostolate_code:'B',centre_type_code:'HOUSE'}],
    apostolates_mst:[{province_code:'P1',apostolate_code:'A',centre_type_code:'SCHOOL',centre_type_name:'School'},{province_code:'P2',apostolate_code:'B',centre_type_code:'HOUSE',centre_type_name:'House'}],
    appoint_transfer_dtl:[{confrer_code:'F1',province_code:'P1',division_type_code:'T',division_code:'D',centre_code:'CENT',is_active:true},{confrer_code:'F2',province_code:'P2',division_type_code:'T',division_code:'D',centre_code:'CENT',is_active:true}],
    scholastics_admisn_promon_dtl:[{scholastic_code:'S1',province_code:'P2',division_type_code:'T',division_code:'D',centre_code:'CENT',end_date:null}],circular:[],circularRecipient:[],circularAttachment:[],
  };
  const db=database(tables),files=new Map();
  db.congregationBranding.upsert=async({where,create,update})=>{let row=tables.congregationBranding.find(r=>r.concretion_code===where.concretion_code);if(row)Object.assign(row,update);else tables.congregationBranding.push(row=create);return row;};
  db.circular.updateMany=async({where,data})=>{let count=0;for(const row of tables.circular)if(row.id===where.id&&(!where.status||row.status===where.status)&&(!where.version||row.version===where.version)){for(const [k,v]of Object.entries(data))row[k]=v?.increment?row[k]+v.increment:v;count++;}return {count};};
  db.circular.findUnique=async({where})=>{const row=tables.circular.find(c=>c.id===where.id);return row?{...row,attachment:tables.circularAttachment.find(a=>a.id===row.attachment_id)}:null;};
  db.circular.findMany=async()=>tables.circular.map(c=>({...c,attachment:tables.circularAttachment.find(a=>a.id===c.attachment_id)}));
  db.circular.create=async({data})=>{const row={status:'Draft',version:1,recipient_count:0,sent_count:0,failed_count:0,created_at:new Date(),...data};tables.circular.push(row);return {...row,attachment:tables.circularAttachment.find(a=>a.id===row.attachment_id)};};
  db.circularRecipient.createMany=async({data})=>{tables.circularRecipient.push(...data.map(r=>({status:'Queued',attempts:0,...r})));return {count:data.length};};
  const storage={upload:async b=>{const key=randomUUID();files.set(key,Buffer.from(b));return key;},download:async key=>files.get(key),remove:async key=>files.delete(key)};
  const branding=new BrandingService({db,storage}),service=new CircularService({db,storage,branding,mailReady:()=>true,workerEnabled:()=>true});
  return {tables,db,files,storage,branding,service};
}
test('multi-province recipients use tenant ownership, all-page selection and composite centre joins',async()=>{
  const {service}=fixture();const selection={mode:'all',excludedKeys:[],filters:{provinces:['P1','P2']}};
  const first=await service.recipients(scope,{selection,pageSize:1}),second=await service.recipients(scope,{selection,pageSize:1,page:2});
  assert.equal(first.matching,4);assert.equal(first.counts.eligible,3);assert.deepEqual(first.counts,second.counts);
  assert.equal((await service.loadRecipients(scope,selection.filters)).rows.find(r=>r.category==='Confrere'&&r.province_code==='P1').centres[0].centre_name,'School One');
  assert.equal((await service.loadRecipients(scope,{...selection.filters,categories:['Scholastics']})).rows[0].centres[0].centre_name,'House Two');
  await assert.rejects(service.loadRecipients(scope,{provinces:['P1','P3']}),e=>e.status===403);
  await assert.rejects(service.loadRecipients({...scope,role:'province admin',provinceCodes:['P1']},{provinces:['P1','P2']}),e=>e.status===403);
  assert.equal((await service.loadRecipients({...scope,role:'province admin',provinceCodes:['P1']},{province:'ALL'})).rows.length,1);
  const empty=await service.save(scope,{subject:'Draft with no recipients yet',message:'Text',circularType:'Newsletter',signature:'Office',selection:{mode:'individual',keys:[],filters:{provinces:[]}}});
  assert.equal(empty.circular_type,'Newsletter');assert.deepEqual(empty.province_codes,['P1','P2']);assert.equal(empty.selection_summary.eligible,0);
});
test('logo permissions, content validation and tenant-specific fallback prevent brand leakage',async()=>{
  const {branding,files}=fixture(),file={mimetype:'image/png',buffer:png()};
  assert.throws(()=>validateLogo({mimetype:'image/png',buffer:Buffer.from('<svg/>')}));
  const corrupt=png();corrupt[40]^=1;assert.throws(()=>validateLogo({mimetype:'image/png',buffer:corrupt}));
  assert.throws(()=>validateLogo({mimetype:'image/png',buffer:Buffer.alloc(2097153)}));
  await assert.rejects(branding.save({...scope,role:'province admin'},file),e=>e.status===403);
  const saved=await branding.save(scope,file);assert.match(saved.logoDataUrl,/^data:image\/png;base64,/);
  const first=await branding.snapshot(scope);await branding.save(scope,file);assert.ok(files.has(first.logo_key));
  const other=await branding.public({...scope,user:{...scope.user,concretion_code:'C2'},provinceCodes:['P3']});assert.equal(other.name,'Second Congregation');assert.equal(other.logoDataUrl,undefined);
  await branding.remove(scope);assert.equal((await branding.public(scope)).logoDataUrl,undefined);assert.ok(files.has(first.logo_key));
});
test('drafts, review validation, queue snapshots, branding replacements and history exports remain consistent',async()=>{
  const {service,branding,tables}=fixture();await branding.save(scope,{buffer:png(),mimetype:'image/png'});
  const attachment=await service.upload(scope,{originalname:'circular.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-mock only')});
  const input={subject:'Newsletter <test>',message:'First line\n<script>bad</script>',signature:'Office\nName & team',circularType:'Newsletter',attachmentId:attachment.id,selection:{mode:'all',excludedKeys:[],filters:{provinces:['P1','P2']}}};
  const draft=await service.save(scope,input);assert.equal(draft.circular_type,'Newsletter');assert.equal(draft.signature,input.signature);
  const review=await service.review(scope,draft.id);assert.ok(review.emailPreview.html.includes('&lt;script&gt;'));assert.ok(review.emailPreview.html.includes('data:image/png;base64,'));assert.equal(review.recipients.length,3);
  await branding.remove(scope);await assert.rejects(service.queue(scope,draft.id,{version:review.version,reviewToken:review.reviewToken,idempotencyKey:'test-queue-key'}),e=>e.status===409);
  const updated=await service.review(scope,draft.id);await service.queue(scope,draft.id,{version:updated.version,reviewToken:updated.reviewToken,idempotencyKey:'test-queue-key'});
  assert.equal(tables.circular[0].content_snapshot.circular_type,'Newsletter');assert.equal(tables.circular[0].content_snapshot.signature,input.signature);
  tables.centre_dtl[0].centre_type_code='CHANGED';
  const history=await service.list(scope,{centreType:'SCHOOL'});assert.equal(history.total,1);assert.equal(history.records[0].matchingCounts.total,1);assert.equal(history.records[0].recipient_count,3);
  const report=await service.list(scope,{centreType:'SCHOOL',exportAll:true,report:'recipients'});assert.equal(report.total,1);assert.equal(report.records[0].centreTypes,'School, House');assert.equal(report.branding.name,'First Congregation');
  // Legacy sources have no centre snapshot: they never acquire today's affiliations.
  tables.circularRecipient[0].snapshot.sources.forEach(s=>delete s.centres);tables.circularRecipient[0].snapshot.sources.forEach(s=>delete s.snapshotVersion);
  const legacy=await service.list(scope,{});assert.equal(legacy.records[0].totalCounts.unknownSnapshots,1);
  assert.equal((await service.list(scope,{centreType:'SCHOOL'})).total,0);
  tables.circularRecipient[0].snapshot.sources=[];
  const missing=await service.list(scope,{exportAll:true,report:'recipients'});assert.equal(missing.records.find(r=>r.email===tables.circularRecipient[0].email).snapshot,'Legacy / unknown centre snapshot');assert.equal(missing.summary.unknownSnapshots,1);
});
test('mocked worker sends immutable HTML/text/CID branding privately and supports old queued rows',async()=>{
  const logo=png(),attachment=Buffer.from('%PDF-test'),calls=[];
  const circular={subject:'Changed live title',message:'Changed live body',content_snapshot:{subject:'Frozen title',message:'Line 1\nLine 2',signature:'Frozen office',circular_type:'Others',branding:{name:'Frozen congregation',logo_key:'old-logo',mime_type:'image/png',sha256:createHash('sha256').update(logo).digest('hex')}},attachment:{id:'attachment',blob_key:'file',filename:'c.pdf',mime_type:'application/pdf',sha256:createHash('sha256').update(attachment).digest('hex')}};
  const outcomes=[];const db={circular:{findUnique:async()=>circular},circularRecipient:{updateMany:async({data})=>{outcomes.push(data);return {count:1};}}};
  const worker=new CircularQueue({db,download:async key=>key==='old-logo'?logo:attachment,send:async options=>{calls.push(options);return {accepted:[options.to]};}});
  await worker.deliver({id:randomUUID(),circular_id:randomUUID(),email:'one@test.invalid',attempts:1,lease_token:'lease'},new Map());
  assert.equal(calls[0].subject,'Frozen title');assert.ok(calls[0].html.includes('cid:congregation-logo'));assert.ok(calls[0].text.includes('Regards,\nFrozen office'));assert.equal(calls[0].cc,undefined);assert.equal(calls[0].bcc,undefined);assert.deepEqual(calls[0].logo.buffer,logo);assert.ok(outcomes.some(o=>o.status==='Sent'));
  circular.content_snapshot=null;await worker.deliver({id:randomUUID(),email:'two@test.invalid',attempts:1},new Map());assert.equal(calls[1].subject,'Changed live title');assert.equal(calls[1].logo,undefined);
});
test('failed-only retry keeps the original queued logo/name and never requeues successful recipients',async()=>{
  const {service,branding,tables,db,storage}=fixture();await branding.save(scope,{buffer:png(),mimetype:'image/png'});
  const attachment=await service.upload(scope,{originalname:'retry.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-mocked retry')});
  const draft=await service.save(scope,{subject:'Original',message:'Original message',signature:'Original office',attachmentId:attachment.id,selection:{mode:'all',excludedKeys:[],filters:{provinces:['P1','P2']}}});
  const review=await service.review(scope,draft.id);await service.queue(scope,draft.id,{version:review.version,reviewToken:review.reviewToken,idempotencyKey:'original-retry-key'});
  const frozen=structuredClone(tables.circular[0].content_snapshot);tables.concretion_defination_mst[0].concretion_name='Renamed';await branding.save(scope,{buffer:png(),mimetype:'image/png'});await branding.remove(scope);
  tables.circular[0].status='Partial Success';tables.circular[0].failed_count=1;
  for(const [i,r]of tables.circularRecipient.entries())Object.assign(r,{status:i===0?'Failed':'Sent',attempts:1,retryable:i===0});
  db.circularRecipient.updateMany=async({where,data})=>{let count=0;for(const r of tables.circularRecipient)if((!where.id||where.id===r.id)&&(!where.status||where.status===r.status)&&(!where.retryable||r.retryable)&&(!where.attempts||r.attempts<where.attempts.lt)){Object.assign(r,data);count++;}return {count};};
  assert.equal((await service.retry(scope,draft.id)).queued,1);assert.deepEqual(tables.circular[0].content_snapshot,frozen);assert.equal(tables.circularRecipient.filter(r=>r.status==='Sent').length,2);
  const failed=tables.circularRecipient[0];Object.assign(failed,{status:'Processing',lease_token:randomUUID()});const sent=[];
  const worker=new CircularQueue({db,download:storage.download,send:async options=>{sent.push(options);return {accepted:[options.to]};}});await worker.deliver(failed,new Map());
  assert.equal(sent.length,1);assert.ok(sent[0].html.includes('First Congregation'));assert.ok(!sent[0].html.includes('Renamed'));assert.deepEqual(sent[0].logo.buffer,png());
});
test('email template escapes every field and preserves line breaks without unsupported client styling',()=>{
  const result=circularTemplate({subject:'<Title>',message:'One\nTwo & three',signature:'<Office>',branding:{name:'<Congregation>'}});
  assert.ok(result.html.includes('&lt;Title&gt;'));assert.ok(result.html.includes('One<br>Two &amp; three'));assert.ok(result.html.includes('&lt;Office&gt;'));assert.ok(!result.html.includes('<script'));assert.ok(result.text.includes('One\nTwo & three'));
});
test('obituary date range is inclusive in Asia/Kolkata, with identical count/page/export predicates',()=>{
  const filters=parseDirectoryQuery('obituary',{from:'2026-10-01',to:'2026-10-02'}),sql=directorySql('obituary',filters,['P1']);
  const dates=sql.count.values.filter(v=>v instanceof Date).map(d=>d.toISOString());assert.deepEqual(dates,['2026-09-30T18:30:00.000Z','2026-10-02T18:30:00.000Z']);
  assert.ok(sql.count.sql.includes('death_date >=')&&sql.count.sql.includes('death_date <'));assert.ok(!sql.count.sql.includes('CURRENT_TIMESTAMP'));assert.ok(sql.rows.sql.includes('LIMIT'));
  const exported=directorySql('obituary',{...filters,exportAll:true},['P1']);assert.ok(!exported.rows.sql.includes('LIMIT'));assert.deepEqual(exported.count.values,sql.count.values);
  for(const input of [{from:'2026-10-02',to:'2026-10-01'},{from:'2026-02-30'},{death_date:'2026-10-01',from:'2026-10-01'}])assert.throws(()=>parseDirectoryQuery('obituary',input));
  assert.ok(directorySql('obituary',parseDirectoryQuery('obituary',{}),null).count.sql.includes('CURRENT_TIMESTAMP'));
  assert.equal(directorySql('obituary',parseDirectoryQuery('obituary',{to:'2026-10-02'}),null).count.values.filter(v=>v instanceof Date).length,1);
});
test('platform metrics and management enforce actual role and congregation ownership',async()=>{
  const {db}=fixture(),platform=new PlatformService(db);
  await assert.rejects(platform.dashboard(scope),e=>e.status===403);
  const result=await platform.dashboard({...scope,role:'super admin'},{pageSize:1,status:'Active'});assert.equal(result.metrics.congregations,3);assert.equal(result.metrics.provinces,3);assert.equal(result.metrics.users,2);assert.equal(result.metrics.active,1);assert.equal(result.metrics.inactive,1);assert.equal(result.metrics.otherStatus,1);assert.equal(result.total,1);
  await assert.rejects(platform.dashboard({...scope,role:'super admin'},{status:'Invented'}));
  const user={role_name:'Congregation Admin',concretion_code:'C1'};
  assert.equal(await provinceMutationAllowed({body:{concretion_code:'C2'},params:{}},response(user),db),false);
  assert.equal(await provinceMutationAllowed({body:{},params:{province_code:'P3'}},response(user),db),false);
  assert.equal(await provinceMutationAllowed({body:{},params:{province_code:'P1'}},response(user),db),true);
  assert.equal(await provinceMutationAllowed({body:{},params:{}},response({role_name:'Super Admin'}),db),false);
});

test('obituary boundary predicates execute with the same count, pages and all-row export',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.function('concat_ws',(...v)=>v.slice(1).filter(x=>x!=null).join(v[0]));db.function('btrim',v=>v.trim());db.function('regexp_replace',{varargs:true},v=>v.replace(/\s+/g,' '));
    db.exec(`CREATE TABLE obituary_dtl(obituary_code TEXT,province_code TEXT,confrer_scholastic_code TEXT,death_date TEXT,death_place TEXT,member_type_code TEXT,disease_name TEXT);
      CREATE TABLE province_mst(province_code TEXT,province_name TEXT);
      CREATE TABLE confreres_dtl(confrer_code TEXT,first_name TEXT,middle_name TEXT,last_name TEXT);
      CREATE TABLE scholastics_dtl(scholastic_code TEXT,province_code TEXT,first_name TEXT,middle_name TEXT,last_name TEXT);`);
    const insert=db.prepare('INSERT INTO obituary_dtl VALUES (?, ?, ?, ?, ?, ?, ?)');
    for(const [i,date]of ['2026-09-30T18:29:59.999Z','2026-09-30T18:30:00.000Z','2026-10-01T10:00:00.000Z','2026-10-02T18:29:59.999Z','2026-10-02T18:30:00.000Z',null].entries())insert.run('O'+i,'P1','F'+i,date,'Place',null,'Person '+i);
    const execute=sql=>db.prepare(sql.text.replace(/::int/g,'').replace(/\$\d+/g,'?')).all(...sql.values.map(v=>v instanceof Date?v.toISOString():v));
    const run=(input,exportAll=false)=>{const sql=directorySql('obituary',{...parseDirectoryQuery('obituary',input),exportAll},['P1']);return {rows:execute(sql.rows),total:execute(sql.count)[0].total};};
    const filters={from:'2026-10-01',to:'2026-10-02',pageSize:'2'};
    assert.equal(run(filters).total,3);assert.equal(run(filters).rows.length,2);assert.equal(run({...filters,page:'2'}).rows.length,1);
    assert.deepEqual(run(filters,true).rows.map(r=>r.code),['O3','O2','O1']);assert.equal(run({from:filters.from,mode:'all'}).total,4);assert.equal(run({to:filters.to,mode:'all'}).total,4);
  }finally{db.close();}
});
