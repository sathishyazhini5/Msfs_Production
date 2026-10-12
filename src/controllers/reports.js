import { PrismaClient } from '@prisma/client';
import { resolveDataScope, sendScopeError } from '../utils/dataScope.js';
import { allowedModules, reportContext, reportRows, reportFilters, runReport } from '../services/reportService.js';
const prisma = new PrismaClient();
export async function reports(req, res) {
  try {
    const input = req.body || {};
    for (const key of ['province', 'congregation']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100)) throw Object.assign(new Error(`Invalid ${key}.`), {status: 400});
    const scope = await resolveDataScope(req, prisma, input.province);
    const available = allowedModules(scope.role);
    const context = await reportContext(prisma, scope, input.congregation);
    if (req.method === 'GET') return res.json({ presetNamespace: JSON.stringify([scope.user.user_id || scope.user.sub || '', scope.role, scope.provinceCodes, scope.user.concretion_code || '']), modules: available.map(m => ({ id: m.id, title: m.title, fields: m.fields, filterFields: reportFilters(m), filters: reportFilters(m).map(f => f.key), scoped: m.scoped })), provinces: context.provinces.map(p => ({value:p.province_code,label:p.province_name,congregation:p.concretion_code})), congregations: context.congregations.map(c => ({value:c.concretion_code,label:c.concretion_name})), role: scope.role });
    const module = available.find(m => m.id === input.module);
    if (!module) return res.status(400).json({ error: 'Module is unavailable for your role.' });
    const result = runReport(module, await reportRows(prisma, module, context), input);
    const provinceLabels = context.provinces.map(p => p.province_name);
    result.appliedFilters.unshift(`Province scope: ${context.codes === null ? 'All authorized provinces' : provinceLabels.join(', ') || 'No provinces'}`);
    if (input.congregation) result.appliedFilters.unshift(`Congregation: ${context.congregations.find(c => c.concretion_code === input.congregation)?.concretion_name}`);
    return res.json({...result, generatedAt: new Date().toISOString()});
  } catch (error) {
    if (error.status || ['TokenExpiredError', 'JsonWebTokenError'].includes(error.name)) return sendScopeError(res, error, 'Unable to generate report.');
    console.error('Reports failed:', error.message);
    return res.status(500).json({error:'Unable to generate report. Please try again.'});
  }
}
