import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCentreExcelRow } from '../src/utils/centreExcelUpload.js';

const row = {
  'Division Type': ' Region ', 'Name of the Division': 'North', 'Apostolate Name': 'Education',
  'Center Type': 'School', 'Community House': 'Home', Diocese: 'Diocese',
  'Name of the Center': 'Centre', 'Place of the Center': 'Town', 'Address 1': 'Street',
  'Address 2': 'Town', Country: 'India', State: 'State', 'City/District': 'City',
  'Pin / Zipcode': 123456, 'Personal1 ISD': '+91', 'Personal1 Contact': '1234567890',
  'Office MailId 1': 'office@example.com',
};
const context = { provinceCode: 'P01', provinceCodes: ['P01'], createdBy: 'tester' };
function database(failCentre = false) {
  let tables = {
    province_mst: [{ province_code: 'P01' }],
    country_mst: [{ province_code: 'P01', country_name: ' India ', country_code: 'IN' }],
    state_mst: [{ province_code: 'P01', country_code: 'IN', state_name: 'State', state_code: 'ST' }],
    quickcode_mst: [{ quick_code_type: 'divtyp', quick_code: 'D001', quickcode_name: ' REGION ' },
      { quick_code_type: 'other', quick_code: 'D001', quickcode_name: 'Education' }],
    division_setup_mst: [{ province_code: 'P01', division_type_code: 'D001', division_code: 'DIV', division_name: 'North' }],
    community_house_dtl: [], apostolates_mst: [], centre_dtl: [],
  };
  return {
    get tables() { return tables; },
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      const pending = structuredClone(tables);
      const db = Object.fromEntries(Object.keys(pending).map(model => [model, {
        async findMany({ where = {} } = {}) {
          return pending[model].filter(record => Object.entries(where).every(([key, value]) => record[key] === value));
        },
        async findFirst(args) { return (await this.findMany(args))[0]; },
        async findUnique(args) { return this.findFirst(args); },
        async update({where,data}) {
          const identity=Object.values(where)[0];
          const record=pending[model].find(item=>Object.entries(identity).every(([key,value])=>item[key]===value));
          if(!record)throw new Error('Missing record');Object.assign(record,data);return record;
        },
        async create({ data }) {
          if (model === 'centre_dtl' && failCentre) throw new Error('Centre save failed');
          pending[model].push(data);
          return data;
        },
      }]));
      const result = await callback(db);
      tables = pending;
      return result;
    },
  };
}

test('creates correct categories, scoped mapping and house; reuses normalized names', async () => {
  const db = database();
  await saveCentreExcelRow(db, row, context);
  await saveCentreExcelRow(db, { ...row, 'Name of the Center': ' CENTRE ', 'Personal1 Contact': '1234567891', 'Apostolate Name': ' education ', 'Community House': ' HOME ' }, context);
  assert.equal(db.tables.quickcode_mst.length, 5);
  assert.equal(db.tables.community_house_dtl.length, 1);
  assert.equal(db.tables.apostolates_mst.length, 1);
  assert.equal(db.tables.centre_dtl.length, 2);
  const centre = db.tables.centre_dtl[0];
  assert.equal(centre.apostolate_code, db.tables.quickcode_mst.find(q => q.quick_code_type === 'apostl').quick_code);
  assert.equal(centre.community_house_code, 'CH001P01');
  await saveCentreExcelRow(db, { ...row, 'Name of the Center': 'Different', 'Office MailId 1': 'different@example.com', 'Personal1 Contact': '1234567890' }, context);
  assert.equal(db.tables.centre_dtl.length, 3);
});

test('failed centre rolls back all newly created masters and mappings', async () => {
  const db = database(true);
  await assert.rejects(saveCentreExcelRow(db, row, context), /Centre save failed/);
  assert.equal(db.tables.quickcode_mst.length, 2);
  assert.equal(db.tables.community_house_dtl.length, 0);
  assert.equal(db.tables.apostolates_mst.length, 0);
});

test('missing required values, invalid numbers and unauthorized provinces fail', async () => {
  const db = database();
  await assert.rejects(saveCentreExcelRow(db, { ...row, 'Address 1': '  ' }, context), /Missing required fields: Address 1/);
  await assert.rejects(saveCentreExcelRow(db, row, { ...context, provinceCodes: ['P02'] }), /authorized scope/);
  assert.equal(db.tables.centre_dtl.length, 0);
});

test('Excel resolves Tamilnadu to global Tamil Nadu without creating a state', async () => {
  const db = database();
  db.tables.state_mst[0] = { province_code: 'ALL', country_code: 'IN', state_name: 'Tamil Nadu', state_code: 'IN-TN' };
  await saveCentreExcelRow(db, { ...row, State: 'Tamilnadu' }, context);
  assert.equal(db.tables.centre_dtl[0].state_code, 'IN-TN');
  assert.equal(db.tables.state_mst.length, 1);
});

