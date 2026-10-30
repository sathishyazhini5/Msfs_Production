import xlsx from 'xlsx';
import {readCentreSheet} from '../src/utils/centreExcelReader.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {directorySql,parseDirectoryQuery} from '../src/services/estatusService.js';
import {centreIdentifier} from '../src/utils/centreIdentifiers.js';
import {upcomingAnniversaries} from '../src/services/upcomingAnniversaries.js';
test('exact obituary date takes precedence; month and year support all combinations',()=>{
  const exact=directorySql('obituary',parseDirectoryQuery('obituary',{death_date:'2026-01-01',month:'12',year:'2025'}),['P1']);
  assert.ok(exact.count.values.includes('2026-01-01'));assert.ok(!exact.count.values.some(value=>value instanceof Date));
  const month=directorySql('obituary',parseDirectoryQuery('obituary',{month:'12'}),['P1']);assert.match(month.count.text,/EXTRACT\(MONTH/);
  for(const input of [{year:'2026'},{month:'12',year:'2026'}]){
    const sql=directorySql('obituary',parseDirectoryQuery('obituary',input),['P1']);const dates=sql.count.values.filter(value=>value instanceof Date);
    assert.equal(dates.length,2);assert.equal(dates[1].toISOString(),'2026-12-31T18:30:00.000Z');
    assert.equal(dates[0].toISOString(),input.month?'2026-11-30T18:30:00.000Z':'2025-12-31T18:30:00.000Z');
  }
});
test('identifier normalization preserves zeros, prefixes and postal text and rejects lost precision',()=>{
  assert.equal(centreIdentifier('001 234','Pin / Zipcode'),'001 234');
  assert.equal(centreIdentifier('SW1A 1AA','Pin / Zipcode'),'SW1A 1AA');
  assert.equal(centreIdentifier('+44 (0)123 456','phone1_no'),'+44 (0)123 456');
  assert.equal(centreIdentifier('1.2345e9','phone1_no'),'1234500000');
  assert.equal(centreIdentifier('','phone2_no'),null);
  assert.throws(()=>centreIdentifier(1e15,'phone1_no'),/precision/);
});
test('anniversaries retain correct ordering through year boundaries and filter by type',()=>{
  const rows=upcomingAnniversaries([{confrer_code:'C1',province_code:'P1',first_name:'A',birth_date:'1980-01-01',ordination_date:'2000-12-31'}],'2026-12-30');
  assert.deepEqual(rows.map(row=>row.next_date),['2026-12-31','2027-01-01']);
  assert.equal(rows.filter(row=>row.type==='Birthday').length,1);assert.equal(rows.filter(row=>row.type==='Ordination').length,1);
});

test('Excel reader preserves zero masks, normalizes header case, and rejects duplicate/unlabelled columns',()=>{
 const sheet=xlsx.utils.aoa_to_sheet([[' pin / zipcode ','Personal1 Contact'],[1234,1234567890]]);
 sheet.A2.z='000 000';const rows=readCentreSheet(sheet);assert.equal(rows[0]['Pin / Zipcode'],'001 234');assert.equal(rows[0].__rowNum__,1);
 assert.throws(()=>readCentreSheet(xlsx.utils.aoa_to_sheet([['Country',' country '],['A','B']])),/Duplicate/);
 const unlabelled=readCentreSheet(xlsx.utils.aoa_to_sheet([['Country'],['A','data']]));assert.match(unlabelled[0].__parseError,/no header/);
});
