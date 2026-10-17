import { localCalendar } from './annualWishService.js';

export function anniversaryOccurrences(people, start, end) {
  const rows=[];
  for(const person of people) for(const [type,field] of [['Birthday','birth_date'],['Ordination','ordination_date']]) {
    if(!person[field])continue;
    const original=new Date(person[field]).toISOString().slice(0,10);
    for(let year=Number(start.slice(0,4));year<=Number(end.slice(0,4));year++) {
      const date=`${year}-${original.slice(5)}`;
      if(date<start || date>end || date<original || (type==='Ordination' && year<=Number(original.slice(0,4))))continue;
      if(new Date(date).toISOString().slice(0,10)!==date)continue;
      rows.push({code:person.confrer_code || person.scholastic_code,kind:person.confrer_code?'confrere':'scholastic',province_code:person.province_code,name:[person.first_name,person.middle_name,person.last_name].filter(Boolean).join(' '),type,next_date:date});
    }
  }
  return rows.sort((a,b)=>a.next_date.localeCompare(b.next_date)||a.name.localeCompare(b.name));
}

// Use the same supported dates and ordination eligibility as annual wishes.
export function upcomingAnniversaries(people, today = localCalendar().date) {
  const rows = [];
  for (const person of people) for (const [type, field] of [['Birthday', 'birth_date'], ['Ordination', 'ordination_date']]) {
    if (!person[field]) continue;
    const original = new Date(person[field]).toISOString().slice(0, 10);
    if (original > today) continue;
    let year = Number(today.slice(0, 4));
    for (let attempt = 0; attempt < 9; attempt++, year++) {
      const next = `${year}-${original.slice(5)}`;
      if (next < today || (type === 'Ordination' && year <= Number(original.slice(0, 4)))) continue;
      if (new Date(next).toISOString().slice(0, 10) !== next) continue;
      rows.push({ code: person.confrer_code || person.scholastic_code, kind: person.confrer_code ? 'confrere' : 'scholastic', province_code: person.province_code, name: [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' '), type, next_date: next });
      break;
    }
  }
  return rows.sort((a, b) => a.next_date.localeCompare(b.next_date) || a.name.localeCompare(b.name));
}
