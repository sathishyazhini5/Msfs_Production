import xlsx from 'xlsx';
const labels = ['Province','Division Type','Name of the Division','Apostolate/Department','Apostolate Name','Centre Type','Center Type','Centre Type Name','Community House','Name of the Diocese','Diocese','Name of the Centre','Name of the Center','Place of the Centre','Place of the Center','Address 1','Address 2','Address 3','Country','State','Country ISD','State ISD','City/District','Pin / Zipcode','Concurrency Value',...['Personal1','Personal2','Personal3','Mobile1','Mobile2','Mobile3','Fax'].flatMap(prefix=>[`${prefix} ISD`,`${prefix} Contact`]),'WhatsApp ISD','WhatsApp no',...[1,2,3].flatMap(index=>[`Office MailId ${index}`,`Official Website ${index}`])];
const normalized=value=>String(value || '').trim().replace(/\s+/g,' ').toLowerCase();
export function readCentreSheet(sheet) {
  const range=xlsx.utils.decode_range(sheet['!ref'] || 'A1');
  const matrix=xlsx.utils.sheet_to_json(sheet,{header:1,defval:null,range:{s:{r:range.s.r,c:0},e:range.e}});
  const headers=matrix[0] || [], seen=new Set();
  const canonical=headers.map(header=>{
    const key=normalized(header);
    if(key && seen.has(key))throw new Error(`Duplicate Excel header: ${header}`);
    seen.add(key);return labels.find(label=>normalized(label)===key) || String(header || '').trim();
  });
  const rows=xlsx.utils.sheet_to_json(sheet);
  return rows.map(source=>{
    const result={};
    Object.defineProperty(result,'__rowNum__',{value:source.__rowNum__});
    const values=matrix[source.__rowNum__-range.s.r] || [];
    for(let col=0;col<Math.max(headers.length,values.length);col++) {
      const cell=sheet[xlsx.utils.encode_cell({r:source.__rowNum__,c:col})];
      if(!cell)continue;
      if(!canonical[col] && cell.v!=='' && cell.v!=null)result.__parseError=`Column ${xlsx.utils.encode_col(col)} contains data but has no header.`;
      else if(canonical[col]) {
        const formatted=cell.t==='n' && Number.isSafeInteger(cell.v) && Math.abs(cell.v)<1e15 && /^[0 ()+-]+$/.test(cell.z || '');
        result[canonical[col]]=formatted?xlsx.utils.format_cell(cell):cell.v;
      }
    }
    return result;
  });
}
