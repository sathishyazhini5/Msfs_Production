import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/index.js';
import { resolveDataScope } from '../src/utils/dataScope.js';
import { requireEstatusAccess, setEstatusRecordWhere, estatusRecordWhere } from '../src/utils/estatusAccess.js';
import { loadController, response, database } from './helpers/controllerHarness.js';
import { parseDirectoryQuery, directorySql, fetchDirectory, loadDirectoryOptions, appliedDirectoryFilters, filterFields } from '../src/services/estatusService.js';

test('directory query rejects unsupported filters, arrays, invalid pagination and excessive search', () => {
  assert.deepEqual(parseDirectoryQuery('confrere', {}), { page: 1, pageSize: 20 });
  for (const query of [{ page: '0' }, { page: '1.1' }, { pageSize: '101' }, { province_code: ['P1'] }, { search: 'x'.repeat(101) }, { imaginary: 'x' }]) assert.throws(() => parseDirectoryQuery('centre', query), { status: 400 });
  assert.throws(() => parseDirectoryQuery('obituary', { designation_code: 'D1' }), { status: 400 });
});
test('SQL applies scope, active appointments, composite division, search and pagination as bound parameters', () => {
  const filters = parseDirectoryQuery('confrere', { division: JSON.stringify(['P1', 'T1', 'D1']), designation_code: 'DES', member_type_code: 'MEM', nationality_code: 'NAT', search: "O'Neil_%", page: '2', pageSize: '10' });
  const { rows, count } = directorySql('confrere', filters, ['P1']);
  assert.match(rows.text, /EXISTS .*appoint_transfer_dtl/);
  assert.match(rows.text, /a\.province_code = r\.province_code AND a\.is_active = TRUE/);
  assert.match(rows.text, /r\.member_type_code = \$/);
  assert.match(rows.text, /r\.nationality_code = \$/);
  assert.ok(rows.values.includes("%O'Neil\\_\\%%"));
  assert.deepEqual(rows.values.slice(-2), [10, 10]);
  assert.ok(!count.text.includes('LIMIT'));
  assert.match(directorySql('centre', { page: 1, pageSize: 20, state: JSON.stringify(['IN', 'TN']) }, []).rows.text, /WHERE FALSE AND r.country_code/);
  assert.match(directorySql('obituary', { page: 1, pageSize: 20, search: 'John' }, ['P1']).rows.text, /s.province_code = r.province_code/);
});
const db = {
  province_mst: { findMany: async () => [{ province_code: 'P1', province_name: 'Province' }], findFirst: async () => ({ province_code: 'P1' }) },
  division_setup_mst: { findMany: async () => [{ province_code: 'P1', division_type_code: 'T', division_code: 'D', division_name: 'Division' }] },
  quickcode_mst: { findMany: async () => [{ quick_code_type: 'destyp', quick_code: 'DES', quickcode_name: 'Superior' }, { quick_code_type: 'memtyp', quick_code: 'MEM', quickcode_name: 'Priest' }] },
  apostolates_mst: { findMany: async () => [{ apostolate_code: 'A1', apostolate_name: 'Education', centre_type_code: 'C1', centre_type_name: 'School' }, { apostolate_code: 'A2', apostolate_name: 'Mission', centre_type_code: 'C2', centre_type_name: 'Parish' }] },
  community_house_dtl: { findMany: async () => [] },
  state_mst: { findMany: async ({ where }) => [{ country_code: where.country_code || 'IN', state_code: 'TN', state_name: 'Tamil Nadu' }] },
  country_mst: { findMany: async () => [{ country_code: 'IN', country_name: 'India' }] },
  centre_dtl: { findMany: async () => [] },
};
test('options reuse deployed master types and enforce province/division, apostolate/center, country/state dependencies', async () => {
  const confrere = await loadDirectoryOptions(db, 'confrere', ['P1'], {});
  assert.deepEqual(confrere.designation_code, [{ value: 'DES', label: 'Superior' }]);
  const options = await loadDirectoryOptions(db, 'centre', ['P1'], { apostolate_code: 'A1', country_code: 'IN' });
  assert.deepEqual(options.centre_type_code, [{ value: 'C1', label: 'School' }]);
  assert.equal(options.state[0].value, JSON.stringify(['IN', 'TN']));
  await assert.rejects(fetchDirectory(db, 'centre', { page: 1, pageSize: 20, apostolate_code: 'A1', centre_type_code: 'C2' }, ['P1']), { status: 400 });
  await assert.rejects(fetchDirectory(db, 'confrere', { page: 1, pageSize: 20, division: '["P2","T","D"]' }, ['P1']), { status: 400 });
});
test('province admin cannot broaden scope; unsupported roles are denied; congregation admin receives only its provinces', async () => {
  const request = (claims) => ({ headers: { authorization: `Bearer ${jwt.sign(claims, JWT_SECRET)}` } });
  const province = request({ role_name: 'Province Admin', province_code: 'P1' });
  assert.deepEqual((await resolveDataScope(province, db)).provinceCodes, ['P1']);
  await assert.rejects(resolveDataScope(province, db, 'P2'), { status: 403 });
  await assert.rejects(resolveDataScope(request({ role_name: 'Member' }), db), { status: 403 });
  await assert.rejects(resolveDataScope({ headers: {} }, db), { status: 401 });
  const congregationDb = { province_mst: { findMany: async ({ where }) => { assert.equal(where.concretion_code, 'CG'); return [{ province_code: 'P1' }]; } } };
  assert.deepEqual((await resolveDataScope(request({ role_name: 'Congregation Admin', concretion_code: 'CG' }), congregationDb)).provinceCodes, ['P1']);
});
test('eStatus grants global reads to its existing allowed roles without changing shared scope or allowing writes', async () => {
  const request = (role, method = 'GET') => ({ method, headers: { authorization: `Bearer ${jwt.sign({ role_name: role, province_code: 'P1' }, JWT_SECRET)}` }, query: { estatus: 'true' } });
  for (const role of ['Province Admin', 'Congregation Admin', 'Super Admin']) assert.equal(requireEstatusAccess(request(role)).role_name, role);
  assert.throws(() => requireEstatusAccess(request('Member')), { status: 403 });
  assert.throws(() => requireEstatusAccess(request('Province Admin', 'POST')), { status: 405 });
  assert.throws(() => requireEstatusAccess({ method: 'GET', headers: {} }), { status: 401 });
  const req = request('Province Admin');
  assert.equal(estatusRecordWhere(req), undefined);
  setEstatusRecordWhere(req, { confrer_code: 'C2', province_code: 'P2' });
  assert.deepEqual(estatusRecordWhere(req), { confrer_code: 'C2', province_code: 'P2' });
  req.method = 'DELETE';
  assert.equal(estatusRecordWhere(req), undefined);
  await assert.rejects(resolveDataScope(request('Province Admin'), db, 'P2'), { status: 403 });
});
test('obituary global detail uses the complete identity and the selected province for duplicate scholastic codes', async () => {
  const identity = { obituary_code: 'O2', province_code: 'P2', confrer_scholastic_code: 'S1' };
  const nullable = { findFirst: async () => null };
  const database = {
    obituary_dtl: { findFirst: async ({ where }) => { assert.deepEqual(where, identity); return { ...identity }; } },
    province_mst: nullable, quickcode_mst: nullable, country_mst: nullable, countrymetadata: nullable, confreres_dtl: nullable,
    scholastics_dtl: { findFirst: async ({ where }) => { assert.deepEqual(where, { scholastic_code: 'S1', province_code: 'P2' }); return { first_name: 'Selected', last_name: 'Person' }; } },
    scholastics_admisn_promon_dtl: { findMany: async ({ where }) => { assert.deepEqual(where, { scholastic_code: 'S1', province_code: 'P2' }); return []; } },
    $disconnect: async () => {},
  };
  const { getObituary } = await loadController('../../src/controllers/Msfs/Obituary_dtl.js', database);
  const req = { method: 'GET', params: { obituary_code: 'O2' }, query: {}, headers: {} };
  setEstatusRecordWhere(req, identity);
  const res = response();
  await getObituary(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.person_details.name, 'Selected Person');
});
test('Centre global profile selects the complete record key and province-owned master names; optional mappings may be absent', async () => {
  const identity = { centre_code: 'DUP', province_code: 'P2', division_type_code: 'T', division_code: 'D' };
  const tables = {
    centre_dtl: ['P1', 'P2'].map((province_code) => ({ ...identity, province_code, centre_name: province_code, apostolate_code: 'A', centre_type_code: 'CT', community_house_code: 'H', diocese_code: 'DIO', country_code: 'IN', state_code: 'TN' })),
    province_mst: ['P1', 'P2'].map((province_code) => ({ province_code, province_name: province_code })),
    division_setup_mst: [],
    quickcode_mst: [['divtyp', 'T'], ['ctrtyp', 'CT'], ['diocse', 'DIO']].map(([quick_code_type, quick_code]) => ({ quick_code_type, quick_code, quickcode_name: quick_code })),
    apostolates_mst: ['P1', 'P2'].map((province_code) => ({ province_code, apostolate_code: 'A', centre_type_code: 'CT', apostolate_name: `${province_code} apostolate` })),
    community_house_dtl: ['P1', 'P2'].map((province_code) => ({ province_code, division_type_code: 'T', division_code: 'D', community_house_code: 'H', community_house_name: `${province_code} community` })),
    country_mst: ['P1', 'P2'].map((province_code) => ({ province_code, country_code: 'IN', country_name: `${province_code} country` })),
    state_mst: ['P1', 'P2'].map((province_code) => ({ province_code, country_code: 'IN', state_code: 'TN', state_name: `${province_code} state` })),
  };
  const { getcenterdetails } = await loadController('../../src/controllers/Msfs/centre.js', database(tables));
  const req = { method: 'GET', params: { centre_code: 'DUP' }, query: {} };
  setEstatusRecordWhere(req, identity);
  const res = response();
  await getcenterdetails(req, res, (err) => { throw err; });
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].centre_name, 'P2');
  assert.equal(res.body[0].Community_house_name, 'P2 community');
  assert.equal(res.body[0].Apostolate_name, 'P2 apostolate');
  assert.equal(res.body[0].Country, 'P2 country');
  assert.equal(res.body[0].State, 'P2 state');
  Object.assign(tables.centre_dtl[1], { apostolate_code: null, centre_type_code: null, community_house_code: null });
  const emptyMappings = response();
  await getcenterdetails(req, emptyMappings, (err) => { throw err; });
  assert.equal(emptyMappings.body[0].Community_house_name, '');
  assert.equal(emptyMappings.body[0].Apostolate_name, '');
});


