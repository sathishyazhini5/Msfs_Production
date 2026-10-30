import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import xlsx from 'xlsx';
import { JWT_SECRET } from '../src/config/index.js';
import { officeCategories, validateOfficeSelections, officeRecordWhere } from '../src/utils/officeTypes.js';
import { recordWhere } from '../src/utils/recordAccess.js';
import { academicYear } from '../src/utils/academicYear.js';
import { readConfrereExcelRows } from '../src/utils/confrereExcel.js';
import { mapConfrereImportRow, normalizeTelephone, excelDate, retryableConfrereRow, validateConfrerePayload, importFingerprint } from '../src/utils/confrereImport.js';
import { createConfrereWithGeneratedCode } from '../src/services/confrereCreationService.js';
import { loadController, database, matches, response } from './helpers/controllerHarness.js';

const user = { role_name: 'province admin', province_code: 'P1', province_name: 'Province One', user_id: 'tester' };
const request = (body = {}, method = 'POST') => ({ method, headers: { authorization: `Bearer ${jwt.sign(user, JWT_SECRET)}` }, body, query: {}, params: {} });
function fixtures() {
  const tables = {
    meta_data_mst: [{ screen_code: 'qckcode', meta_code: 'pcicof', meta_code_name: 'PCIC TYPE' }, { screen_code: 'qckcode', meta_code: 'GCIC_TYPE', meta_code_name: 'GCIC TYPE' }],
    quickcode_mst: [ ['pcicof', 'PCIC001'], ['GCIC_TYPE', 'GCIC001'], ['divtyp', 'DIV'], ['destyp', 'DES'], ['mandat', 'MAN'] ].map(([quick_code_type,quick_code]) => ({quick_code_type,quick_code,quickcode_name:quick_code === 'DES' ? 'Provincial Councillor' : quick_code})),
    province_mst: [{ province_code: 'P1', province_name: 'Province One', short_name: 'VIZAG' }, { province_code: 'P2', province_name: 'Province Two', short_name: 'DIB' }],
    confreres_dtl: [{ confrer_code: 'VIZAG2024009', province_code: 'P1', first_name: 'First', is_active: true }, { confrer_code: 'DIB2024001', province_code: 'P2', first_name: 'Second', is_active: true }, { confrer_code: 'DEAD2024001', province_code: 'P2', is_active: false }],
    division_setup_mst: [{ province_code: 'P1', division_type_code: 'DIV', division_code: 'D1', division_name: 'Division One' }],
    curia_advisors_dtl: [], user_role_com_activity_mst: [], appoint_transfer_dtl: [],
    centre_dtl: [{ centre_code: 'C1', centre_place: 'Place', centre_name: 'Centre' }],
  };
  return { tables, db: database(tables) };
}
const curiaBody = { confrer_code: 'VIZAG2024009', province_code: 'P1', division_type_code: 'DIV', division_code: 'D1', designation_code: 'DES', pcic_off_code: 'PCIC001', gcic_off_code: 'GCIC001', appointment_date: '2026-01-01', installation_date: '2026-01-02', mandate_end_date: '2027-01-01', mandate_code: 'MAN', personal_mailid1: 'person@example.test', personal1_isd: '+91', personal1_contact_no: '1234567890', office_mailid1: 'office@example.test', office1_isd: '+91', office1_contact_no: '1234567890' };

test('office categories reuse deployed GCIC metadata and validate selections in their own category', async () => {
  const { db } = fixtures();
  assert.deepEqual(await officeCategories(db), { pcic: 'pcicof', gcic: 'GCIC_TYPE' });
  await validateOfficeSelections(db, curiaBody);
  await validateOfficeSelections(db, { gcic_off_code: null });
  await assert.rejects(validateOfficeSelections(db, { gcic_off_code: 'PCIC001' }), /gcic_off_code/);
});

