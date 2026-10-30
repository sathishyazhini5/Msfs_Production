import {MEMBER_ROLE,MemberAccessService} from '../services/memberAccessService.js';
export const memberRouteAllowed=(method,path)=>method==='GET' && /^\/estatus\/(confrere|scholastic|centre|obituary)(?:\/filters|\/export|\/record\/[^/]+)?\/?$/.test(path);
export function createMemberGuard(db) {
 const service=new MemberAccessService({db});
 return async(req,res,next)=>{
  if(String(res.locals.user?.role_name || '').toLowerCase()!==MEMBER_ROLE)return next();
  try {
   const changingPassword=req.method==='POST'&&req.path==='/member-access/change-initial-password';
   if(!changingPassword && !memberRouteAllowed(req.method,req.path))return res.status(403).json({error:'Member accounts can only view authorized E-Status directories.'});
   if (res.locals.user.member_session) {
    if (!memberRouteAllowed(req.method,req.path)) return res.status(403).json({error:'Member access is read-only.'});
    const provinces=await db.province_mst.findMany({where:{concretion_code:res.locals.user.concretion_code},select:{province_code:true}});
    req.memberProvinceCodes=provinces.map(p=>p.province_code); return next();
   }
   const account=await db.users_mst.findUnique({where:{user_id:res.locals.user.user_id},select:{role_name:true,role_code:true}});
   if(account?.role_name!==MEMBER_ROLE || account?.role_code!=='MEMBER')return res.status(403).json({error:'Member account no longer authorized.'});
   const access=await service.active(res.locals.user.user_id);
   const version=access.password_changed_at?new Date(access.password_changed_at).getTime():0;
   if((res.locals.user.password_version ?? 0)!==version)return res.status(401).json({code:'INVALID_TOKEN',message:'Sign in again with your changed password.'});
   const provinces=await db.province_mst.findMany({where:{concretion_code:access.concretion_code},select:{province_code:true}});
   req.memberProvinceCodes=provinces.map(p=>p.province_code);next();
  }catch(error){res.status(error.status || 500).json({error:error.status?error.message:'Unable to verify member access.'});}
 };
}
