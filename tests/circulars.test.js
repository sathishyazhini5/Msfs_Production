import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {JWT_SECRET} from '../src/config/index.js';
import {resolveDataScope} from '../src/utils/dataScope.js';
import {CircularService,selectionOf,summarizeRecipients,validateAttachment,MAX_ATTACHMENT_BYTES} from '../src/services/circularService.js';
import {database} from './helpers/controllerHarness.js';
const scope={user:{user_id:'sender@example.test'},role:'province admin',provinceCodes:['P1']};
function fixture(){
 const tables={province_mst:[{province_code:'P1',province_name:'One',concretion_code:'C1'},{province_code:'P2',province_name:'Two',concretion_code:'C2'}],
 confreres_dtl:[{confrer_code:'F0',province_code:'P1',first_name:'Alice',personal_mailid1:' ALICE@example.test ',is_active:true},{confrer_code:'F1',province_code:'P1',first_name:'Missing',is_active:true},{confrer_code:'F2',province_code:'P1',first_name:'Invalid',personal_mailid1:'bad address',is_active:true},{confrer_code:'F3',province_code:'P1',first_name:'Inactive',personal_mailid1:'inactive@example.test',is_active:false},{confrer_code:'F4',province_code:'P2',first_name:'Bob',personal_mailid1:'bob@example.test',is_active:true}],
 scholastics_dtl:[{scholastic_code:'S1',province_code:'P1',first_name:'Alice Scholar',personal_mailid1:'alice@example.test',is_active:true},{scholastic_code:'S2',province_code:'P1',first_name:'Carol',personal_mailid1:'carol@example.test',is_active:true}],
 curia_advisors_dtl:[{curia_code:'C0',confrer_code:'F0',province_code:'P1',division_type_code:'T',division_code:'D',personal_mailid1:'alice@example.test'},{curia_code:'C3',confrer_code:'F0',province_code:'P1',division_type_code:'T',division_code:'D',personal_mailid1:'office@example.test'},{curia_code:'C2',confrer_code:'F3',province_code:'P1',division_type_code:'T',division_code:'D'}],circularAttachment:[]};
 const db=database(tables),files=new Map();
 const service=new CircularService({db,storage:{upload:async b=>{files.set('private/test.pdf',b);return 'private/test.pdf';},download:async key=>files.get(key),remove:async key=>files.delete(key)}});
 return {tables,db,service};
}
test('actual category tables, province scope, pagination, email validity and deduplication',async()=>{
 const {service}=fixture(), all={filters:{province:'ALL'},mode:'all',excludedKeys:[]};
 const page=await service.recipients(scope,{selection:all,page:1,pageSize:2});
 assert.equal(page.matching,7);assert.equal(page.records.length,2);assert.deepEqual(page.counts,{selected:7,eligible:3,missing:1,invalid:1,invalidTotal:2,duplicates:2});
 const second=await service.recipients(scope,{selection:all,page:2,pageSize:2});assert.deepEqual(second.counts,page.counts);assert.notDeepEqual(second.records,page.records);
 const excluded=await service.recipients(scope,{selection:{...all,excludedKeys:[page.records[0].key]},page:2,pageSize:2});assert.equal(excluded.counts.selected,6);
 const selected=await service.recipients(scope,{selection:{...all,mode:'individual',keys:[page.records[0].key,second.records[0].key]},page:2});assert.equal(selected.counts.selected,2);
 await assert.rejects(service.recipients(scope,{selection:{...all,mode:'individual',keys:['foreign']}}),e=>e.status===400);
 await assert.rejects(service.loadRecipients(scope,{province:'P2'}),e=>e.status===403);
 assert.equal((await service.loadRecipients(scope,{search:'Carol',categories:['Scholastics']})).rows.length,1);
 await assert.rejects(service.loadRecipients(scope,{categories:['Invented']}),e=>e.status===400);
});
test('Curia membership follows the Curia row province and its actual linked active confrere',async()=>{
 const {service,tables}=fixture();tables.curia_advisors_dtl.push({curia_code:'CROSS',confrer_code:'F4',province_code:'P1',division_type_code:'T',division_code:'D',personal_mailid1:'curia@example.test'});
 const rows=(await service.loadRecipients(scope,{categories:['Curia']})).rows;
 assert.equal(rows.length,3);assert.ok(rows.some(r=>r.name==='Bob' && r.province_code==='P1' && r.email==='curia@example.test'));assert.ok(!rows.some(r=>r.name==='Inactive'));
});
test('existing role/congregation authorization rejects viewers and foreign provinces',async()=>{
 const {db}=fixture();const req=user=>({headers:{authorization:`Bearer ${jwt.sign(user,JWT_SECRET)}`}});
 await assert.rejects(resolveDataScope(req({role_name:'viewer'}),db),e=>e.status===403);
 await assert.rejects(resolveDataScope(req({role_name:'congregation admin',concretion_code:'C1'}),db,'P2'),e=>e.status===403);
 const actual=await resolveDataScope(req({role_name:'province admin',province_code:'P1',user_id:'sender@example.test'}),db);assert.deepEqual(actual.provinceCodes,['P1']);
});
test('private uploads validate type, bytes and size, and enforce attachment scope/ownership',async()=>{
 const {service}=fixture(),file={originalname:'circular.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-test circular')};
 const attachment=await service.upload(scope,file);assert.equal(attachment.filename,'circular.pdf');assert.equal(attachment.blob_key,undefined);
 assert.equal((await service.attachment(scope,attachment.id)).buffer.toString(),file.buffer.toString());
 await assert.rejects(service.attachment({...scope,provinceCodes:['P2']},attachment.id),e=>e.status===404);
 await assert.rejects(service.attachment({...scope,user:{user_id:'another@example.test'}},attachment.id),e=>e.status===404);
 assert.throws(()=>validateAttachment({...file,buffer:Buffer.from('<html>fake</html>')}));
 assert.throws(()=>validateAttachment({...file,originalname:'bad.svg'}));
 assert.throws(()=>validateAttachment({...file,buffer:Buffer.alloc(MAX_ATTACHMENT_BYTES+1)}),e=>e.status===413);
 assert.throws(()=>selectionOf({filters:{},mode:'individual',keys:['same','same']}));
 assert.equal(summarizeRecipients([{email:'INVALID',name:'Invalid'}]).counts.eligible,0);
});