test('both office master categories add/edit globally, reject duplicates, enforce permissions', async () => {
  const { db, tables } = fixtures();
  const { saveOfficeType, getOfficeTypes } = await loadController('../../src/controllers/Quickcodecontroller/officeTypes.js', db);
  for (const kind of ['pcic', 'gcic']) {
    const req = request({ quickcode_name: `New ${kind}` }); req.params.kind = kind;
    const res = response(user); await saveOfficeType(req,res); assert.equal(res.statusCode,201);
    assert.equal(res.body.province_code,undefined);
    const code=res.body.quick_code;
    const duplicate=response(user);await saveOfficeType(req,duplicate);assert.equal(duplicate.statusCode,409);
    req.method='PUT';req.params.code=code;req.body.quickcode_name=`Edited ${kind}`;
    const edited=response(user);await saveOfficeType(req,edited);assert.equal(edited.body.quickcode_name,`Edited ${kind}`);
  }
  const denied=response({role_name:'viewer'});const req=request({quickcode_name:'No'});req.params.kind='gcic';await saveOfficeType(req,denied);assert.equal(denied.statusCode,403);
  const global=response({...user,province_code:'P2'});await getOfficeTypes(request(),global);assert.equal(global.body.gcic.length,2);assert.equal(global.body.pcic.length,2);
  assert.equal(tables.quickcode_mst.length,7);
});

test('Curia create, edit, raw read and view persist GCIC, while legacy null remains viewable',async()=>{
 const {db,tables}=fixtures();const api=await loadController('../../src/controllers/Msfs/curia.js',db);
 const created=response();await api.saveCuriaAdvisorDetails(request({...curiaBody}),created);assert.equal(created.statusCode,201,JSON.stringify(created.body));
 assert.equal(created.body.gcic_off_code,'GCIC001');
 const req=request({...curiaBody,gcic_off_code:null},'PUT');req.params.curia_code=created.body.curia_code;req.curiaRecord=tables.curia_advisors_dtl[0];
 const edited=response();await api.updateCuriaAdvisorDetails(req,edited);assert.equal(edited.statusCode,200);assert.equal(edited.body.gcic_off_code,null);
 const view=response();await api.getCuriaAdvisor(req,view);assert.equal(view.statusCode,200);assert.equal(view.body.gcic_name,null);
 req.body.gcic_off_code='GCIC001';await api.updateCuriaAdvisorDetails(req,response());
 const reopened=response();await api.getCuriaAdvisorByCode(req,reopened);assert.equal(reopened.body.gcic_off_code,'GCIC001');
 const selectedView=response();await api.getCuriaAdvisor(req,selectedView);assert.equal(selectedView.body.gcic_name,'GCIC001');
 const invalid=response();await api.updateCuriaAdvisorDetails({...req,body:{...req.body,gcic_off_code:'wrong'}},invalid);assert.equal(invalid.statusCode,400);
});

test('PCIC and GCIC count/popup are global and exclude inactive people and blank selections',async()=>{
 const {db,tables}=fixtures();
 tables.curia_advisors_dtl.push(
  {...curiaBody,curia_code:'A'},
  {...curiaBody,curia_code:'B',province_code:'P2',confrer_code:'DIB2024001'},
  {...curiaBody,curia_code:'C',province_code:'P2',confrer_code:'DEAD2024001'},
  {...curiaBody,curia_code:'D',gcic_off_code:'',pcic_off_code:null});
 const api=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 for(const [type,count] of [['PCIC',1],['GCIC',1]]) {
  const res=response();await api.getDashboardDetails(request({type,exportAll:true}),res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.total,count);assert.equal(res.body.records.length,count);
  const card=response();await api.getDashboardDetails(request({type,pageSize:1}),card);assert.equal(card.body.total,count);
 }
 const global=await officeRecordWhere(db,'GCIC',['P1']);assert.deepEqual(global.province_code,{in:['P1']});
});

