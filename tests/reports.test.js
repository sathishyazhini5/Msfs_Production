import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {JWT_SECRET} from '../src/config/index.js';
import {modules, reportRows, runReport} from '../src/services/reportService.js';
import {database, loadController, response} from './helpers/controllerHarness.js';

function fixture() {
  const tables = Object.fromEntries(modules.map(m => [m.id, []]));
  Object.assign(tables, {
    congregationBranding:[],
    province_mst:[{province_code:'P1',province_name:'Pune',concretion_code:'C1'},{province_code:'P2',province_name:'Other',concretion_code:'C2'}],
    concretion_defination_mst:[{concretion_code:'C1',concretion_name:'MSFS'},{concretion_code:'C2',concretion_name:'Other congregation'}],
    confreres_dtl: Array.from({length:61}, (_,i)=>({confrer_code:`F${i}`,province_code:i===60?'P2':'P1',first_name:`Person ${i}`,personal1_contact_no:String(9000000000+i),is_active:i%2===0,birth_date:new Date('1990-01-01')})),
    quickcode_mst:[{quick_code_type:'destyp',quick_code:'D1',quickcode_name:'Provincial Superior'}],
    countrymetadata:[],bloodgroup_metadata:[],nationalitymetadata:[],date_format_metadata:[],meta_data_mst:[],
  });
  return {tables,db:database(tables)};
}
const user = {role_name:'province admin',province_code:'P1'};
const req = (body={}, role=user, method='POST') => ({method,headers:{authorization:`Bearer ${jwt.sign(role,JWT_SECRET)}`},body});

test('Reports enforce scope for metadata, preview, and full exports; secrets are not reportable', async()=>{
 const {db}=fixture(); const {reports}=await loadController('../../src/controllers/reports.js',db);
 const meta=response();await reports(req({},user,'GET'),meta);
 assert.equal(meta.statusCode,200);assert.deepEqual(meta.body.provinces.map(p=>p.value),['P1']);assert.deepEqual(meta.body.congregations.map(c=>c.value),['C1']);
 assert.ok(!meta.body.modules.some(m=>m.id==='users_mst'));
 for(const body of [{module:'users_mst'},{module:'confreres_dtl',province:'P2'},{module:'confreres_dtl',congregation:'C2'},{module:'confreres_dtl',columns:['password']}]) {
  const res=response();await reports(req(body),res);assert.ok([400,403].includes(res.statusCode));
 }
 const request={module:'confreres_dtl',columns:['full_name','province_code','personal1_contact_no'],sort:'full_name',direction:'desc'};
 const preview=response();await reports(req(request),preview);assert.equal(preview.body.records.length,25);assert.equal(preview.body.total,60);
 const exported=response();await reports(req({...request,exportAll:true}),exported);assert.equal(exported.body.records.length,60);assert.deepEqual(exported.body.records.slice(0,25),preview.body.records);assert.ok(exported.body.records.every(r=>r.province_code==='Pune'));
 const congregation=response();await reports(req({...request,exportAll:true},{role_name:'congregation admin',concretion_code:'C1'}),congregation);assert.equal(congregation.body.total,60);
 const superAdmin=response();await reports(req({...request,exportAll:true},{role_name:'super admin'}),superAdmin);assert.equal(superAdmin.body.total,61);
 const unsupported=response();await reports(req(request,{role_name:'member'}),unsupported);assert.equal(unsupported.statusCode,403);
 const noToken=response();await reports({method:'POST',headers:{},body:request},noToken);assert.equal(noToken.statusCode,401);
 const expired=response();await reports({method:'POST',headers:{authorization:`Bearer ${jwt.sign(user,JWT_SECRET,{expiresIn:-1})}`},body:request},expired);assert.equal(expired.statusCode,401);
});

