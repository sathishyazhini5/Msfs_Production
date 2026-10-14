import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {actor} from './circularService.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const MAX_LOGO_BYTES=2*1024*1024;
export async function congregationCode(db,scope) {
  if(scope.role==='congregation admin') {
    if(!scope.user.concretion_code)throw fail('Congregation identity is missing.',403);
    return scope.user.concretion_code;
  }
  if(scope.role==='province admin') {
    const codes=scope.provinceCodes || [];
    if(codes.length!==1)throw fail('Province identity is missing.',403);
    const p=await db.province_mst.findUnique({where:{province_code:codes[0]},select:{concretion_code:true}});
    if(!p?.concretion_code)throw fail('Congregation identity is missing.',403);
    return p.concretion_code;
  }
  return null;
}
function crc32(buffer) {
  let crc=0xffffffff;
  for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
// Only decoded, bounded RGB/RGBA PNGs reach storage. The UI re-encodes other raster formats.
export function validateLogo(file) {
  const b=file?.buffer;
  if(!b?.length || b.length>MAX_LOGO_BYTES)throw fail('Choose a PNG logo up to 2 MB.');
  if(file.mimetype!=='image/png'||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('Upload a genuine PNG logo.');
  let offset=8,width,height,channels,ended=false;const image=[];
  while(offset+12<=b.length){
    const length=b.readUInt32BE(offset),type=b.subarray(offset+4,offset+8).toString();
    if(length>b.length-offset-12)throw fail('Malformed PNG logo.');
    const bytes=b.subarray(offset+8,offset+8+length);
    if(crc32(b.subarray(offset+4,offset+8+length))!==b.readUInt32BE(offset+8+length))throw fail('Corrupt PNG logo.');
    if(offset===8 && type!=='IHDR')throw fail('Malformed PNG logo.');
    if(type==='IHDR'){
      if(width||length!==13)throw fail('Malformed PNG logo.');
      width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);channels=bytes[9]===6?4:bytes[9]===2?3:0;
      if(!width||!height||width>2000||height>2000||!channels||bytes[8]!==8||bytes[10]||bytes[11]||bytes[12])throw fail('Use a non-interlaced RGB/RGBA PNG up to 2000 × 2000 pixels.');
    } else if(type==='IDAT')image.push(bytes);
    else if(type==='IEND'){if(length)throw fail('Malformed PNG logo.');ended=true;offset+=length+12;break;}
    else if(!['sRGB','gAMA','pHYs','cHRM','tEXt','iTXt','zTXt','bKGD','sBIT'].includes(type))throw fail('Unsupported PNG content. Re-save the logo as PNG.');
    offset+=length+12;
  }
  if(!ended||offset!==b.length||!image.length)throw fail('Malformed PNG logo.');
  try {
    const decoded=inflateSync(Buffer.concat(image),{maxOutputLength:height*(1+width*channels)});
    if(decoded.length!==height*(1+width*channels))throw new Error();
    for(let row=0;row<height;row++)if(decoded[row*(1+width*channels)]>4)throw new Error();
  }catch{throw fail('Invalid PNG image data.');}
  return {mime_type:'image/png',sha256:createHash('sha256').update(b).digest('hex')};
}
export class BrandingService {
  constructor({db,storage}){this.db=db;this.storage=storage;}
  async snapshot(scope) {
    const code=await congregationCode(this.db,scope);
    if(!code)return {name:'MSFS eStatus',concretion_code:null};
    const c=await this.db.concretion_defination_mst.findUnique({where:{concretion_code:code},select:{concretion_name:true}});
    if(!c)throw fail('Congregation not found.',403);
    const logo=await this.db.congregationBranding.findUnique({where:{concretion_code:code}});
    return {name:c.concretion_name || 'Congregation',concretion_code:code,...(logo?.logo_key?{logo_key:logo.logo_key,mime_type:logo.mime_type,sha256:logo.sha256}:{})};
  }
  async public(scope) {
    const snapshot=await this.snapshot(scope);const {logo_key,sha256,mime_type,...branding}=snapshot;
    if(logo_key){const b=await this.storage.download(logo_key);if(createHash('sha256').update(b).digest('hex')!==sha256)throw fail('Logo checksum mismatch.',503);branding.logoDataUrl=`data:${mime_type};base64,${b.toString('base64')}`;}
    return branding;
  }
  async save(scope,file) {
    if(scope.role!=='congregation admin')throw fail('Only Congregation Admin can change its logo.',403);
    const updated_by=actor(scope),data=validateLogo(file),branding=await this.snapshot(scope);
    const key=await this.storage.upload(file.buffer,'congregation-logo.png',data.mime_type);
    try{await this.db.congregationBranding.upsert({where:{concretion_code:branding.concretion_code},create:{concretion_code:branding.concretion_code,...data,logo_key:key,updated_by},update:{...data,logo_key:key,updated_by}});}catch(e){await this.storage.remove(key).catch(()=>{});throw e;}
    // Old versions stay private: queued/sent campaigns may still reference them.
    return this.public(scope);
  }
  async remove(scope) {
    if(scope.role!=='congregation admin')throw fail('Only Congregation Admin can change its logo.',403);
    const code=await congregationCode(this.db,scope);
    await this.db.congregationBranding.updateMany({where:{concretion_code:code},data:{logo_key:null,mime_type:null,sha256:null,updated_by:actor(scope)}});
    return this.public(scope);
  }
}
