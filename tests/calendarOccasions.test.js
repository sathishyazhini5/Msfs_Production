import test from 'node:test';
import assert from 'node:assert/strict';
import {anniversaryOccurrences} from '../src/services/upcomingAnniversaries.js';
import {calendarMonth,loadDashboardOccasions,eventDateFilter} from '../src/services/dashboardOccasionsService.js';
test('recurring month/day eligibility, two types, leap days and year rollover preserve calendar dates',()=>{
 const people=[{confrer_code:'C1',first_name:'First',province_code:'P1',birth_date:'1980-01-01',ordination_date:'2000-01-01'},{scholastic_code:'S1',province_code:'P1',birth_date:'2000-02-29'}];
 assert.equal(anniversaryOccurrences(people,'2026-12-01','2026-12-31').length,0);
 assert.deepEqual(anniversaryOccurrences(people,'2027-01-01','2027-01-31').map(a=>a.type),['Birthday','Ordination']);
 assert.equal(anniversaryOccurrences(people,'2027-02-01','2027-02-28').length,0);
 assert.equal(anniversaryOccurrences(people,'2028-02-01','2028-02-29')[0].next_date,'2028-02-29');
 assert.equal(calendarMonth('2026-12').next,'2027-01-01');
 for(const value of ['2026-13','invalid',['2026-01'],'0000-01'])assert.throws(()=>calendarMonth(value));
});
test('event calendar uses one scoped event query without loading anniversaries',async()=>{
 const calls=[];const person={confrer_code:'C1',province_code:'P1',first_name:'Own',birth_date:'1980-10-01'};
 const db={event_dtl:{findMany:async input=>{calls.push(input);return [{event_id:'E1',province_code:'P1',event_date:new Date('2026-10-01T00:00:00Z')}];}},confreres_dtl:{findMany:async input=>{calls.push(input);return [person];}},scholastics_dtl:{findMany:async input=>{calls.push(input);return [];}}};
 const result=await loadDashboardOccasions(db,['P1'],'2026-10');assert.equal(calls.length,1);
 for(const call of calls)assert.deepEqual(call.where.province_code,{in:['P1']});
 assert.equal(result.events[0].event_date,'2026-10-01');assert.equal(result.anniversaries,undefined);
 assert.equal(calls[0].where.event_date.lt.toISOString(),'2026-11-01T00:00:00.000Z');
});

test('event date filtering matches full business date including year and excludes empty/invalid dates',()=>{
 const {event_date}=eventDateFilter('2027-01-01');
 const matches=date=>new Date(date)>=event_date.gte&&new Date(date)<event_date.lt;
 assert.equal(matches('2027-01-01T00:00:00Z'),true);
 assert.equal(matches('2027-01-01T23:59:59Z'),true);
 for(const date of ['2026-01-01T00:00:00Z','2028-01-01T00:00:00Z','2027-01-02T00:00:00Z','2026-12-31T23:59:59Z'])assert.equal(matches(date),false);
 for(const date of ['',null,'2027-02-29','2027-13-01',['2027-01-01']])assert.throws(()=>eventDateFilter(date));
});
test('default event date uses configured application timezone without shifting stored calendar dates',()=>{
 const previous=process.env.APP_TIMEZONE;
 try {
  process.env.APP_TIMEZONE='Pacific/Kiritimati';
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:process.env.APP_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.equal(eventDateFilter().event_date.gte.toISOString().slice(0,10),today);
 } finally {if(previous===undefined)delete process.env.APP_TIMEZONE;else process.env.APP_TIMEZONE=previous;}
});