test('PCIC and GCIC reads and writes stay inside authenticated province scope',async()=>{
 const {db}=fixtures();const row={...curiaBody,curia_code:'B',province_code:'P2',confrer_code:'DIB2024001'};
 const req=request({},'GET');req.query={province_code:'P2',confrer_code:'DIB2024001'};
 assert.ok(!matches(row,await recordWhere(req,db,{curia_code:'B'},{gcicRead:true})));
 assert.ok(!matches({...row,gcic_off_code:null,pcic_off_code:null},await recordWhere(req,db,{curia_code:'B'},{gcicRead:true})));
 assert.ok(!matches(row,await recordWhere({...req,method:'PUT'},db,{curia_code:'B'},{gcicRead:true})));
 assert.ok(!matches(row,await recordWhere(req,db,{curia_code:'B'})));
 const where=await recordWhere({...req,query:{confrer_code:'other'}},db,{confrer_code:'VIZAG2024009'});assert.equal(where.AND[0].confrer_code,'VIZAG2024009');
});

test('appointment saves the exact VIZAG2024009 identifier',async()=>{
 const {db,tables}=fixtures();const {saveAppointmentTransfer}=await loadController('../../src/controllers/Msfs/admissionandtransfer.js',db);
 const req=request({...curiaBody,centre_place:'Place',centre_name:'Centre',interProvinceTransferChk:0,designations:[{designation_code:'DES',designation_appn_date:'2026-09-01'}]});
 const res=response();let failure;await saveAppointmentTransfer(req,res,error=>{failure=error;});assert.equal(failure,undefined);assert.equal(res.statusCode,200);assert.equal(tables.appoint_transfer_dtl[0].confrer_code,'VIZAG2024009');
});

test('academic-year format accepts editable completed values and rejects invalid saves',()=>{
 assert.equal(academicYear(' 2026-2027 '),'2026-2027');assert.equal(academicYear(''),null);assert.throws(()=>academicYear('2026-'),/YYYY-YYYY/);
});

const examples=[['Chennala Daniel','+1(715)','495-2338','7154952338'],['Edakazhickal Thomas','+1(713)','294-2208','7132942208'],['Hrinii Mark','+1(830)','9986434','8309986434'],['Kulangara Augustine Joshy','+1(218)','329-7793','2183297793'],['Thadathil Francis','+1(715)','579-4462','7155794462']];
for(const [name,isd,number,expected] of examples) test(`import normalizes ${name} without losing digits`,()=>{
 const row={'First Name':name,'Personal1 ISD':isd,'Personal1 Contact':number,'WhatsApp1 ISD':isd,'WhatsApp1':number,'Emergency ISD':'+91','Emergency Contact':'9539387243'};
 const data=mapConfrereImportRow(row,{},'tester');assert.equal(data.personal1_isd,'+1');assert.equal(data.personal1_contact_no,expected);assert.equal(data.watsup1_no,expected);assert.equal(data.emergency_contact_no,'9539387243');
 assert.throws(()=>validateConfrerePayload({personal1_isd:isd}),/personal1_isd: maximum 5/);
});

test('Excel dates honor 1900/1904 workbooks, reject invalid dates, and preserve row mapping',()=>{
 assert.equal(excelDate(1).toISOString().slice(0,10),'1900-01-01');assert.equal(excelDate(0,true).toISOString().slice(0,10),'1904-01-01');
 assert.equal(excelDate('30-09-2026').toISOString().slice(0,10),'2026-09-30');assert.equal(excelDate('2026-09-30').toISOString().slice(0,10),'2026-09-30');
 assert.throws(()=>excelDate('31-02-2026'),/invalid calendar/);assert.throws(()=>excelDate(60),/invalid Excel/);
 const book=xlsx.utils.book_new();book.Workbook={WBProps:{date1904:true}};
 xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet([['Instructions'],['First Name','Ordination Date','Personal1 Contact','Personal1 ISD'],['Example',0,'495-2338','+1(715)']]),'Data');
 const rows=readConfrereExcelRows(xlsx.write(book,{type:'buffer',bookType:'xlsx'}));assert.equal(rows[0].__rowNum__,2);
 const data=mapConfrereImportRow(rows[0],{},'tester');assert.equal(data.ordination_date.getUTCFullYear(),1904);assert.equal(data.personal1_contact_no,'7154952338');
});

