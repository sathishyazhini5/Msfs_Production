import 'dotenv/config';
import {readFile,writeFile} from 'node:fs/promises';
import {PrismaClient} from '@prisma/client';
import {MemberAccessService} from '../src/services/memberAccessService.js';
import {canonicalMembers} from '../src/services/memberInitialization.js';
const args=process.argv.slice(2);
const valued=new Set(['--legacy-uninitialized-file','--email','--confirm-database','--environment','--report']);
const allowed=new Set(['--dry-run','--execute',...valued]);
for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('Unsupported provisioning option.');if(valued.has(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Option requires a value.');i++;}}
if(args.includes('--execute')&&args.includes('--dry-run'))throw new Error('Choose dry-run or execute.');
const dryRun=!args.includes('--execute');
const option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const target=new URL(process.env.DATABASE_URL || 'postgresql://unconfigured/');
const database=decodeURIComponent(target.pathname.slice(1));
if(!dryRun && (option('--environment')!=='development' || process.env.NODE_ENV==='production' || option('--confirm-database')!==database))throw new Error('Execute requires --environment development and --confirm-database matching DATABASE_URL; production is not supported by this command.');
const email=option('--email')?.trim().toLowerCase();
if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Invalid single-email selector.');
const fileIndex=args.indexOf('--legacy-uninitialized-file');
const legacyUninitialized=new Set(fileIndex<0?[]:JSON.parse(await readFile(args[fileIndex+1],'utf8')).map(value=>String(value).trim().toLowerCase()));
const db=new PrismaClient();
try{
 const service=new MemberAccessService({db});const scope={role:'super admin',provinceCodes:null,user:{user_id:'member-provisioning-command'}};
 const snapshot=await service.directory(scope);const counts={created:0,linked:0,initialized:0,skipped:0,conflict:0,errors:0};const reasons={};
 const selected=canonicalMembers(snapshot).filter(row=>!email || row.email===email);
 const records=[];
 const [accountSnapshot,linkSnapshot]=await Promise.all([db.users_mst.findMany(),db.memberAccess.findMany()]);
 for(let offset=0;offset<selected.length;offset+=4){
  const batch=await Promise.all(selected.slice(offset,offset+4).map(async row=>{
   try{
    const result=await service.provision(scope,{kind:row.kind,code:row.code,province_code:row.province_code},{snapshot,dryRun,legacyUninitialized,queueWelcome:false,accountSnapshot,linkSnapshot});
    return {kind:row.kind,code:row.code,province_code:row.province_code,status:result.status,reason:result.reason};
   }catch{return {kind:row.kind,code:row.code,province_code:row.province_code,status:'errors'};}
  }));
  for(const result of batch){records.push(result);counts[result.status]=(counts[result.status] || 0)+1;if(result.reason)reasons[result.reason]=(reasons[result.reason] || 0)+1;}
 }
 const summary={mode:dryRun?'dry-run':'execute',environment:option('--environment') || 'unconfirmed',database,scope:email?'single-email':'bulk',matched:selected.length,...counts,reasons};
 if(option('--report'))await writeFile(option('--report'),JSON.stringify({...summary,records},null,2));
 console.log(JSON.stringify({...summary,exceptions:records.filter(record=>record.status==='conflict'||record.status==='errors'||record.reason==='missing_or_invalid_email')}));
 if(counts.errors)process.exitCode=1;
}catch{console.error('Member provisioning failed. Verify the migration, database connection and input options. No credentials were printed.');process.exitCode=1;}
finally{await db.$disconnect();}
