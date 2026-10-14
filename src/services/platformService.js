export const requirePlatformAdmin=scope=>{if(scope.role!=='super admin')throw Object.assign(new Error('Only Super Admin can manage congregations.'),{status:403});};
export class PlatformService {
  constructor(db){this.db=db;}
  async dashboard(scope,input={}) {
    requirePlatformAdmin(scope);
    const page=Number(input.page || 1),pageSize=Number(input.pageSize || 10);
    if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||input.search && (typeof input.search!=='string'||input.search.length>100))throw Object.assign(new Error('Invalid congregation query.'),{status:400});
    const [congregations,provinceCount,userCount]=await Promise.all([
      this.db.concretion_defination_mst.findMany({orderBy:[{created_date:'desc'},{concretion_code:'asc'}]}),
      this.db.province_mst.count({where:{province_code:{not:'ALL'}}}),this.db.users_mst.count(),
    ]);
    const statuses=[...new Set(congregations.map(c=>c.status).filter(Boolean))].sort();
    if(input.status&&!statuses.includes(input.status))throw Object.assign(new Error('Unsupported congregation status.'),{status:400});
    const counts={congregations:congregations.length,provinces:provinceCount,users:userCount,active:congregations.filter(c=>c.status?.toLowerCase()==='active').length,inactive:congregations.filter(c=>c.status?.toLowerCase()==='inactive').length,otherStatus:congregations.filter(c=>!['active','inactive'].includes(c.status?.toLowerCase())).length};
    const needle=(input.search || '').trim().toLowerCase();
    const matches=congregations.filter(c=>(!input.status||c.status===input.status)&&(!needle||[c.concretion_name,c.concretion_code,c.email,c.contact_name].some(v=>String(v || '').toLowerCase().includes(needle))));
    const provinces=await this.db.province_mst.findMany({where:{province_code:{not:'ALL'}},select:{concretion_code:true,province_code:true,province_name:true,created_date:true}});
    const users=await this.db.users_mst.findMany({select:{user_id:true,prov_concre_code:true,created_date:true,created_by:true}});
    const publicRow=c=>({concretion_code:c.concretion_code,concretion_name:c.concretion_name,contact_name:c.contact_name,email:c.email,status:c.status,created_date:c.created_date,created_by:c.created_by,province_count:provinces.filter(p=>p.concretion_code===c.concretion_code).length,user_count:users.filter(u=>u.prov_concre_code===c.concretion_code || provinces.some(p=>p.concretion_code===c.concretion_code && p.province_code===u.prov_concre_code)).length});
    const recent=congregations.filter(c=>c.created_date).slice(0,5).map(publicRow);
    const onboarding=[...congregations.filter(c=>c.created_date).map(c=>({kind:'Congregation',name:c.concretion_name,date:c.created_date,concretion_code:c.concretion_code})),...provinces.filter(p=>p.created_date).map(p=>({kind:'Province',name:p.province_name,date:p.created_date,concretion_code:p.concretion_code}))].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,8);
    const activity=[...congregations.filter(c=>c.created_date).map(c=>({date:c.created_date,user:c.created_by || 'Not recorded',action:'Created Congregation',details:c.concretion_name || c.concretion_code})),...congregations.filter(c=>c.updated_date).map(c=>({date:c.updated_date,user:c.updated_by || 'Not recorded',action:'Updated Congregation',details:c.concretion_name || c.concretion_code})),...users.filter(u=>u.created_date).map(u=>({date:u.created_date,user:u.created_by || 'Not recorded',action:'Added User',details:u.user_id})),...onboarding.filter(a=>a.kind==='Province').map(a=>({date:a.date,user:'Not recorded',action:'Created Province',details:a.name}))].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,30);
    return {activity,metrics:counts,statuses,recent,onboarding,records:matches.slice((page-1)*pageSize,page*pageSize).map(publicRow),total:matches.length,page,pageSize};
  }
}