test('row errors name the field, never truncate values or discard invalid digits',()=>{
 assert.throws(()=>mapConfrereImportRow({'First Name':'A'.repeat(51)}, {},'tester'),/first_name: maximum 50/);
 assert.throws(()=>normalizeTelephone('+91','123abc','personal1_contact_no'),/personal1_contact_no/);
 assert.equal(normalizeTelephone('+44','020 1234 5678').number,'02012345678');
 assert.throws(()=>mapConfrereImportRow({'First Name':'A',__mappingError__:'Column X: shifted'}, {},'tester'),/Column X/);
});

test('generated code and import retry are stable, including rows with no email',async()=>{
 const {db,tables}=fixtures();let allocations=8;db.$queryRaw=async()=>[{last_sequence:++allocations}];
 const data=mapConfrereImportRow({'First Name':'Import','Ordination Date':'2024-01-01'}, {},'tester');data.import_key=importFingerprint('P1',data);
 const args={prisma:db,province:tables.province_mst[0],ordinationDate:data.ordination_date,data,source:'EXCEL'};
 const first=await createConfrereWithGeneratedCode(args);const second=await createConfrereWithGeneratedCode(args);
 assert.equal(first.confrer_code,'VIZAG2024010');assert.equal(second.confrer_code,first.confrer_code);assert.equal(tables.confreres_dtl.length,4);assert.equal(allocations,10);
});

test('admission API saves an entered year, edits it, reopens it and preserves it on omitted updates',async()=>{
 const {tables}=fixtures();tables.scholastics_admisn_promon_dtl=[];tables.province_country_map_mst=[{province_code:'P1',academic_year:'2020-2021'}];
 const db=database(tables);const api=await loadController('../../src/controllers/Msfs/scholastics_admisn.js',db);
 const body={scholastic_code:'S1',province_code:'P1',centre_code:'C1',centre_place:{centrePlace:'Place'},division_type_code:'DIV',division_code:'D1',start_date:'2026-06-01',academic_year:'2026-2027'};
 const saved=response();await api.saveScholasticAdmisnPromonDetails(request(body),saved);assert.equal(saved.statusCode,201,JSON.stringify(saved.body));assert.equal(saved.body.data.academic_year,'2026-2027');
 const req=request({...body,academic_year:'2027-2028'},'PUT');req.params.scholastics_admisn_code=saved.body.data.scholastics_admisn_code;
 const edited=response();await api.updateScholasticsAdmisnPromonDetails(req,edited);assert.equal(edited.statusCode,200,JSON.stringify(edited.body));assert.equal(edited.body.data.academic_year,'2027-2028');
 delete req.body.academic_year;const unchanged=response();await api.updateScholasticsAdmisnPromonDetails(req,unchanged);assert.equal(unchanged.body.data.academic_year,'2027-2028');
 db.$queryRaw=async()=>tables.scholastics_admisn_promon_dtl;
 const reopened=response();await api.getScholasticsAdmisnPromonDetailsByCode(req,reopened);assert.equal(reopened.body.data.academic_year,'2027-2028');
 req.body.academic_year='2027-';const invalid=response();await api.updateScholasticsAdmisnPromonDetails(req,invalid);assert.equal(invalid.statusCode,400);assert.equal(tables.scholastics_admisn_promon_dtl[0].academic_year,'2027-2028');
});

