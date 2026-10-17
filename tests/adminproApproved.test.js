import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectoryQuery, directorySql } from '../src/services/estatusService.js';
import { assertCongregationAccess, DEACTIVATED_MESSAGE } from '../src/services/congregationAccess.js';
import { withExploreMore, EXPLORE_URL } from '../src/services/emailFooter.js';
import { upcomingAnniversaries } from '../src/services/upcomingAnniversaries.js';
import { database, response, loadController } from './helpers/controllerHarness.js';
import { createAuthenticate } from '../src/middlewares/authenticate.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/index.js';

test('obituary month/year overrides today and shares count/rows boundaries and tenant/search conditions', () => {
  const filters = parseDirectoryQuery('obituary', {month:'12',year:'2026',mode:'today',search:'Mary',province_code:'P1'});
  const sql = directorySql('obituary', filters, ['P1']);
  for (const query of [sql.count,sql.rows]) {
    assert.ok(!query.text.includes('CURRENT_TIMESTAMP'));
    assert.ok(query.values.some(v => v instanceof Date && v.toISOString() === '2026-11-30T18:30:00.000Z'));
    assert.ok(query.values.some(v => v instanceof Date && v.toISOString() === '2026-12-31T18:30:00.000Z'));
    assert.ok(query.values.includes('%Mary%'));
    assert.ok(query.values.includes('P1'));
  }
  const month = directorySql('obituary', parseDirectoryQuery('obituary',{month:'2'}),['P1']);
  assert.match(month.count.text,/EXTRACT\(MONTH/);
  assert.ok(!month.count.text.includes('CURRENT_TIMESTAMP'));
  const year = directorySql('obituary',parseDirectoryQuery('obituary',{year:'2026'}),['P1']);
  assert.equal(year.count.values.filter(v=>v instanceof Date).length,2);
  assert.match(directorySql('obituary',parseDirectoryQuery('obituary',{}),['P1']).count.text,/CURRENT_TIMESTAMP/);
  for (const query of [{month:'0'},{month:'13'},{month:'1.2'},{year:'20'},{year:'9999'},{month:['2']}]) assert.throws(()=>parseDirectoryQuery('obituary',query));
});

test('deactivation resolves current account/province ownership and leaves other congregations/platform access intact', async () => {
  let status='Inactive';
  const db={users_mst:{findFirst:async({where})=>({user_id:where.user_id,prov_concre_code:'P1',role_code:'RN003'})},province_mst:{findFirst:async()=>({concretion_code:'conc1'})},concretion_defination_mst:{findFirst:async({where})=>where.concretion_code==='conc1'?{concretion_code:'conc1',status}:null}};
  await assert.rejects(assertCongregationAccess(db,{user_id:'user'}),e=>e.status===403 && e.message===DEACTIVATED_MESSAGE);
  status='Active'; await assertCongregationAccess(db,{user_id:'user'});
  status='Inactive'; await assertCongregationAccess({...db,users_mst:{findFirst:async()=>({role_code:'RN001'})}},{user_id:'super'});
  await assertCongregationAccess({...db,province_mst:{findFirst:async()=>({concretion_code:'conc2'})}},{user_id:'other'});
});

test('email footer preserves action links, subject and recipient in HTML and text without sending', () => {
  const output=withExploreMore({to:'mock@example.test',subject:'Reset password',html:'<body><a href="https://example.test/reset?token=abc">Reset</a></body>',text:'Reset: https://example.test/reset?token=abc'});
  assert.equal(output.subject,'Reset password'); assert.equal(output.to,'mock@example.test');
  assert.match(output.html,/reset\?token=abc/); assert.match(output.text,/reset\?token=abc/);
  assert.ok(output.html.includes(EXPLORE_URL)); assert.ok(output.text.includes(EXPLORE_URL));
  assert.ok(output.html.indexOf('Explore More')<output.html.indexOf('</body>'));
});

test('real login controller blocks inactive congregation and province accounts before issuing tokens', async () => {
  const congregation={concretion_code:'conc1',status:'Inactive'};
  const db=database({users_mst:[{user_id:'province@example.test',password:'test-only',prov_concre_code:'P1',role_code:'RN003',role_name:'province admin'}],province_mst:[{province_code:'P1',concretion_code:'conc1',province_name:'Province'}],concretion_defination_mst:[congregation],quickcode_mst:[{quick_code:'RN003',quick_code_type:'rolnam',quickcode_name:'province admin'}]});
  const {login}=await loadController('../../src/controllers/auth/userlogin.js',db);
  const res=response();let error;
  await login({body:{user_id:'province@example.test',password:'test-only'}},res,e=>{error=e;});
  assert.equal(error?.status,403);assert.equal(error.message,DEACTIVATED_MESSAGE);assert.equal(res.body,undefined);
  congregation.status='Active';error=undefined;
  await login({body:{user_id:'province@example.test',password:'test-only'}},res,e=>{error=e;});
  assert.equal(error,undefined);assert.ok(res.body.accessToken);
});

test('existing access tokens are denied immediately after deactivation; refresh tokens cannot access protected data', async () => {
  const congregation={concretion_code:'conc1',status:'Active'};
  const db=database({users_mst:[{user_id:'user',prov_concre_code:'P1',role_code:'RN003'}],province_mst:[{province_code:'P1',concretion_code:'conc1'}],concretion_defination_mst:[congregation]});
  const authenticate=createAuthenticate(db);
  const token=jwt.sign({user_id:'user',role_name:'province admin',province_code:'P1'},JWT_SECRET,{expiresIn:'1h'});
  const req={cookies:{},header:()=>`Bearer ${token}`};let calls=0;
  await authenticate(req,response(),()=>{calls++;});assert.equal(calls,1);
  congregation.status='Inactive';const denied=response();
  await authenticate(req,denied,()=>{calls++;});assert.equal(calls,1);assert.equal(denied.statusCode,403);assert.equal(denied.body.code,'CONGREGATION_INACTIVE');
  congregation.status='Active';await authenticate(req,response(),()=>{calls++;});assert.equal(calls,2);
  const refresh=jwt.sign({user_id:'user',token_use:'refresh'},JWT_SECRET,{expiresIn:'7d'}),refreshResponse=response();
  await authenticate({cookies:{},header:()=>`Bearer ${refresh}`},refreshResponse,()=>assert.fail());assert.equal(refreshResponse.statusCode,401);
});

test('anniversaries roll into January, skip invalid leap dates and exclude same-year ordinations', () => {
  const rows=upcomingAnniversaries([{confrer_code:'C1',first_name:'A',province_code:'P1',birth_date:'1990-01-02',ordination_date:'2026-12-31'},{scholastic_code:'S1',province_code:'P1',birth_date:'2000-02-29'}],'2026-12-31');
  assert.equal(rows.find(r=>r.code==='C1'&&r.type==='Birthday').next_date,'2027-01-02');
  assert.equal(rows.find(r=>r.type==='Ordination').next_date,'2027-12-31');
  assert.equal(rows.find(r=>r.code==='S1').next_date,'2028-02-29');
});

test('upcoming anniversary controller restricts province and congregation visibility on the server', async () => {
  const db=database({province_mst:[{province_code:'P1',concretion_code:'conc1'},{province_code:'P2',concretion_code:'conc2'}],confreres_dtl:[{confrer_code:'C1',province_code:'P1',first_name:'Own member',birth_date:new Date('1980-01-01'),is_active:true},{confrer_code:'C2',province_code:'P2',first_name:'Other member',birth_date:new Date('1980-01-01'),is_active:true}],scholastics_dtl:[]});
  const {getUpcomingAnniversaries}=await loadController('../../src/controllers/Msfs/anniversarynotification.js',db);
  const token=jwt.sign({user_id:'admin',role_name:'congregation admin',concretion_code:'conc1'},JWT_SECRET,{expiresIn:'1h'});
  const res=response();let error;
  await getUpcomingAnniversaries({headers:{authorization:`Bearer ${token}`},query:{}},res,e=>{error=e;});
  assert.equal(error,undefined);assert.deepEqual(res.body.map(row=>row.name),['Own member']);
  await getUpcomingAnniversaries({headers:{authorization:`Bearer ${token}`},query:{province_code:'P2'}},response(),e=>{error=e;});assert.equal(error.status,403);
});
