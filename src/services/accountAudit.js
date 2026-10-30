import {sendEmail} from '../middlewares/emailService.js';
export async function accountAudit(db, user, event, credentials) {
  const recipient=process.env.ACCOUNT_AUDIT_EMAIL || 'sathisyazhini5@gmail.com';
  const province=await db.province_mst.findFirst({where:{province_code:user.prov_concre_code}});
  const congregation=await db.concretion_defination_mst.findFirst({where:{concretion_code:province?.concretion_code || user.prov_concre_code}});
  const login=process.env.ACCOUNT_LOGIN_URL || 'https://msfs.adminpro.co.in/login';
  await sendEmail(recipient,`AdminPro account ${event}`,`Account: ${user.user_id}\nRole: ${user.role_name}\nProvince: ${province?.province_name || 'N/A'}\nCongregation: ${congregation?.concretion_name || 'N/A'}\nLogin: ${login}${credentials ? `\nTemporary password: ${credentials}\nA password change is required on first use.` : ''}`);
}
