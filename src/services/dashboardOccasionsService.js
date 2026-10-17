import { localCalendar } from './annualWishService.js';
export function eventDateFilter(value = localCalendar().date) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Object.assign(new Error('Date must be YYYY-MM-DD.'),{status:400});
  const start=new Date(value+'T00:00:00Z');
  return {event_date:{gte:start,lt:new Date(start.getTime()+86400000)}};
}
export function calendarMonth(value) {
  const month=value || localCalendar().date.slice(0,7);
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||Number(month.slice(0,4))<1000||Number(month.slice(0,4))>9998)throw Object.assign(new Error('Month must be YYYY-MM.'),{status:400});
  const [year,m]=month.split('-').map(Number);
  const end=`${month}-${String(new Date(Date.UTC(year,m,0)).getUTCDate()).padStart(2,'0')}`;
  const next=m===12?`${year+1}-01-01`:`${year}-${String(m+1).padStart(2,'0')}-01`;
  return {month,start:`${month}-01`,end,next};
}
export async function loadDashboardOccasions(db, provinceCodes, input) {
  const range=calendarMonth(input);
  const where=provinceCodes===null?{}:{province_code:{in:provinceCodes}};
  // Stored business dates are timestamp-without-timezone calendar dates.
  const events=await db.event_dtl.findMany({where:{...where,event_date:{gte:new Date(range.start+'T00:00:00Z'),lt:new Date(range.next+'T00:00:00Z')}},orderBy:[{event_date:'asc'},{event_id:'asc'}]});
  return {month:range.month,today:localCalendar().date,timezone:process.env.APP_TIMEZONE || 'Asia/Kolkata',events:events.map(event=>({...event,event_date:new Date(event.event_date).toISOString().slice(0,10)}))};
}