test('Reports resolve Curia names, designation, BigInt mobile, and composite division identity',async()=>{
 const {db,tables}=fixture();
 tables.curia_advisors_dtl.push({curia_code:'CUR1',province_code:'P1',confrer_code:'F0',designation_code:'D1',division_type_code:'T',division_code:'D',personal1_contact_no:8877361223n});
 tables.division_setup_mst.push({province_code:'P2',division_type_code:'T',division_code:'D',division_name:'Wrong division'},{province_code:'P1',division_type_code:'T',division_code:'D',division_name:'Right division'});
 const module=modules.find(m=>m.id==='curia_advisors_dtl');
 const rows=await reportRows(db,module,{codes:null,provinces:tables.province_mst,congregations:tables.concretion_defination_mst});
 const result=runReport(module,rows,{columns:['confrer_code','designation_code','division_code','personal1_contact_no'],search:'Provincial Superior',exportAll:true});
 assert.equal(result.records[0].confrer_code,'Person 0');assert.equal(result.records[0].division_code,'Right division');assert.equal(result.records[0].personal1_contact_no,'8877361223');assert.doesNotThrow(()=>JSON.stringify(result));
});

test('Reports validate filters, dates, sorting, pagination, and export flag',async()=>{
 const {db,tables}=fixture(); const module=modules.find(m=>m.id==='confreres_dtl');
 const rows=await reportRows(db,module,{codes:['P1'],provinces:tables.province_mst,congregations:tables.concretion_defination_mst});
 assert.equal(runReport(module,rows,{filters:{is_active:'true'},dateField:'birth_date',from:'1990-01-01',to:'1990-01-01'}).total,30);
 assert.equal(runReport(module,rows,{search:'no matches'}).total,0);
 for(const input of [{columns:[]},{columns:['password']},{filters:{password:'x'}},{filters:{is_active:'garbage'}},{from:'2026-13-01',dateField:'birth_date'},{from:'2026-02-30',dateField:'birth_date'},{from:'2026-10-02',to:'2026-10-01',dateField:'birth_date'},{from:'2026-10-01'},{sort:'password'},{direction:'sideways'},{page:0},{pageSize:101},{exportAll:'true'},{search:'a'.repeat(101)},{unknown:true}]) assert.throws(()=>runReport(module,rows,input),error=>error.status===400);
});

test('Report filters distinguish repeated division codes and times stay readable',async()=>{
 const {db,tables}=fixture();
 const context={codes:null,provinces:tables.province_mst,congregations:tables.concretion_defination_mst};
 tables.division_setup_mst.push({province_code:'P1',division_type_code:'T',division_code:'D',division_name:'Pune division'},{province_code:'P2',division_type_code:'T',division_code:'D',division_name:'Other division'});
 const divisions=modules.find(m=>m.id==='division_setup_mst');
 const rows=await reportRows(db,divisions,context);
 const options=runReport(divisions,rows,{}).options.division_code;
 assert.equal(options.length,2);assert.notEqual(options[0].value,options[1].value);
 assert.equal(runReport(divisions,rows,{filters:{division_code:options[0].value}}).total,1);
 tables.event_dtl.push({event_id:'E1',province_code:'P1',event_name:'Meeting',from_time:new Date('1970-01-01T09:30:00Z'),created_date:new Date('2026-10-06T12:00:00Z')});
 const events=modules.find(m=>m.id==='event_dtl'),eventRows=await reportRows(db,events,context);
 assert.equal(eventRows[0].values.from_time,'09:30:00');assert.equal(eventRows[0].values.created_date,'2026-10-06 12:00:00');
 assert.throws(()=>runReport(events,eventRows,{dateField:'from_time',from:'2026-01-01'}),e=>e.status===400);
});


