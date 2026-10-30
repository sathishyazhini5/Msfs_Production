import { provinceScopeWhere, resolveDataScope } from './dataScope.js';

export async function recordWhere(req, prisma, key, { gcicRead = false } = {}) {
  const { provinceCodes } = await resolveDataScope(req, prisma);
  const identity = { ...key };
  for (const field of ['province_code', 'division_type_code', 'division_code', 'confrer_code']) {
    if (!(field in key) && typeof req.query[field] === 'string' && req.query[field]) identity[field] = req.query[field];
  }
  const scope = provinceScopeWhere(provinceCodes);
  const access = scope;
  return { AND: [identity, access] };
}
