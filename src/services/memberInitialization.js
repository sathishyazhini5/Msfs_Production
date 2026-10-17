import bcrypt from 'bcrypt';
export const INITIAL_MEMBER_PASSWORD='pass123';
const memberRole='estatus member';
const validEmail=value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '')&&value.length<=100;
const problem=(message,status=409)=>Object.assign(new Error(message),{status});
export const memberIdentity=row=>JSON.stringify([row.kind==='Curia'?'Confrere':row.kind,row.code,row.kind==='Scholastic'?row.province_code:null,row.concretion_code]);
export function canonicalMembers(rows){
 const grouped=new Map();
 for(const row of rows){const key=memberIdentity(row);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
 return [...grouped.values()].map(group=>group.find(row=>row.kind==='Confrere'&&validEmail(row.email)) || group.find(row=>validEmail(row.email)) || group[0]);
}
export async function initializeMember(service,scope,input,{dryRun=false,legacyUninitialized=new Set(),snapshot,queueWelcome=true,accountSnapshot,linkSnapshot}={}){
 if(!['super admin','congregation admin','province admin'].includes(scope.role))throw problem('Member provisioning requires an authorized administrator.',403);
 const all=snapshot || await service.directory({role:'super admin',provinceCodes:null});
 const selected=all.find(row=>row.kind===input.kind&&row.code===input.code&&row.province_code===input.province_code);
 if(!selected)throw problem('Member not found in your authorized scope.',404);
 if(scope.provinceCodes!==null&&!scope.provinceCodes.includes(selected.province_code))throw problem('Member not found in your authorized scope.',404);
 const row=canonicalMembers(all).find(row=>memberIdentity(row)===memberIdentity(selected));
 if(row.kind!=='Scholastic' && new Set(all.filter(item=>item.kind!=='Scholastic'&&item.code===row.code).map(item=>item.concretion_code)).size>1)return {status:'conflict',reason:'person_multiple_congregations'};
 if(!validEmail(row.email))return {status:'skipped',reason:'missing_or_invalid_email'};
 const identities=new Set(all.filter(item=>item.email===row.email).map(memberIdentity));
 if(identities.size!==1)return {status:'conflict',reason:'shared_email'};
 const accounts=accountSnapshot?accountSnapshot.filter(account=>String(account.user_id).toLowerCase()===row.email):await service.db.users_mst.findMany({where:{user_id:{equals:row.email,mode:'insensitive'}}});
 if(accounts.length>1)return {status:'conflict',reason:'ambiguous_account'};
 const account=accounts[0];
 if(account && (account.role_name!==memberRole || account.role_code!=='MEMBER'))return {status:'conflict',reason:'administrator_or_other_role'};
 const identityLink=linkSnapshot?linkSnapshot.find(link=>link.person_code===row.code && link.concretion_code===row.concretion_code && (row.kind==='Scholastic'?link.person_kind==='Scholastic'&&link.province_code===row.province_code:['Confrere','Curia'].includes(link.person_kind))):await service.db.memberAccess.findFirst({where:{person_code:row.code,concretion_code:row.concretion_code,...(row.kind==='Scholastic'?{person_kind:'Scholastic',province_code:row.province_code}:{person_kind:{in:['Confrere','Curia']}})}});
 if(identityLink && String(identityLink.user_id).toLowerCase()!==row.email)return {status:'conflict',reason:'identity_already_linked'};
 const link=account?(linkSnapshot?linkSnapshot.find(link=>link.user_id===account.user_id):await service.db.memberAccess.findUnique({where:{user_id:account.user_id}})):null;
 if(account && account.prov_concre_code!==row.concretion_code)return {status:'conflict',reason:'account_scope_mismatch'};
 if(link && (link.person_code!==row.code || link.concretion_code!==row.concretion_code || (link.person_kind==='Scholastic')!==(row.kind==='Scholastic') || (row.kind==='Scholastic'&&link.province_code!==row.province_code)))return {status:'conflict',reason:'identity_mismatch'};
 if(link?.password_initialized_at || link?.password_changed_at)return {status:'skipped',reason:'already_initialized',email:row.email};
 // Old random initialization hashes and user-chosen hashes are indistinguishable.
 // Only an explicitly reviewed allowlist can certify an unknown legacy hash as unused.
 const knownDefault=account && (account.password===INITIAL_MEMBER_PASSWORD || (/^\$2[aby]\$/.test(account.password || '') && await bcrypt.compare(INITIAL_MEMBER_PASSWORD,account.password)));
 const initialize=!account || knownDefault || legacyUninitialized.has(row.email);
 if(account && !initialize && link)return {status:'skipped',reason:'legacy_password_requires_review'};
 const status=!account?'created':!link?'linked':'initialized';
 if(dryRun)return {status,...(!initialize?{reason:'existing_password_preserved'}:{})};
 const password=initialize?await bcrypt.hash(INITIAL_MEMBER_PASSWORD,12):null;
 const now=new Date();const user_id=account?.user_id || row.email;
 await service.db.$transaction(async tx=>{
  if(!account)await tx.users_mst.create({data:{user_id,user_type_code:'MEMBER',prov_concre_code:row.concretion_code,first_name:row.name.slice(0,100),password,role_code:'MEMBER',role_name:memberRole,created_by:scope.user.user_id,created_date:now}});
  else if(initialize){
   const changed=await tx.users_mst.updateMany({where:{user_id,password:account.password,role_code:'MEMBER',role_name:memberRole},data:{password,updated_date:now,updated_by:scope.user.user_id}});
   if(changed.count!==1)throw problem('Account changed during initialization; retry after review.');
  }
  const initial=initialize?{password_initialized_at:now,password_change_required:false,welcome_status:queueWelcome?'Pending':'NotRequested'}:{};
  if(!link)await tx.memberAccess.create({data:{user_id,person_kind:row.kind,person_code:row.code,province_code:row.province_code,concretion_code:row.concretion_code,created_by:scope.user.user_id,...initial}});
  else if(initialize){
   const updated=await tx.memberAccess.updateMany({where:{user_id,password_initialized_at:null,password_changed_at:null},data:initial});
   if(updated.count!==1)throw problem('Member initialization changed concurrently; nothing was reset.');
  }
 });
 return {status,email:user_id,welcome:initialize&&queueWelcome?'queued':'not_requested',message:initialize?'Member login provisioned with read-only E-Status access.':'Member linked; existing password preserved.'};
}
