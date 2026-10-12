import { Prisma } from '@prisma/client';
import { provinceScopeWhere } from '../utils/dataScope.js';
import { officeCategories } from '../utils/officeTypes.js';

// Business tables only: never expose credentials, OTPs, counters or internal access data.
const definitions = {
  confreres_dtl: 'Confreres', scholastics_dtl: 'Scholastics', centre_dtl: 'Centres',
  curia_advisors_dtl: 'Curia / Advisors', headquarters_dtl: 'Headquarters',
  community_house_dtl: 'Community Houses', appoint_transfer_dtl: 'Appointments / Transfers',
  appoint_transfer_his_dtl: 'Appointment History', scholastics_admisn_promon_dtl: 'Admissions / Promotions',
  scholastics_admisn_his_dtl: 'Admission History', departures_dtl: 'Departures', obituary_dtl: 'Obituaries',
  event_dtl: 'Events', announcements_dtl: 'News / Announcements', anniversary_notify_dtl: 'Anniversary Notifications',
  confreres_feedback_dtl: 'Confrere Feedback / Enquiries', scholastics_feedback_dtl: 'Scholastic Feedback',
  province_mst: 'Provinces', concretion_defination_mst: 'Congregations', division_setup_mst: 'Divisions',
  country_mst: 'Countries', state_mst: 'States', apostolates_mst: 'Apostolates',
  province_country_map_mst: 'Province / Country Mapping', quickcode_mst: 'Quick Master',
  users_mst: 'Users', user_role_com_activity_mst: 'Role Activity Mapping',
};
const restricted = new Set(['users_mst', 'user_role_com_activity_mst']);
const hidden = /^(password|import_key|concurrency_val|language_code|signature)$|file_(name|path)$|^uploaded_file/;
export const label = value => ({confrer_code:'Confrere',confrer_scholastic_code:'Member',personal1_contact_no:'Mobile Number',personal_mailid1:'Personal Email',is_active:'Status',concretion_code:'Congregation',anouncement_subjt:'Announcement Subject',anouncement_dtl:'Announcement Details'})[value] || value.replace(/_code$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const bad = message => Object.assign(new Error(message), { status: 400 });
export const modules = Object.entries(definitions).map(([id, title]) => {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === id);
  const fields = model.fields.filter(f => f.kind === 'scalar' && !hidden.test(f.name) && !['middle_name', 'last_name'].includes(f.name)).map(f => f.name === 'first_name' ? { key: 'full_name', title: 'Name', type: 'String' } : { key: f.name, title: label(f.name), type: f.type });
  return { id, title, fields, keys: model.primaryKey?.fields || model.fields.filter(f => f.isId).map(f => f.name), scoped: fields.some(f => f.key === 'province_code') };
});
export const allowedModules = role => modules.filter(m => !restricted.has(m.id) || role === 'super admin');
const quickTypes = {
  member_type_code: ['memtyp', 'memtype'], designation_code: ['destyp'], division_type_code: ['divtyp'],
  mandate_code: ['mandat'], pcic_off_code: ['pcicof'], gcic_off_code: ['gcicof', 'GCIC_TYPE'],
  nationality_code: ['natlty'], blood_group_code: ['bldgrp'], diocese_code: ['diocse'],
  formation_type_code: ['fortyp'], scholastic_type_code: ['schtyp'], year_formation_code: ['yrform'],
  promotion_to_code: ['promto', 'promot'], departure_type_code: ['depty', 'deptyp'],
  anniversary_type_code: ['anityp', 'anntyp', 'anntyp'], feedback_type_code: ['fedtyp'],
};
const fullName = row => [row.first_name, row.middle_name, row.last_name].map(part => String(part ?? '').trim()).filter(Boolean).join(' ');

export async function reportContext(prisma, scope, congregation) {
  const provinces = await prisma.province_mst.findMany({ where: { AND: [provinceScopeWhere(scope.provinceCodes), { province_code: { not: 'ALL' } }] } });
  const codes = provinces.map(p => p.province_code);
  const congregationCodes = [...new Set(provinces.map(p => p.concretion_code))];
  const congregations = await prisma.concretion_defination_mst.findMany({ where: scope.role === 'super admin' ? {} : { concretion_code: { in: congregationCodes } } });
  if (congregation && !congregations.some(c => c.concretion_code === congregation)) throw Object.assign(new Error('Congregation is outside your authorized scope.'), { status: 403 });
  const selected = congregation ? provinces.filter(p => p.concretion_code === congregation) : provinces;
  return { provinces: selected, congregations: congregation ? congregations.filter(c => c.concretion_code === congregation) : congregations, codes: congregation ? selected.map(p => p.province_code) : (scope.provinceCodes === null ? null : codes) };
}

