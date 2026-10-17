import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import {MemberWelcomeService} from '../src/services/memberWelcomeService.js';
import {sendAccountEmail,circularMailConfigured} from '../src/middlewares/emailService.js';
import {downloadCircularBlob} from '../src/middlewares/azureBlob.js';
const execute=process.argv.includes('--execute'),watch=process.argv.includes('--watch');
const db=new PrismaClient();const service=new MemberWelcomeService({db,send:sendAccountEmail,download:downloadCircularBlob});let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
try{
 if(execute&&!circularMailConfigured())throw new Error('Email configuration is required.');
 do{
  if(execute)await service.recover();
  const rows=await db.memberAccess.findMany({where:{welcome_status:{in:['Pending','Retryable']},password_changed_at:null,enabled:true},select:{user_id:true},take:100});
  const counts={pending:rows.length,sent:0,retryable:0,failed:0,unknown:0,skipped:0};
  if(execute)for(const row of rows){if(stopping)break;const result=await service.deliver(row.user_id);counts[result.status in counts?result.status:'skipped']++;}
  console.log(JSON.stringify({mode:execute?'execute':'dry-run',...counts}));
  if(!execute||!watch||stopping)break;
  await new Promise(resolve=>{const timer=setTimeout(resolve,10000);if(stopping){clearTimeout(timer);resolve();}});
 }while(!stopping);
}catch{console.error('Welcome worker failed. Check database/email configuration. SMTP outcomes and safe retries remain recorded on member access.');process.exitCode=1;}
finally{await db.$disconnect();}
