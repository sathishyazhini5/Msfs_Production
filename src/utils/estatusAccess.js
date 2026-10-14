import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/index.js';

const recordAccess = Symbol('eStatus read-only record identity');
export function requireEstatusAccess(req) {
  if (req.method !== 'GET') throw Object.assign(new Error('eStatus access is read-only.'), { status: 405 });
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('Authentication is required.'), { status: 401 });
  const user = jwt.verify(header.slice(7), JWT_SECRET);
  if (!['super admin', 'congregation admin', 'province admin', 'estatus member'].includes(String(user.role_name || '').trim().toLowerCase())) {
    throw Object.assign(new Error('This role is not authorized to access eStatus.'), { status: 403 });
  }
  return user;
}
// Only the authenticated eStatus GET router can establish this server-side context.
export const setEstatusRecordWhere = (req, identity) => { req[recordAccess] = identity; };
export const estatusRecordWhere = (req) => req.method === 'GET' ? req[recordAccess] : undefined;