export async function reportRows(prisma, module, context) {
  let where = module.scoped ? provinceScopeWhere(context.codes) : {};
  if (module.id === 'concretion_defination_mst') where = { concretion_code: { in: context.congregations.map(c => c.concretion_code) } };
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === module.id);
  const nameFields = ['first_name', 'middle_name', 'last_name'].filter(key => model.fields.some(f => f.name === key));
  const select = Object.fromEntries(module.fields.flatMap(f => f.key === 'full_name' ? nameFields.map(key => [key, true]) : [[f.key, true]]));
  const rows = await prisma[module.id].findMany({ where, select, orderBy: module.keys.map(key => ({ [key]: 'asc' })) });
  // Related lookups are scoped, and matched using all available composite keys.
  const scoped = provinceScopeWhere(context.codes);
  const lookups = {};
  const relationTables = {
    division_code: ['division_setup_mst', 'division_name'], centre_code: ['centre_dtl', 'centre_name'],
    community_house_code: ['community_house_dtl', 'community_house_name'],
    country_code: ['country_mst', 'country_name'], state_code: ['state_mst', 'state_name'],
    confrer_code: ['confreres_dtl', null], scholastic_code: ['scholastics_dtl', null],
    apostolate_code: ['apostolates_mst', 'apostolate_name'], centre_type_code: ['apostolates_mst', 'centre_type_name'],
  };
  const fields = new Set(module.fields.map(f => f.key));
  const jobs = Object.entries(relationTables).filter(([key]) => fields.has(key)).map(async ([key, [table, name]]) => {
    const model = Prisma.dmmf.datamodel.models.find(m => m.name === table);
    const names = name ? [name] : ['first_name', 'middle_name', 'last_name'];
    const keys = [key, 'province_code', 'division_type_code', 'division_code', 'country_code', 'apostolate_code'].filter(k => model.fields.some(f => f.name === k));
    lookups[key] = { name, rows: await prisma[table].findMany({ where: scoped, select: Object.fromEntries([...keys, ...names].map(k => [k, true])) }) };
  });
  if (fields.has('confrer_scholastic_code')) jobs.push(...['confreres_dtl', 'scholastics_dtl'].map(async table => {
    lookups[table] = await prisma[table].findMany({ where: scoped, select: { province_code: true, [table === 'confreres_dtl' ? 'confrer_code' : 'scholastic_code']: true, first_name: true, middle_name: true, last_name: true } });
  }));
  const quickcodes = await prisma.quickcode_mst.findMany({ select: { quick_code_type: true, quick_code: true, quickcode_name: true } });
  const officeTypes = fields.has('pcic_off_code') || fields.has('gcic_off_code') ? await officeCategories(prisma) : null;
  await Promise.all(jobs);
  const referenceDefinitions = {
    blood_group_code:['bloodgroup_metadata','code','bloodgroup'],
    nationality_code:['nationalitymetadata','code','nationality'],
    date_format:['date_format_metadata','date_format_code','date_format_name'],
    quick_code_type:['meta_data_mst','meta_code','meta_code_name'],
  };
  const references = {};
  await Promise.all(Object.entries(referenceDefinitions).filter(([key]) => fields.has(key)).map(async ([key,[table,code,name]]) => {
    references[key] = {code,name,rows:await prisma[table].findMany({...(table === 'meta_data_mst' ? {where:{screen_code:'qckcode'}} : {}),select:{[code]:true,[name]:true}})};
  }));
  const countryFields = module.fields.filter(f => /country/.test(f.key));
  const countries = countryFields.length ? await prisma.countrymetadata.findMany({}) : [];
  const apostolates = module.id === 'confreres_dtl' ? await confrereApostolates(prisma, scoped, context) : null;
  const result = rows.map(raw => {
    const values = {};
    for (const field of module.fields) {
      const key = field.key, value = raw[key];
      let readable = null;
      if (key === 'full_name') readable = fullName(raw);
      else if (key === 'province_code') readable = context.provinces.find(p => p.province_code === value)?.province_name;
      else if (key === 'concretion_code') readable = context.congregations.find(c => c.concretion_code === value)?.concretion_name;
      else if (key === 'prov_concre_code') readable = context.provinces.find(p => p.province_code === value)?.province_name || context.congregations.find(c => c.concretion_code === value)?.concretion_name;
      else if (['role_code','component_code','activity_code'].includes(key)) readable = raw[key.replace('_code','_name')];
      else if (key === 'confrer_scholastic_code') readable = fullName((lookups.confreres_dtl || []).find(p => p.confrer_code === value && p.province_code === raw.province_code) || (lookups.scholastics_dtl || []).find(p => p.scholastic_code === value && p.province_code === raw.province_code) || {});
      else if (lookups[key]) {
        const lookup = lookups[key];
        const match = lookup.rows.find(r => r[key] === value && ['province_code', 'division_type_code', 'division_code', 'country_code', 'apostolate_code'].every(k => k === key || raw[k] == null || r[k] == null || raw[k] === r[k]));
        readable = match && (lookup.name ? match[lookup.name] : fullName(match));
      }
      else if (/^(courier|other)_(country|state)_code$/.test(key)) {
        const baseKey = key.replace(/^(courier|other)_/,'');
        const prefix = key.slice(0,key.indexOf('_'));
        const lookup = lookups[baseKey];
        const match = lookup?.rows.find(r => r[baseKey] === value && r.province_code === raw.province_code && (baseKey !== 'state_code' || r.country_code === raw[`${prefix}_country_code`]));
        readable = match?.[lookup.name];
      }
      if (!readable && quickTypes[key]) {
        const types = [...quickTypes[key], ...(key === 'pcic_off_code' ? [officeTypes?.pcic] : key === 'gcic_off_code' ? [officeTypes?.gcic] : [])];
        readable = quickcodes.find(q => q.quick_code === value && types.includes(q.quick_code_type))?.quickcode_name;
      }
      if (!readable && references[key]) {
        const reference = references[key];
        readable = reference.rows.find(r => r[reference.code] === value)?.[reference.name];
      }
      if (!readable && /country/.test(key)) readable = countries.find(c => c.alpha_3code === value || c.alpha_2code === value)?.country_name;
      const isoDate = field.type === 'DateTime' && value != null ? (value instanceof Date ? value : new Date(value)).toISOString() : null;
      const formattedDate = isoDate && (/_time$/.test(key) ? isoDate.slice(11,19) : /^(created|updated)_date$/.test(key) ? isoDate.slice(0,19).replace('T',' ') : isoDate.slice(0,10));
      values[key] = readable || (value == null || value === '' ? '-' : field.type === 'DateTime' ? formattedDate : field.type === 'Boolean' ? (key === 'is_active' ? (value ? 'Active' : 'Inactive') : (value ? 'Yes' : 'No')) : String(value));
    }
    return { raw, values, key: JSON.stringify(module.keys.map(key => String(raw[key] ?? ""))), ...(apostolates ? { apostolateIds: apostolates.byConfrere.get(JSON.stringify([raw.province_code, raw.confrer_code])) || new Set(), centreIds: apostolates.byCentre.get(JSON.stringify([raw.province_code, raw.confrer_code])) || new Set() } : {}) };
  });
  if (apostolates) { result.apostolateOptions = apostolates.options; result.centreOptions = apostolates.centreOptions; }
  return result;
}

