import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { directorySql, parseDirectoryQuery, loadDirectoryOptions } from '../src/services/estatusService.js';

test('eStatus executes Apostolate appointment OR transfer matching with unique results, AND filters and pagination', () => {
 const db = new DatabaseSync(':memory:');
 try {
  db.function('concat_ws', (...args) => args.slice(1).filter(v => v != null).join(args[0]));
  db.function('btrim', value => value.trim());
  db.exec(`
   CREATE TABLE confreres_dtl (confrer_code TEXT, province_code TEXT, first_name TEXT, middle_name TEXT, last_name TEXT, member_type_code TEXT, nationality_code TEXT, image_file_path TEXT, is_active BOOLEAN);
   CREATE TABLE province_mst (province_code TEXT, province_name TEXT);
   CREATE TABLE centre_dtl (centre_code TEXT, province_code TEXT, division_type_code TEXT, division_code TEXT, apostolate_code TEXT, centre_type_code TEXT);
   CREATE TABLE apostolates_mst (province_code TEXT, apostolate_code TEXT, centre_type_code TEXT);
   CREATE TABLE appoint_transfer_dtl (confrer_code TEXT, centre_code TEXT, province_code TEXT, division_type_code TEXT, division_code TEXT, mode TEXT, designation_code TEXT, is_active BOOLEAN);
   CREATE TABLE appoint_transfer_his_dtl AS SELECT * FROM appoint_transfer_dtl WHERE FALSE;
   INSERT INTO province_mst VALUES ('P1','Province');
   INSERT INTO apostolates_mst VALUES ('P1','A1','CT');
   INSERT INTO centre_dtl VALUES ('C','P1','T','D','A1','CT');
   INSERT INTO confreres_dtl VALUES
    ('F1','P1','Appointment',NULL,NULL,'M','N',NULL,TRUE),
    ('F2','P1','Transfer',NULL,NULL,'M','N',NULL,TRUE),
    ('F3','P1','Both',NULL,NULL,'M','N',NULL,TRUE),
    ('F4','P1','Neither',NULL,NULL,'M','N',NULL,TRUE),
    ('F5','P1','Wrong key',NULL,NULL,'M','N',NULL,TRUE),
    ('F6','P1','Archived',NULL,NULL,'M','N',NULL,TRUE);
   INSERT INTO appoint_transfer_dtl VALUES
    ('F1','C','P1','T','D','By Appointment','DES',TRUE),
    ('F1','C','P1','T','D','By Appointment','DES',TRUE),
    ('F2','C','P1','T','D','By Transfer','DES',TRUE),
    ('F3','C','P1','T','D','By Appointment','DES',TRUE),
    ('F3','C','P1','T','D','By Transfer','DES',TRUE),
    ('F5','C','P1','T','OTHER','By Transfer','DES',TRUE);
   INSERT INTO appoint_transfer_his_dtl VALUES ('F6','C','P1','T','D','By Transfer','DES',TRUE);
  `);
  const run = (input = {}, scope = ['P1']) => {
   const sql = directorySql('confrere', parseDirectoryQuery('confrere', input), scope);
   // Only PostgreSQL syntax is adapted; execute the generated joins, EXISTS and predicates.
   const execute = query => db.prepare(query.text.replace(/::int/g, '').replace(/ILIKE/g, 'LIKE').replace(/\$\d+/g, '?')).all(...query.values);
   return {records:execute(sql.rows),total:execute(sql.count)[0].total};
  };
  assert.deepEqual(run({apostolate_code:'A1'}).records.map(r=>r.code),['F1','F6','F3','F2']);
  assert.equal(run({apostolate_code:'A1'}).total,4);
  assert.equal(run({apostolate_code:'NONE'}).total,0);
  assert.equal(run({apostolate_code:'A1',search:'Neither'}).total,0);
  assert.equal(run({apostolate_code:'A1',search:'Transfer',member_type_code:'M',nationality_code:'N',designation_code:'DES',division:JSON.stringify(['P1','T','D'])}).total,1);
  assert.equal(run({apostolate_code:'A1',member_type_code:'OTHER'}).total,0);
  assert.equal(run({apostolate_code:'A1',page:'2',pageSize:'2'}).records.length,2);
  assert.equal(run({apostolate_code:'A1',page:'2',pageSize:'2'}).total,4);
  assert.equal(run({apostolate_code:''}).total,6);
  assert.equal(run({apostolate_code:'A1'},[]).total,0);
 } finally {db.close();}
});

test('Confrere Apostolate options come from master IDs in selected scope, including unused masters', async () => {
 const prisma = {
  province_mst:{findMany:async()=>[]}, division_setup_mst:{findMany:async()=>[]}, quickcode_mst:{findMany:async()=>[]},
  apostolates_mst:{findMany:async({where})=>{assert.deepEqual(where,{province_code:'P1'});return [{apostolate_code:'A1',apostolate_name:'Education'},{apostolate_code:'A1',apostolate_name:'Education'},{apostolate_code:'EMPTY',apostolate_name:'Unused'}];}},
 };
 const options = await loadDirectoryOptions(prisma,'confrere',['P1'],{province_code:'P1'});
 assert.deepEqual(options.apostolate_code,[{value:'A1',label:'Education'},{value:'EMPTY',label:'Unused'}]);
});

