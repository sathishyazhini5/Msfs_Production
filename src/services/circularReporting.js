import {fault} from './circularService.js';
export const centreIdentity=row=>JSON.stringify([row.province_code,row.division_type_code,row.division_code,row.centre_code]);
export async function recipientCentreSnapshots(db,codes,confreres,scholastics) {
  const where={province_code:{in:codes}};
  const [centres,masters,appointments,admissions]=await Promise.all([
    db.centre_dtl?.findMany({where}) || [],db.apostolates_mst?.findMany({where}) || [],
    db.appoint_transfer_dtl?.findMany({where:{...where,is_active:true,confrer_code:{in:confreres}}}) || [],
    db.scholastics_admisn_promon_dtl?.findMany({where:{...where,end_date:null,scholastic_code:{in:scholastics}}}) || [],
  ]);
  const map=new Map(centres.map(c=>[centreIdentity(c),{centre_code:c.centre_code,centre_name:c.centre_name || c.centre_code,province_code:c.province_code,division_type_code:c.division_type_code,division_code:c.division_code,centre_type_code:c.centre_type_code || null,centre_type_name:masters.find(m=>m.province_code===c.province_code&&m.apostolate_code===c.apostolate_code&&m.centre_type_code===c.centre_type_code)?.centre_type_name || c.centre_type_code || null}]));
  const links=new Map();
  for(const a of [...appointments,...admissions]) {
    const key=JSON.stringify([a.confrer_code?'Confrere':'Scholastics',a.province_code,a.confrer_code || a.scholastic_code]),centre=map.get(centreIdentity(a));
    if(centre){if(!links.has(key))links.set(key,new Map());links.get(key).set(centreIdentity(a),centre);}
  }
  return (category,province,person)=>[...(links.get(JSON.stringify([category==='Curia'?'Confrere':category,province,person]))?.values() || [])].sort((a,b)=>centreIdentity(a).localeCompare(centreIdentity(b)));
}
export function matchesRecipient(row,input) {
  const sources=row.snapshot?.sources || [];
  return sources.some(s=>(!input.province || s.province_code===input.province)&&(!input.centreType || (s.centres || []).some(c=>c.centre_type_code===input.centreType)));
}
export function recipientCounts(rows) {
  return {total:rows.length,sent:rows.filter(r=>r.status==='Sent').length,failed:rows.filter(r=>r.status==='Failed').length,pending:rows.filter(r=>['Queued','Processing'].includes(r.status)).length,unknownSnapshots:rows.filter(r=>!r.snapshot?.sources?.length || r.snapshot.sources.some(s=>s.snapshotVersion!==2)).length};
}
export function validateHistoryFilters(input) {
  if(input.circularType && !['Circular','Newsletter','Others'].includes(input.circularType))throw fault('Invalid circular type.');
  for(const key of ['province','centreType'])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>50))throw fault(`Invalid ${key}.`);
  if(input.sort && !['created_at','subject','status','circular_type'].includes(input.sort))throw fault('Invalid circular sort.');
  if(input.direction && !['asc','desc'].includes(input.direction))throw fault('Invalid sort direction.');
}
export function circularReport(rows,recipients,input,branding) {
  const detailed=input.report==='recipients';
  if(input.report && !['campaigns','recipients'].includes(input.report))throw fault('Invalid report.');
  const columns=detailed?[['subject','Circular'],['type','Type'],['name','Name'],['email','Email'],['provinces','Provinces (all sources)'],['centres','Centres (all sources)'],['centreTypes','Centre types (all sources)'],['snapshot','Snapshot'],['status','Send status'],['attempts','Attempts'],['sentAt','Accepted by provider'],['error','Result']]:[['subject','Circular'],['type','Type'],['status','Status'],['created','Created'],['matching','Matching recipients'],['matchingSent','Matching sent'],['matchingFailed','Matching failed'],['total','Campaign recipients'],['sent','Campaign sent'],['failed','Campaign failed'],['unknown','Missing centre snapshots']];
  const records=detailed?rows.flatMap(c=>recipients.filter(r=>r.circular_id===c.id&&(!(input.province||input.centreType)||matchesRecipient(r,input))).map(r=>({subject:c.subject,type:c.circular_type || 'Circular',name:r.snapshot?.name,email:r.email,provinces:[...new Set((r.snapshot?.sources || []).map(s=>s.province || s.province_code))].join(', '),centres:[...new Set((r.snapshot?.sources || []).flatMap(s=>s.centres || []).map(x=>x.centre_name))].join(', '),centreTypes:[...new Set((r.snapshot?.sources || []).flatMap(s=>s.centres || []).map(x=>x.centre_type_name))].join(', '),snapshot:r.snapshot?.sources?.length&&(r.snapshot.sources).every(s=>s.snapshotVersion===2)?'Recorded at queue':'Legacy / unknown centre snapshot',status:r.status,attempts:r.attempts,sentAt:r.sent_at?.toISOString?.() || r.sent_at || '',error:r.last_error || ''}))):rows.map(c=>({subject:c.subject,type:c.circular_type || 'Circular',status:c.status,created:c.created_at?.toISOString?.() || c.created_at,matching:c.matchingCounts.total,matchingSent:c.matchingCounts.sent,matchingFailed:c.matchingCounts.failed,total:c.recipient_count,sent:c.sent_count,failed:c.failed_count,unknown:c.totalCounts.unknownSnapshots}));
  const summary=recipientCounts(recipients.filter(r=>rows.some(c=>c.id===r.circular_id)&&(!(input.province||input.centreType)||matchesRecipient(r,input))));
  const sourceSnapshots=recipients.flatMap(r=>r.snapshot?.sources || []);
  const labels={search:'Search',province:'Province',centreType:'Centre type',circularType:'Circular type',status:'Send status',from:'From date',to:'To date'};
  const filterLabel=key=>{let names=[];if(key==='province')names=sourceSnapshots.filter(s=>s.province_code===input[key]).map(s=>s.province || s.province_code);if(key==='centreType')names=sourceSnapshots.flatMap(s=>s.centres || []).filter(c=>c.centre_type_code===input[key]).map(c=>c.centre_type_name || c.centre_type_code);return `${labels[key]}: ${[...new Set(names)].join(' / ') || input[key]}`;};
  return {title:detailed?'Circular recipient status report':'Circular history report',branding,generatedAt:new Date().toISOString(),total:records.length,summary,columns:columns.map(([key,title])=>({key,title})),records,appliedFilters:[...['search','province','centreType','circularType','status','from','to'].filter(k=>input[k]).map(filterLabel),`Sort: ${input.sort || 'created_at'} ${input.direction || 'desc'}`,`Matching recipients: ${summary.total}; sent: ${summary.sent}; failed: ${summary.failed}; pending: ${summary.pending}; missing centre snapshots: ${summary.unknownSnapshots}`]};
}
