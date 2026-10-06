import { getScholasticDetails } from '../controllers/Msfs/scholastics.js';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { sendScopeError } from '../utils/dataScope.js';
import { requireEstatusAccess, setEstatusRecordWhere } from '../utils/estatusAccess.js';
import { getConfrere } from '../controllers/Msfs/confreres.js';
import { getcenterdetails } from '../controllers/Msfs/centre.js';
import { getObituary } from '../controllers/Msfs/Obituary_dtl.js';
import { fetchDirectory, loadDirectoryOptions, parseDirectoryQuery, filterFields } from '../services/estatusService.js';

const prisma = new PrismaClient();
export const estatusRouter = express.Router();
estatusRouter.get('/estatus/:kind/record/:code', async (req, res, next) => {
  try {
    requireEstatusAccess(req);
    const definitions = {
      confrere: ['confreres_dtl', 'confrer_code', ['province_code'], getConfrere],
      scholastic: ['scholastics_dtl', 'scholastic_code', ['province_code'], getScholasticDetails],
      centre: ['centre_dtl', 'centre_code', ['province_code', 'division_type_code', 'division_code'], getcenterdetails],
      obituary: ['obituary_dtl', 'obituary_code', ['province_code', 'confrer_scholastic_code'], getObituary],
    };
    const definition = Object.hasOwn(definitions, req.params.kind) ? definitions[req.params.kind] : null;
    if (!definition) return res.status(404).json({ error: 'Directory not found.' });
    const [model, key, fields, handler] = definition;
    const identity = { [key]: req.params.code };
    if (!req.params.code || req.params.code.length > 50 || Object.keys(req.query).some((field) => !fields.includes(field))) return res.status(400).json({ error: 'Invalid record identifier.' });
    for (const field of fields) {
      if (typeof req.query[field] !== 'string' || !req.query[field].trim() || req.query[field].length > 50) return res.status(400).json({ error: `Complete record identifier required: ${field}.` });
      identity[field] = req.query[field];
    }
    const record = await prisma[model].findFirst({ where: identity, select: { [key]: true } });
    if (!record) return res.status(404).json({ error: 'Record not found.' });
    setEstatusRecordWhere(req, identity);
    req.params[key] = req.params.code;
    return await handler(req, res, next);
  } catch (error) {
    return sendScopeError(res, error, 'Unable to load eStatus profile.');
  }
});
estatusRouter.get('/estatus/:kind/:action?', async (req, res) => {
  try {
    const { kind, action } = req.params;
    requireEstatusAccess(req);
    if (action && action !== 'filters') return res.status(404).json({ error: 'Endpoint not found.' });
    const filters = parseDirectoryQuery(kind, req.query);
    const provinceCodes = null;
    if (action === 'filters') {
      const options = await loadDirectoryOptions(prisma, kind, provinceCodes, filters);
      for (const field of filterFields[kind]) {
        if (filters[field] && !options[field]?.some((o) => o.value === filters[field])) return res.status(400).json({ error: `Invalid ${field} for selected filters.` });
      }
      return res.json({ options });
    }
    return res.json(await fetchDirectory(prisma, kind, filters, provinceCodes));
  } catch (error) {
    return sendScopeError(res, error, 'Unable to load eStatus.');
  }
});
