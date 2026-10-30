import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import bcrypt from 'bcrypt';
import {sendEmail} from '../middlewares/emailService.js';
import {accountAudit} from './accountAudit.js';
const digest=value=>createHash('sha256').update(value).digest('hex');
export async function requestAdminReset(db,user,{send=sendEmail,audit=accountAudit}={}) {
  const prior=await db.memberPasswordToken.findUnique({where:{user_id:user.user_id}});
  if(prior && Date.now()-new Date(prior.created_at).getTime()<60000)return;
  const token=randomBytes(32).toString('hex');
  const data={token_hash:digest(user.user_id+':'+token),expires_at:new Date(Date.now()+600000),attempts:0,created_at:new Date()};
  await db.memberPasswordToken.upsert({where:{user_id:user.user_id},create:{user_id:user.user_id,...data},update:data});
  const url=new URL('/reset-password',process.env.ACCOUNT_LOGIN_URL || 'https://msfs.adminpro.co.in/login');
  url.searchParams.set('email',user.user_id);url.searchParams.set('token',token);
  try { await send(user.user_id,'Reset your AdminPro password',`Reset your password: ${url}\nThis private single-use link expires in 10 minutes.`); }
  catch(error){await db.memberPasswordToken.deleteMany({where:{user_id:user.user_id,token_hash:data.token_hash}});throw error;}
  try {await audit(db,user,'reset requested');}catch{ return {audit:'failed'}; }
  return {audit:'sent'};
}
export async function completeAdminReset(db,user,token,password,{audit=accountAudit}={}) {
  if(typeof password!=='string'||password.length<12||password.length>128)throw Object.assign(new Error('Use a password between 12 and 128 characters.'),{status:400});
  const record=await db.memberPasswordToken.findUnique({where:{user_id:user.user_id}});
  const fail=()=>Object.assign(new Error('Reset link is invalid or expired.'),{status:400});
  if(!record || record.expires_at<=new Date() || record.attempts>=5)throw fail();
  const attempt=await db.memberPasswordToken.updateMany({where:{user_id:user.user_id,token_hash:record.token_hash,attempts:{lt:5},expires_at:{gt:new Date()}},data:{attempts:{increment:1}}});
  if(!attempt.count || !timingSafeEqual(Buffer.from(record.token_hash),Buffer.from(digest(user.user_id+':'+String(token)))))throw fail();
  const hash=await bcrypt.hash(password,12);
  await db.$transaction(async tx=>{
    const used=await tx.memberPasswordToken.deleteMany({where:{user_id:user.user_id,token_hash:record.token_hash,expires_at:{gt:new Date()}}});
    if(used.count!==1)throw fail();
    await tx.users_mst.update({where:{user_id:user.user_id},data:{password:hash,must_change_password:false,updated_date:new Date()}});
  });
  try{await audit(db,user,'reset completed');return {audit:'sent'};}catch{return {audit:'failed'};}
}