test('Curia middleware rejects cross-province reads, writes and missing rows',async()=>{
 const {db,tables}=fixtures();tables.curia_advisors_dtl.push({...curiaBody,curia_code:'GLOBAL',confrer_code:'DIB2024001',province_code:'P2'});
 const {curiaAccess}=await loadController('../../src/middlewares/curiaAccess.js',db);
 for(const method of ['GET','PUT','DELETE']) {
  const req=request({},method);req.params.curia_code='GLOBAL';let allowed=false;const res=response();await curiaAccess(req,res,()=>{allowed=true;});
  assert.equal(allowed,false);assert.equal(res.statusCode,404);
 }
 const req=request({},'GET');req.params.curia_code='MISSING';const res=response();await curiaAccess(req,res,()=>assert.fail('missing record was authorized'));assert.equal(res.statusCode,404);
});

test('Excel rejects duplicate headers and reports populated unlabelled columns by row',()=>{
 const book=xlsx.utils.book_new();xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet([['First Name','First Name'],['A','B']]),'Data');
 assert.throws(()=>readConfrereExcelRows(xlsx.write(book,{type:'buffer',bookType:'xlsx'})),/occurs more than once/);
 const second=xlsx.utils.book_new();xlsx.utils.book_append_sheet(second,xlsx.utils.aoa_to_sheet([['First Name'],['A','unexpected']]),'Data');
 const row=readConfrereExcelRows(xlsx.write(second,{type:'buffer',bookType:'xlsx'}))[0];assert.equal(row.__rowNum__,1);assert.throws(()=>mapConfrereImportRow(row,{},'tester'),/Column B/);
});

test('failed-row JSON keeps 1904 dates correct when the browser downloads a retry workbook',()=>{
 const row={'First Name':'Example','Ordination Date':0};Object.defineProperty(row,'__date1904__',{value:true});
 const retried=JSON.parse(JSON.stringify(retryableConfrereRow(row)));assert.equal(retried['Ordination Date'],'1904-01-01');
 assert.equal(mapConfrereImportRow(retried,{},'tester').ordination_date.getUTCFullYear(),1904);
});
test('actual Confrere module view rejects an unrelated province record',async()=>{
 const {db}=fixtures();const {getConfrere}=await loadController('../../src/controllers/Msfs/confreres.js',db);
 const req=request({},'GET');req.params.confrer_code='DIB2024001';const res=response();await getConfrere(req,res);assert.equal(res.statusCode,404);
});

for (const selection of [null, '', undefined]) test(`Curia accepts optional PCIC and GCIC: ${String(selection)}`, async () => {
 const {db,tables}=fixtures(); const api=await loadController('../../src/controllers/Msfs/curia.js',db);
 const body={...curiaBody,pcic_off_code:selection,gcic_off_code:selection};
 const created=response(); await api.saveCuriaAdvisorDetails(request(body),created);
 assert.equal(created.statusCode,201,JSON.stringify(created.body));
 const req=request({...curiaBody,pcic_off_code:'',gcic_off_code:''},'PUT'); req.params.curia_code=created.body.curia_code; req.curiaRecord=tables.curia_advisors_dtl[0];
 const updated=response(); await api.updateCuriaAdvisorDetails(req,updated);
 assert.equal(updated.statusCode,200,JSON.stringify(updated.body));
 assert.equal(updated.body.pcic_off_code,null); assert.equal(updated.body.gcic_off_code,null);
});