test('obituary today uses death date and India timezone; explicit all/date modes share count and row filters', () => {
  const today = directorySql('obituary', { page: 1, pageSize: 20 }, null);
  assert.match(today.rows.text, /AT TIME ZONE 'Asia\/Kolkata'\)::date = \(CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Kolkata'\)::date/);
  assert.match(today.count.text, /Asia\/Kolkata/);
  const all = directorySql('obituary', { mode: 'all', page: 2, pageSize: 10 }, null);
  assert.doesNotMatch(all.count.text, /CURRENT_TIMESTAMP/);
  assert.deepEqual(all.rows.values.slice(-2), [10, 10]);
  const date = directorySql('obituary', { mode: 'all', death_date: '2026-10-05', page: 1, pageSize: 20 }, null);
  assert.ok(date.count.values.includes('2026-10-05'));
  assert.ok(date.rows.values.includes('2026-10-05'));
  assert.doesNotMatch(date.count.text, /c.province_code = r.province_code/);
  for (const q of [{ mode: 'invalid' }, { death_date: '2026-02-30' }, { death_date: 'yesterday' }]) assert.throws(() => parseDirectoryQuery('obituary', q), { status: 400 });
});


test('current Centre resolves complete assignment identity, excludes inactive/ended assignments and handles no assignment', async () => {
  const tables = {
    confreres_dtl: [{ confrer_code: 'CF', province_code: 'P1', first_name: 'John' }],
    province_mst: [{ province_code: 'P1', province_name: 'Province' }],
    quickcode_mst: [], confreres_feedback_dtl: [], appoint_transfer_his_dtl: [],
    appoint_transfer_dtl: [
      { confrer_code: 'CF', is_active: true, designation_end_date: null, province_code: 'P2', division_type_code: 'T', division_code: 'D2', centre_code: 'C' },
      { confrer_code: 'CF', is_active: false, designation_end_date: null, province_code: 'P1', division_type_code: 'T', division_code: 'D1', centre_code: 'C' }
    ],
    centre_dtl: [
      { centre_code: 'C', province_code: 'P1', division_type_code: 'T', division_code: 'D1', centre_name: 'Wrong Centre' },
      { centre_code: 'C', province_code: 'P2', division_type_code: 'T', division_code: 'D2', centre_name: 'Assigned Centre' }
    ]
  };
  const { getConfrere } = await loadController('../../src/controllers/Msfs/confreres.js', database(tables));
  const req = { method: 'GET', params: { confrer_code: 'CF' } };
  setEstatusRecordWhere(req, { confrer_code: 'CF', province_code: 'P1' });
  const res = response(); await getConfrere(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.current_centre_name, 'Assigned Centre');
  assert.equal(res.body.current_designation.length, 1);
  tables.appoint_transfer_dtl.length = 0;
  const empty = response(); await getConfrere(req, empty);
  assert.equal(empty.body.current_centre_name, 'Not assigned');
});


test('Scholastics filters combine on one current admission with province identity and shared pagination', async () => {
 const filters=parseDirectoryQuery('scholastic',{province_code:'P1',division:JSON.stringify(['P1','T','D']),member_type_code:'MEM',nationality_code:'NAT',scholastic_type_code:'SCH',formation_type_code:'FOR',year_formation_code:'YR',search:'John',page:'2',pageSize:'10'});
 const {rows,count}=directorySql('scholastic',filters,['P1']);
 assert.match(rows.text,/FROM scholastics_dtl/);assert.match(rows.text,/r.is_active = TRUE/);
 assert.match(rows.text,/EXISTS .*scholastics_admisn_promon_dtl/);
 assert.match(rows.text,/a.scholastic_code = r.scholastic_code AND a.province_code = r.province_code AND a.end_date IS NULL/);
 for(const field of ['scholastic_type_code','formation_type_code','year_formation_code']) assert.match(rows.text,new RegExp('a\\.'+field+' ='));
 assert.ok(rows.values.includes('SCH'));assert.ok(rows.values.includes('FOR'));assert.ok(rows.values.includes('YR'));
 assert.deepEqual(rows.values.slice(-2),[10,10]);assert.ok(!count.text.includes('LIMIT'));
 assert.match(directorySql('scholastic',{page:1,pageSize:20},[]).rows.text,/WHERE FALSE/);
 const options=await loadDirectoryOptions({...db,quickcode_mst:{findMany:async()=>[{quick_code_type:'schtyp',quick_code:'SCH',quickcode_name:'Theology'}]}},'scholastic',['P1'],{});
 assert.deepEqual(options.scholastic_type_code,[{value:'SCH',label:'Theology'}]);
 await assert.rejects(fetchDirectory(db,'scholastic',{page:1,pageSize:20,scholastic_type_code:'UNKNOWN'},['P1']),{status:400});
});


test('Scholastic global detail retains province ownership for duplicate codes and related data', async()=>{
 const identity={scholastic_code:'S1',province_code:'P2'};
 const empty={findMany:async()=>[]};
 const prisma={
  scholastics_dtl:{findFirst:async({where})=>{assert.deepEqual(where,identity);return {...identity,first_name:'Selected',last_name:'Person',personal1_contact_no:123n};}},
  quickcode_mst:{findFirst:async()=>null},province_mst:{findFirst:async()=>({province_name:'Province Two'})},
  scholastics_feedback_dtl:{findMany:async({where})=>{assert.deepEqual(where,identity);return [];}},
  scholastics_admisn_promon_dtl:empty,scholastics_admisn_his_dtl:empty,
 };
 const api=await loadController('../../src/controllers/Msfs/scholastics.js',prisma);
 const req={method:'GET',params:{scholastic_code:'S1'},query:{},headers:{}};setEstatusRecordWhere(req,identity);
 const res=response();await api.getScholasticDetails(req,res);assert.equal(res.statusCode,200);assert.equal(res.body.province_code,'P2');assert.equal(res.body.personal1_contact_no,'123');
});


test('applied filter summaries resolve every directory filter, composite IDs and multiple names', () => {
 for (const [kind, fields] of Object.entries(filterFields)) {
  const filters=Object.fromEntries(fields.map(field=>[field,field==='division'?JSON.stringify(['P1','T','D']):`${field}-id`]));
  const options=Object.fromEntries(fields.map(field=>[field,[{value:filters[field],label:`Readable ${field}`}]]));
  assert.deepEqual(appliedDirectoryFilters(kind,filters,options),fields.map(field=>({field,values:[`Readable ${field}`]})));
  assert.deepEqual(appliedDirectoryFilters(kind,{},options),[]);
 }
 assert.deepEqual(appliedDirectoryFilters('confrere',{apostolate_code:['A1','A2'],province_code:''},{apostolate_code:[{value:'A1',label:'Education'},{value:'A2',label:'Mission'}]}),[{field:'apostolate_code',values:['Education','Mission']}]);
 assert.deepEqual(appliedDirectoryFilters('confrere',{apostolate_code:'unknown'},{}),[]);
});

test('directory responses include readable summaries for the exact validated query', async () => {
 const prisma={...db,$queryRaw:async sql=>sql.text.includes('count(*)')?[{total:0}]:[],$transaction:async jobs=>Promise.all(jobs)};
 const result=await fetchDirectory(prisma,'confrere',{page:1,pageSize:20,apostolate_code:'A1',designation_code:'DES'},['P1']);
 assert.deepEqual(result.appliedFilters,[{field:'designation_code',values:['Superior']},{field:'apostolate_code',values:['Education']}]);
 assert.equal(result.total,0);
});