test('missing scoped division is created from the supplied name and reused', async () => {
  const db = database();
  db.tables.division_setup_mst.length = 0;
  await saveCentreExcelRow(db, row, context);
  await saveCentreExcelRow(db, { ...row, 'Name of the Center': 'Second', 'Personal1 Contact': '1234567891' }, context);
  assert.equal(db.tables.division_setup_mst.length, 1);
  assert.equal(db.tables.division_setup_mst[0].division_code, 'D1');
  assert.equal(db.tables.centre_dtl[0].division_code, 'D1');
  assert.equal(db.tables.community_house_dtl.length, 1);
});

 test('text postal/contact formatting survives and identical retry is idempotent',async()=>{
  const db=database();const source={...row,'Pin / Zipcode':' SW1A 1AA ','Personal1 Contact':'+044 01234 567890','Personal2 Contact':''};
  await saveCentreExcelRow(db,source,context);await saveCentreExcelRow(db,source,context);
  assert.equal(db.tables.centre_dtl.length,1);assert.equal(db.tables.centre_dtl[0].pin_zipcode,' SW1A 1AA ');assert.equal(db.tables.centre_dtl[0].phone1_no,'+044 01234 567890');assert.equal(db.tables.centre_dtl[0].phone2_no,'');
 });
 test('numeric precision loss fails before creating masters',async()=>{
  const db=database();await assert.rejects(saveCentreExcelRow(db,{...row,'Personal1 Contact':1234567890123456},context),/precision/);assert.equal(db.tables.quickcode_mst.length,2);
 });

test('manual edit uses the same identifier validation and saves new masters atomically',async()=>{
 const db=database();await saveCentreExcelRow(db,row,context);
 const existing=db.tables.centre_dtl[0];const centreIdentity=Object.fromEntries(['centre_code','province_code','division_type_code','division_code'].map(key=>[key,existing[key]]));
 await saveCentreExcelRow(db,{...row,'Pin / Zipcode':'001 234',Diocese:'New Diocese'},{...context,centreIdentity});
 assert.equal(db.tables.centre_dtl.length,1);assert.equal(db.tables.centre_dtl[0].pin_zipcode,'001 234');
 assert.equal(db.tables.centre_dtl[0].diocese_code,db.tables.quickcode_mst.find(item=>item.quickcode_name==='New Diocese').quick_code);
});
test('new countries and states use scoped dedicated masters with unknown ISD left blank',async()=>{
 const db=database();const source={...row,Country:'New Country',State:'New State'};
 await saveCentreExcelRow(db,source,context);
 assert.equal(db.tables.country_mst[1].ISD_code,'');assert.equal(db.tables.state_mst[1].ISD_code,'');
 assert.equal(db.tables.country_mst.length,2);assert.equal(db.tables.state_mst.length,2);
 assert.equal(db.tables.centre_dtl[0].country_code,'CT001');assert.equal(db.tables.centre_dtl[0].state_code,'ST001');
 assert.equal(db.tables.quickcode_mst.some(item=>item.quickcode_name==='New Country'),false);
});
test('serializable allocation conflicts retry without creating duplicate masters or Centres',async()=>{
 const db=database();const transaction=db.$transaction.bind(db);let attempts=0;
 db.$transaction=async(...args)=>{if(attempts++===0)throw Object.assign(new Error('Concurrent write'),{code:'P2034'});return transaction(...args);};
 await saveCentreExcelRow(db,row,context);assert.equal(attempts,2);assert.equal(db.tables.centre_dtl.length,1);assert.equal(db.tables.community_house_dtl.length,1);
});

test('Centre data is stored as supplied: blank postal, unverified emails and shared contacts are accepted',async()=>{
 const db=database();
 const source={...row,'Pin / Zipcode':'','Office MailId 1':'office@example','Address 2':'Mixed  Case Place','Personal1 Contact':'93846 62915'};
 await saveCentreExcelRow(db,source,context);
 await saveCentreExcelRow(db,{...source,'Name of the Center':'Second Centre'},context);
 await saveCentreExcelRow(db,source,context);
 assert.equal(db.tables.centre_dtl.length,2);
 const saved=db.tables.centre_dtl[0];assert.equal(saved.pin_zipcode,'');assert.equal(saved.office_mailid1,'office@example');assert.equal(saved.address2,'Mixed  Case Place');assert.equal(saved.phone1_no,'93846 62915');
});
test('manual edit can use another Centre contact without blocking either record',async()=>{
 const db=database();await saveCentreExcelRow(db,row,context);await saveCentreExcelRow(db,{...row,'Name of the Center':'Second','Personal1 Contact':'77777'},context);
 const existing=db.tables.centre_dtl[1];const centreIdentity=Object.fromEntries(['centre_code','province_code','division_type_code','division_code'].map(key=>[key,existing[key]]));
 await saveCentreExcelRow(db,{...row,'Name of the Center':'Second'},{...context,centreIdentity});
 assert.equal(db.tables.centre_dtl.length,2);assert.equal(db.tables.centre_dtl[1].phone1_no,'1234567890');
});