test('office searches exclude other provinces; authorized Curia views retain contact formatting', async () => {
 const {db,tables}=fixtures();
 Object.assign(tables.confreres_dtl[1], {personal1_isd:'+91',personal1_contact_no:'9876543210'});
 tables.quickcode_mst.push({quick_code_type:'destyp',quick_code:'DES2',quickcode_name:'Rector'});
 tables.appoint_transfer_dtl.push(
  {confrer_code:'DIB2024001',designation_code:'DES',is_active:true,designation_end_date:null},
  {confrer_code:'DIB2024001',designation_code:'DES2',is_active:true,designation_end_date:null},
  {confrer_code:'DIB2024001',designation_code:'OLD',is_active:true,designation_end_date:'2020-01-01'});
 tables.curia_advisors_dtl.push({...curiaBody,curia_code:'B',province_code:'P2',confrer_code:'DIB2024001'});
 const api=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 for(const type of ['PCIC','GCIC']) {
  const res=response(); await api.getDashboardDetails(request({type,search:'9876543210'}),res);
  assert.equal(res.statusCode,200); assert.equal(res.body.scopeLabel,'Province One'); assert.equal(res.body.filteredTotal,0);
  assert.deepEqual(res.body.records,[]);
 }
 const curia=await loadController('../../src/controllers/Msfs/curia.js',db);
 const req=request({},'GET');req.curiaRecord=tables.curia_advisors_dtl[0]; const res=response();await curia.getCuriaAdvisor(req,res);
 assert.equal(res.body.mobile_number,'+91 9876543210'); assert.equal(res.body.current_designations,'Provincial Councillor');
 delete tables.confreres_dtl[1].personal1_contact_no;tables.appoint_transfer_dtl.length=0;
 const missing=response();await curia.getCuriaAdvisor(req,missing);
 assert.equal(missing.body.mobile_number,'Not available');assert.equal(missing.body.current_designations,'Provincial Councillor');
});

test('office dashboard and exports display and search Curia contacts without profile contacts or appointments', async () => {
 const {db,tables}=fixtures();
 tables.quickcode_mst.find(row => row.quick_code === 'DES').quickcode_name = 'Provincial Superior';
 tables.curia_advisors_dtl.push({...curiaBody,curia_code:'CUR001',personal1_contact_no:8877361223n});
 const api=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 for(const type of ['GCIC']) {
  for(const body of [{type}, {type,search:'8877361223'}, {type,search:'person@example.test',exportAll:true}]) {
   const res=response(); await api.getDashboardDetails(request(body),res);
   assert.equal(res.statusCode,200);
   assert.equal(res.body.filteredTotal,1);
   assert.equal(res.body.records[0].current_designations,'Provincial Superior');
   assert.equal(res.body.records[0].mobile_number,'+91 8877361223');
   assert.doesNotThrow(() => JSON.stringify(res.body));
  }
 }
});


test('Curia dashboard counts table rows in scope, excludes inactive people, and supports zero and errors', async () => {
 const {db,tables}=fixtures();
 tables.province_mst[0].concretion_code='C1';
 tables.province_mst[1].concretion_code='C2';
 tables.concretion_defination_mst=[{concretion_code:'C1',concretion_name:'First congregation'}];
 db.concretion_defination_mst=database({concretion_defination_mst:tables.concretion_defination_mst}).concretion_defination_mst;
 tables.curia_advisors_dtl.push(
  {...curiaBody,curia_code:'A',pcic_off_code:null,gcic_off_code:''},
  {...curiaBody,curia_code:'B'},
  {...curiaBody,curia_code:'C',province_code:'P2',confrer_code:'DIB2024001'},
  {...curiaBody,curia_code:'D',province_code:'P2',confrer_code:'DEAD2024001'});
 const {getDashboardDetails}=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 const run=async (role,body={})=>{
  const res=response();
  await getDashboardDetails({headers:{authorization:`Bearer ${jwt.sign(role,JWT_SECRET)}`},body:{type:'CURIA',...body}},res);
  return res;
 };
 const scoped=await run(user,{pageSize:1});
 assert.equal(scoped.statusCode,200);assert.equal(scoped.body.total,2);assert.equal(scoped.body.records.length,1);
 assert.equal(scoped.body.scopeLabel,'Province One');
 const exported=await run(user,{exportAll:true});assert.equal(exported.body.records.length,2);
 const all=await run({role_name:'super admin'});assert.equal(all.body.total,3);
 const selected=await run({role_name:'super admin'},{province_code:'P2'});assert.equal(selected.body.total,1);
 const congregation=await run({role_name:'congregation admin',concretion_code:'C1'});assert.equal(congregation.body.total,2);
 assert.equal((await run({role_name:'congregation admin',concretion_code:'C1'},{province_code:'P2'})).statusCode,403);
 assert.equal((await run({role_name:'viewer'})).statusCode,403);
 assert.equal((await run(user,{search:'no matching person'})).body.filteredTotal,0);
 tables.curia_advisors_dtl.length=0;
 assert.equal((await run(user)).body.total,0);
 const noToken=response();await getDashboardDetails({headers:{},body:{type:'CURIA'}},noToken);assert.equal(noToken.statusCode,401);
 db.curia_advisors_dtl.count=async()=>{throw new Error('Database unavailable');};
 assert.equal((await run(user)).statusCode,500);
});