// The schema stores appointments and transfers together, with archived records in history.
// Join using the complete centre key and the master province/apostolate/centre-type key.
async function confrereApostolates(prisma, scoped, context) {
  const centreKeys = ['province_code', 'division_type_code', 'division_code', 'centre_code'];
  const masterKeys = ['province_code', 'apostolate_code', 'centre_type_code'];
  const identity = (row, keys) => JSON.stringify(keys.map(k => row[k] ?? null));
  const apostolateId = row => identity(row, ['province_code', 'apostolate_code']);
  const assignmentSelect = Object.fromEntries(['confrer_code', ...centreKeys].map(k => [k, true]));
  const [masters, centres, appointments, history] = await Promise.all([
    prisma.apostolates_mst.findMany({ where: scoped, select: { province_code: true, apostolate_code: true, centre_type_code: true, apostolate_name: true } }),
    prisma.centre_dtl.findMany({ where: scoped, select: Object.fromEntries([...centreKeys, 'centre_name', 'apostolate_code', 'centre_type_code'].map(k => [k, true])) }),
    prisma.appoint_transfer_dtl.findMany({ where: scoped, select: assignmentSelect }),
    prisma.appoint_transfer_his_dtl.findMany({ where: scoped, select: assignmentSelect }),
  ]);
  const validMasters = new Set(masters.map(row => identity(row, masterKeys)));
  const centreMap = new Map(centres.filter(row => validMasters.has(identity(row, masterKeys))).map(row => [identity(row, centreKeys), apostolateId(row)]));
  const byConfrere = new Map(), byCentre = new Map();
  const knownCentres = new Set(centres.map(row => identity(row, centreKeys)));
  for (const record of [...appointments, ...history]) {
    const member = JSON.stringify([record.province_code, record.confrer_code]);
    const centre = identity(record, centreKeys);
    if (knownCentres.has(centre)) { if (!byCentre.has(member)) byCentre.set(member, new Set()); byCentre.get(member).add(centre); }
    const id = centreMap.get(centre);
    if (!id) continue;
    if (!byConfrere.has(member)) byConfrere.set(member, new Set());
    byConfrere.get(member).add(id);
  }
  const multipleProvinces = context.provinces.length > 1;
  const options = [...new Map(masters.map(row => [apostolateId(row), {
    value: apostolateId(row),
    label: row.apostolate_name + (multipleProvinces ? ` (${context.provinces.find(p => p.province_code === row.province_code)?.province_name || row.province_code})` : ''),
  }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const centreOptions = centres.map(row => ({ value: identity(row, centreKeys), label: (row.centre_name || row.centre_code) + (multipleProvinces ? ` (${context.provinces.find(p => p.province_code === row.province_code)?.province_name || row.province_code})` : '') })).sort((a,b) => a.label.localeCompare(b.label));
  return { byConfrere, byCentre, options, centreOptions };
}

export function reportFilters(module) {
  const relatedKeys = new Set(['province_code','concretion_code','division_code','division_type_code','centre_code','country_code','state_code','apostolate_code','centre_type_code','confrer_code','scholastic_code','community_house_code']);
  const fields = module.fields.filter(f => f.type === 'Boolean' || f.key === 'status' || f.key === 'academic_year' || f.key === 'mode' || f.key === 'quick_code_type' || f.key.endsWith('_code') && (!module.keys.includes(f.key) || relatedKeys.has(f.key)));
  return module.id === 'confreres_dtl' ? [...fields, { key: 'apostolate_code', title: 'Apostolate', type: 'String' }, { key: 'centre_code', title: 'Centre', type: 'String' }] : fields;
}
const compositeFilters = {
  division_code:['province_code','division_type_code','division_code'],
  centre_code:['province_code','division_type_code','division_code','centre_code'],
  country_code:['province_code','country_code'], state_code:['province_code','country_code','state_code'],
  community_house_code:['province_code','division_type_code','division_code','community_house_code'],
  confrer_code:['province_code','confrer_code'], scholastic_code:['province_code','scholastic_code'],
};
function filterValue(module, row, key) {
  const parts = compositeFilters[key]?.filter(k => module.fields.some(f => f.key === k));
  return parts ? JSON.stringify(parts.map(k => row.raw[k] ?? null)) : String(row.raw[key]);
}
export function runReport(module, rows, input = {}) {
  const allowed = new Set(['module', 'columns', 'filters', 'search', 'sort', 'direction', 'dateField', 'from', 'to', 'page', 'pageSize', 'exportAll', 'province', 'congregation', 'selectedKeys']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw bad('Unknown report parameter.');
  const columns = input.columns || module.fields.slice(0, 8).map(f => f.key);
  if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length || columns.some(k => !module.fields.some(f => f.key === k))) throw bad('Select valid report columns.');
  const filters = input.filters || {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw bad('Invalid filters.');
  const permitted = reportFilters(module).map(f => f.key);
  for (const [key, value] of Object.entries(filters)) if (!permitted.includes(key) || typeof value !== 'string' || value.length > 200) throw bad(`Invalid filter: ${key}`);
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 100)) throw bad('Search must be at most 100 characters.');
  if (input.sort && !module.fields.some(f => f.key === input.sort)) throw bad('Invalid sort column.');
  if (input.direction && !['asc', 'desc'].includes(input.direction)) throw bad('Invalid sort direction.');
  for (const key of ['from', 'to']) if (input[key] && (typeof input[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input[key]) || !Number.isFinite(Date.parse(input[key])) || new Date(input[key]).toISOString().slice(0, 10) !== input[key])) throw bad('Invalid report date.');
  if (input.from && input.to && input.from > input.to) throw bad('Start date must precede end date.');
  if ((input.from || input.to || input.dateField) && !module.fields.some(f => f.key === input.dateField && f.type === 'DateTime' && !/_time$/.test(f.key))) throw bad('Select a valid date field.');
  const page = input.page ?? 1, pageSize = input.pageSize ?? 25;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw bad('Invalid pagination.');
  if (input.exportAll !== undefined && typeof input.exportAll !== 'boolean') throw bad('Invalid export request.');
  if (input.selectedKeys !== undefined && (!input.exportAll || !Array.isArray(input.selectedKeys) || !input.selectedKeys.length || input.selectedKeys.length > 10000 || new Set(input.selectedKeys).size !== input.selectedKeys.length || input.selectedKeys.some(key => typeof key !== 'string' || key.length > 2000))) throw bad('Select valid rows for export.');
  const multipleProvinces = new Set(rows.map(r => r.raw.province_code).filter(Boolean)).size > 1;
  const options = Object.fromEntries(reportFilters(module).map(f => [f.key, [...new Map(rows.filter(r => r.raw[f.key] != null && r.raw[f.key] !== '').map(r => [filterValue(module,r,f.key), { value: filterValue(module,r,f.key), label: r.values[f.key] + (multipleProvinces && compositeFilters[f.key] ? ` (${r.values.province_code})` : '') }])).values()].sort((a,b) => a.label.localeCompare(b.label))]));
  if (module.id === 'confreres_dtl') { options.apostolate_code = rows.apostolateOptions || []; options.centre_code = rows.centreOptions || []; }
  for (const [key, value] of Object.entries(filters)) if (value && !options[key].some(o => o.value === value)) throw bad(`Invalid ${label(key)} for this scope.`);
  const needle = (input.search || '').trim().toLowerCase();
  let results = rows.filter(r => Object.entries(filters).every(([k,v]) => !v || (module.id === 'confreres_dtl' && ['apostolate_code','centre_code'].includes(k) ? (k === 'centre_code' ? r.centreIds : r.apostolateIds)?.has(v) : filterValue(module,r,k) === v)) && (!needle || Object.values(r.values).join(' ').toLowerCase().includes(needle)) && (!(input.from || input.to) || r.raw[input.dateField] != null) && (!input.from || r.values[input.dateField].slice(0,10) >= input.from) && (!input.to || r.values[input.dateField].slice(0,10) <= input.to));
  if (input.sort) {
    const field = module.fields.find(f => f.key === input.sort);
    results = results.slice().sort((a,b) => {
      const av = a.values[field.key], bv = b.values[field.key];
      const order = ['Int', 'Float', 'Decimal'].includes(field.type) ? Number(a.raw[field.key] || 0) - Number(b.raw[field.key] || 0) : av.localeCompare(bv, undefined, { numeric: true });
      return order * (input.direction === 'desc' ? -1 : 1);
    });
  }
  const matchingTotal = results.length;
  const summary = { scopedRecords: rows.length, matchingRecords: matchingTotal, provinces: new Set(results.map(r => r.raw.province_code).filter(Boolean)).size };
  if (module.fields.some(f => f.key === 'is_active')) {
    summary.active = results.filter(r => r.raw.is_active === true).length;
    summary.inactive = results.filter(r => r.raw.is_active === false).length;
  }
  if (input.selectedKeys) {
    const selected = new Set(input.selectedKeys);
    results = results.filter(row => selected.has(row.key));
    if (results.length !== selected.size) throw bad('Some selected rows are no longer available within the applied filters and authorized scope. Refresh the report and select again.');
  }
  const total = results.length;
  const appliedFilters = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${label(k)}: ${options[k].find(o => o.value === v).label}`);
  if (needle) appliedFilters.push(`Search: ${input.search}`);
  if (input.dateField) appliedFilters.push(`${label(input.dateField)}: ${input.from || 'Any'} to ${input.to || 'Any'}`);
  if (input.sort) appliedFilters.push(`Sort: ${label(input.sort)} (${input.direction || 'asc'})`);
  if (input.selectedKeys) appliedFilters.push(`Selected rows: ${total} of ${matchingTotal} matching records`);
  return { title: module.title, matchingTotal, summary, columns: columns.map(k => module.fields.find(f => f.key === k)), options, total, page, pageSize, appliedFilters, records: (input.exportAll ? results : results.slice((page - 1) * pageSize, page * pageSize)).map(r => ({ key: r.key, ...Object.fromEntries(columns.map(k => [k, r.values[k]])) })) };
}
