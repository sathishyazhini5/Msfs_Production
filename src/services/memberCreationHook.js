import {MemberAccessService} from './memberAccessService.js';
// Called only after the person transaction commits. Provisioning failures never
// turn successful person creation into a retry that creates another person.
export async function provisionCreatedMember(db,kind,person,actor='member-provisioning'){
 try{
  const service=new MemberAccessService({db});
  const result=await service.provision({role:'super admin',provinceCodes:null,user:{user_id:actor}}, {kind,code:person.confrer_code || person.scholastic_code,province_code:person.province_code});
  const {email,...publicResult}=result;
  return publicResult;
 }catch(error){return {status:'failed',reason:['P2021','P2022'].includes(error.code)?'member_migration_required':'member_provisioning_failed'};}
}