test('Curia view designation matches the office popup and falls back only when its record has no designation', async()=>{
 const {db,tables}=fixtures();
 tables.quickcode_mst.push({quick_code_type:'destyp',quick_code:'LOCAL',quickcode_name:'Local Bursar'},{quick_code_type:'destyp',quick_code:'RECTOR',quickcode_name:'Rector'});
 const row={...curiaBody,curia_code:'DESIGNATION',designation_code:'LOCAL'};
 tables.curia_advisors_dtl.push(row);
 const view=await loadController('../../src/controllers/Msfs/curia.js',db);
 const dashboard=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 const getView=async()=>{const res=response();await view.getCuriaAdvisor({...request(),params:{curia_code:row.curia_code},curiaRecord:row},res);assert.equal(res.statusCode,200);return res.body;};
 // A missing current appointment must not hide a valid Curia designation.
 assert.equal((await getView()).current_designations,'Local Bursar');
 for(const type of ['GCIC']) {
  const popup=response();await dashboard.getDashboardDetails(request({type}),popup);
  assert.equal(popup.body.records[0].current_designations,(await getView()).current_designations);
 }
 // A different appointment designation must not replace this Curia record's designation.
 tables.appoint_transfer_dtl.push({confrer_code:row.confrer_code,designation_code:'RECTOR',designation_end_date:null,is_active:true});
 assert.equal((await getView()).current_designations,'Local Bursar');
 row.designation_code=null;assert.equal((await getView()).current_designations,'Rector');
 tables.appoint_transfer_dtl.length=0;assert.equal((await getView()).current_designations,'Not available');
});

test('PCIC includes every selected office and filters province/designation across pages and exports', async () => {
 const {db,tables}=fixtures();
 tables.quickcode_mst.push({quick_code_type:'destyp',quick_code:'LOCAL',quickcode_name:'Local Bursar'});
 tables.curia_advisors_dtl.push(
  {...curiaBody,curia_code:'A',designation_code:'LOCAL'},
  {...curiaBody,curia_code:'B',province_code:'P2',confrer_code:'DIB2024001'},
  {...curiaBody,curia_code:'C',pcic_off_code:''});
 const {getDashboardDetails}=await loadController('../../src/controllers/Dashboard/dashboardDetails.js',db);
 const run=async options=>{const res=response();await getDashboardDetails(request({type:'PCIC',...options}),res);assert.equal(res.statusCode,200);return res.body;};
 const card=await run({pageSize:1});assert.equal(card.total,1);assert.equal(card.records.length,1);
 assert.equal(card.filterOptions.provinces.length,1);assert.equal(card.filterOptions.designations.length,1);
 assert.deepEqual((await run({exportAll:true})).records.map(row=>row.curia_code),['A']);
 for(const options of [{filterProvince:'P1'}, {filterDesignation:'LOCAL'}, {filterProvince:'P1',filterDesignation:'LOCAL',search:'person@example.test',exportAll:true}]) {
  const result=await run(options);assert.equal(result.total,1);assert.equal(result.filteredTotal,1);assert.equal(result.records[0].curia_code,'A');
  assert.equal(result.filterOptions.provinces.length,1);
 }
 const none=await run({filterProvince:'P2',filterDesignation:'LOCAL',exportAll:true});assert.equal(none.filteredTotal,0);assert.deepEqual(none.records,[]);
 assert.equal((await run({filterProvince:'unknown'})).filteredTotal,0);
});
