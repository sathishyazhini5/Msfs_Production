import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/index.js';
import {normalizedRole} from './tenantHierarchy.js';

const scopeError = (message, status = 403) => Object.assign(new Error(message), { status });

export const resolveDataScope = async (req, prisma, requestedProvinceCode = null) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw scopeError('Authentication token is required.', 401);

  let user = jwt.verify(authHeader.slice(7), JWT_SECRET);
  // Resolve administrator ownership from the current account rather than stale claims.
  if (user.user_id && prisma.users_mst) {
    const account = await prisma.users_mst.findFirst({where:{user_id:user.user_id}});
    if (!account) throw scopeError('Account is no longer available.',401);
    const currentRole = normalizedRole(account);
    user = {...user,role_name:currentRole};
    if (currentRole === 'congregation admin') user.concretion_code=account.prov_concre_code;
    if (currentRole === 'province admin') user.province_code=account.prov_concre_code;
  }
  const role = normalizedRole(user);
  const requested = requestedProvinceCode && requestedProvinceCode !== 'ALL'
    ? requestedProvinceCode
    : null;

  if (role === 'super admin') {
    if (!requested) return { user, role, provinceCodes: null };
    const province = await prisma.province_mst.findUnique({ where: { province_code: requested } });
    if (!province || province.province_code === 'ALL') throw scopeError('Selected province was not found.', 404);
    return { user, role, provinceCodes: [province.province_code] };
  }

  if (role === 'congregation admin') {
    if (!user.concretion_code) throw scopeError('Congregation scope is missing from the token.');
    const provinces = await prisma.province_mst.findMany({
      where: { concretion_code: user.concretion_code, ...(requested ? { province_code: requested } : {}) },
      select: { province_code: true },
    });
    if (requested && provinces.length === 0) throw scopeError('Selected province is outside your congregation.');
    return { user, role, provinceCodes: provinces.map((province) => province.province_code) };
  }

  if (role === 'province admin') {
    const province = await prisma.province_mst.findFirst({
      where: user.province_code ? { province_code: user.province_code } : { province_name: user.province_name },
      select: { province_code: true },
    });
    if (!province) throw scopeError('Province scope is missing from the token.');
    if (requested && requested !== province.province_code) throw scopeError('Selected province is outside your authorized scope.');
    return { user, role, provinceCodes: [province.province_code] };
  }

  throw scopeError('This role is not authorized to access scoped data.');
};

export const provinceScopeWhere = (provinceCodes) =>
  provinceCodes === null ? {} : { province_code: { in: provinceCodes } };

export const sendScopeError = (res, error, fallbackMessage) => {
  if (error.name === 'TokenExpiredError') return res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Your session has expired. Please login again.' });
  if (error.name === 'JsonWebTokenError') return res.status(401).json({ code: 'INVALID_TOKEN', message: 'Invalid authentication token.' });
  if (error.status === 401) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Authentication is required.' });
  return res.status(error.status || 500).json({ error: error.message || fallbackMessage });
};