test('Confrere Apostolate matches appointment OR transfer IDs, deduplicates, and combines with other filters', async () => {
 const {db,tables}=fixture();
 tables.apostolates_mst.push(
  {province_code:'P1',apostolate_code:'A1',centre_type_code:'CT',apostolate_name:'Education'},
  {province_code:'P1',apostolate_code:'A1',centre_type_code:'CT2',apostolate_name:'Education'},
  {province_code:'P1',apostolate_code:'EMPTY',centre_type_code:'CT',apostolate_name:'No assignments'},
  {province_code:'P2',apostolate_code:'A1',centre_type_code:'CT',apostolate_name:'Other Education'});
 const centre={province_code:'P1',division_type_code:'T',division_code:'D',centre_code:'CENTRE',apostolate_code:'A1',centre_type_code:'CT'};
 tables.centre_dtl.push(centre,{...centre,province_code:'P2'});
 const assignment=(confrer_code,mode,extra={})=>({...centre,confrer_code,mode,...extra});
 tables.appoint_transfer_dtl.push(
  assignment('F0','By Appointment'), assignment('F0','By Appointment'),
  assignment('F1','By Transfer'),
  assignment('F2','By Appointment'), assignment('F2','By Transfer'),
  assignment('F4','By Transfer',{division_code:'WRONG'}),
  assignment('F5','By Appointment',{province_code:'P2'}));
 tables.appoint_transfer_his_dtl.push(assignment('F6','By Transfer'));
 const module=modules.find(m=>m.id==='confreres_dtl');
 const rows=await reportRows(db,module,{codes:['P1'],provinces:[tables.province_mst[0]],congregations:tables.concretion_defination_mst});
 const filters={apostolate_code:JSON.stringify(['P1','A1'])};
 const result=runReport(module,rows,{columns:['confrer_code'],filters,exportAll:true});
 assert.deepEqual(result.records.map(r=>r.confrer_code),['Person 0','Person 1','Person 2','Person 6']);
 assert.equal(result.total,4);
 assert.equal(runReport(module,rows,{filters:{centre_code:JSON.stringify(['P1','T','D','CENTRE'])}}).total,4);
 assert.equal(result.options.apostolate_code.length,2);
 assert.equal(runReport(module,rows,{filters:{apostolate_code:JSON.stringify(['P1','EMPTY'])}}).total,0);
 assert.equal(runReport(module,rows,{filters:{...filters,is_active:'false'}}).total,1);
 assert.equal(runReport(module,rows,{filters,search:'Person 2'}).total,1);
 assert.equal(runReport(module,rows,{filters,search:'Person 3'}).total,0);
 assert.equal(runReport(module,rows,{filters,page:2,pageSize:2}).records.length,2);
 assert.equal(runReport(module,rows,{filters,page:2,pageSize:2}).total,4);
 assert.equal(runReport(module,rows,{filters:{apostolate_code:''}}).total,60);
 assert.throws(()=>runReport(module,rows,{filters:{apostolate_code:JSON.stringify(['P2','A1'])}}),e=>e.status===400);
 const {reports}=await loadController('../../src/controllers/reports.js',db);
 const meta=response(); await reports(req({},user,'GET'),meta);
 assert.ok(meta.body.modules.find(m=>m.id==='confreres_dtl').filters.includes('apostolate_code'));
 const preview=response(); await reports(req({module:'confreres_dtl',filters}),preview);
 assert.equal(preview.statusCode,200); assert.equal(preview.body.total,4);
});


test('Reports combine name parts into one Name column for preview and exports', async () => {
 const {db,tables}=fixture();
 Object.assign(tables.confreres_dtl[0], {first_name:'  John ',middle_name:' Paul ',last_name:' Smith  '});
 Object.assign(tables.confreres_dtl[1], {first_name:' Mary ',middle_name:null,last_name:' Jones '});
 const module=modules.find(m=>m.id==='confreres_dtl');
 assert.deepEqual(module.fields.filter(f=>/name/.test(f.key)).map(f=>f.key), ['full_name']);
 const rows=await reportRows(db,module,{codes:['P1'],provinces:tables.province_mst,congregations:tables.concretion_defination_mst});
 const query={columns:['full_name'],search:'John Paul Smith',sort:'full_name'};
 const preview=runReport(module,rows,query);
 assert.equal(preview.columns[0].title,'Name');
 assert.equal(preview.records[0].full_name,'John Paul Smith');
 assert.deepEqual(runReport(module,rows,{...query,exportAll:true}).records,preview.records);
 assert.equal(runReport(module,rows,{columns:['full_name'],search:'Mary Jones'}).records[0].full_name,'Mary Jones');
 assert.ok(!modules.find(m=>m.id==='scholastics_dtl').fields.some(f=>['first_name','middle_name','last_name'].includes(f.key)));
});


