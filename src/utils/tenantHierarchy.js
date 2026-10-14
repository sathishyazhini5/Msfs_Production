export const normalizedRole=user=>{const role=String(user?.role_name || '').trim().toLowerCase();return role==='concretion admin'?'congregation admin':role;};
export async function provinceMutationAllowed(req,res,db) {
  const user=res.locals.user;
  if(normalizedRole(user)!=='congregation admin'||!user.concretion_code){res.status(403).json({error:'Only Congregation Admin can manage its own provinces.'});return false;}
  if(req.body?.concretion_code && req.body.concretion_code!==user.concretion_code){res.status(403).json({error:'Province must belong to your congregation.'});return false;}
  if(req.params?.province_code){
    const province=await db.province_mst.findUnique({where:{province_code:req.params.province_code}});
    if(!province||province.concretion_code!==user.concretion_code){res.status(404).json({error:'Province not found in your congregation.'});return false;}
  }
  req.body ||= {};req.body.concretion_code=user.concretion_code;return true;
}
export const requireSuperAdmin=(req,res,next)=>normalizedRole(res.locals.user)==='super admin'?next():res.status(403).json({error:'Only Super Admin can manage congregations.'});
