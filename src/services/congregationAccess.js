export const DEACTIVATED_MESSAGE = 'Your congregation access has been deactivated. Please contact the administrator.';

// Resolve current ownership from the account rather than trusting stale token scope.
export async function assertCongregationAccess(db, identity) {
  const account = identity.user_id ? await db.users_mst.findFirst({ where: { user_id: identity.user_id } }) : identity;
  if (!account) throw Object.assign(new Error('Account is no longer available.'), { status: 401 });
  if (String(account.role_name || identity.role_name || '').trim().toLowerCase() === 'super admin' || account.role_code === 'RN001') return;
  let code = account.concretion_code || identity.concretion_code;
  const owner = account.prov_concre_code;
  if (owner && owner !== 'ALL') {
    const congregation = await db.concretion_defination_mst.findFirst({ where: { concretion_code: owner } });
    if (congregation) code = congregation.concretion_code;
    else {
      const province = await db.province_mst.findFirst({ where: { province_code: owner } });
      code = province?.concretion_code || code;
    }
  }
  if (!code && (account.province_code || identity.province_code)) {
    const province = await db.province_mst.findFirst({ where: { province_code: account.province_code || identity.province_code } });
    code = province?.concretion_code;
  }
  if (!code) return;
  const congregation = await db.concretion_defination_mst.findFirst({ where: { concretion_code: code } });
  if (String(congregation?.status || '').trim().toLowerCase() === 'inactive') throw Object.assign(new Error(DEACTIVATED_MESSAGE), { status: 403, code: 'CONGREGATION_INACTIVE' });
}