test('Selected exports revalidate stable identities against applied filters and scope, keeping column and sort order', async()=>{
 const {db,tables}=fixture(), module=modules.find(m=>m.id==='confreres_dtl');
 const context={codes:['P1'],provinces:tables.province_mst,congregations:tables.concretion_defination_mst};
 const rows=await reportRows(db,module,context);
 const first=runReport(module,rows,{columns:['full_name'],pageSize:25});
 const second=runReport(module,rows,{columns:['full_name'],page:2,pageSize:25});
 const selectedKeys=[first.records[1].key,second.records[2].key];
 const input={columns:['province_code','full_name'],sort:'full_name',direction:'desc',exportAll:true,selectedKeys};
 const exported=runReport(module,rows,input);
 assert.equal(exported.total,2);assert.equal(exported.matchingTotal,60);
 assert.deepEqual(exported.columns.map(c=>c.key),input.columns);
 assert.deepEqual(exported.records.map(r=>r.key),runReport(module,rows,{...input,selectedKeys:undefined}).records.filter(r=>selectedKeys.includes(r.key)).map(r=>r.key));
 assert.equal(exported.summary.scopedRecords,60);assert.equal(exported.summary.active,30);
 assert.throws(()=>runReport(module,rows,{...input,selectedKeys:['foreign-record']}),e=>e.status===400);
 assert.throws(()=>runReport(module,rows,{...input,search:'no match'}),e=>e.status===400);
 assert.throws(()=>runReport(module,rows,{...input,exportAll:false}),e=>e.status===400);
 assert.throws(()=>runReport(module,rows,{...input,selectedKeys:[]}),e=>e.status===400);
 const oldKey=rows[2].key;tables.confreres_dtl.unshift({confrer_code:'NEW',province_code:'P1',first_name:'New person'});
 const refreshed=await reportRows(db,module,context);assert.equal(refreshed.find(r=>r.raw.confrer_code===rows[2].raw.confrer_code).key,oldKey);
 const {reports}=await loadController('../../src/controllers/reports.js',db);
 const rejected=response();await reports(req({...input,module:module.id,province:'P2'}),rejected);assert.equal(rejected.statusCode,403);
});

test('Users full names select only schema fields and never passwords', async()=>{
 const {db,tables}=fixture();tables.users_mst.push({user_id:'example',first_name:'First',last_name:'Last',password:'secret'});
 const module=modules.find(m=>m.id==='users_mst');
 const find=db.users_mst.findMany;db.users_mst.findMany=async args=>{assert.equal(args.select.middle_name,undefined);assert.equal(args.select.password,undefined);return find(args);};
 const rows=await reportRows(db,module,{codes:null,provinces:tables.province_mst,congregations:tables.concretion_defination_mst});
 assert.equal(runReport(module,rows,{columns:['full_name']}).records[0].full_name,'First Last');
});


test('Module filters resolve membership and nationality labels from the database and combine with date ranges', async()=>{
 const {db,tables}=fixture();
 tables.quickcode_mst.push({quick_code_type:'memtyp',quick_code:'PR',quickcode_name:'Priest'});
 tables.nationalitymetadata.push({code:'IND',nationality:'Indian'});
 Object.assign(tables.confreres_dtl[0],{member_type_code:'PR',nationality_code:'IND'});
 const module=modules.find(m=>m.id==='confreres_dtl');
 const rows=await reportRows(db,module,{codes:['P1'],provinces:tables.province_mst,congregations:tables.concretion_defination_mst});
 const result=runReport(module,rows,{columns:['full_name','nationality_code','member_type_code'],filters:{nationality_code:'IND',member_type_code:'PR'},dateField:'birth_date',from:'1990-01-01',to:'1990-01-01',exportAll:true});
 assert.equal(result.total,1);assert.equal(result.records[0].nationality_code,'Indian');assert.equal(result.records[0].member_type_code,'Priest');
 assert.equal(result.options.nationality_code[0].label,'Indian');
});
