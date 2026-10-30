import { Prisma } from '@prisma/client';

export const filterFields = {
  confrere: ['province_code', 'division', 'member_type_code', 'designation_code', 'nationality_code', 'apostolate_code'],
  scholastic: ['province_code', 'division', 'member_type_code', 'nationality_code', 'scholastic_type_code', 'formation_type_code', 'year_formation_code'],
  centre: ['province_code', 'division', 'apostolate_code', 'centre_type_code', 'diocese_code', 'community_house_code', 'state', 'country_code'],
  obituary: ['province_code'],
};
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
export const parseDirectoryQuery = (kind, query) => {
  if (!Object.hasOwn(filterFields, kind)) throw Object.assign(new Error('Directory not found.'), { status: 404 });
  const allowed = new Set([...filterFields[kind], 'search', 'page', 'pageSize', ...(kind === 'obituary' ? ['mode', 'death_date', 'from', 'to', 'month', 'year'] : [])]);
  const values = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== 'string' || value.length > 150) throw badRequest(`Invalid parameter: ${key}`);
    if (value.trim()) values[key] = value.trim();
  }
  for (const [key, max, fallback] of [['page', 1000000, 1], ['pageSize', 100, 20]]) {
    if (values[key] && (!/^\d+$/.test(values[key]) || Number(values[key]) < 1 || Number(values[key]) > max)) throw badRequest(`Invalid ${key}.`);
    values[key] = Number(values[key] || fallback);
  }
  if (values.search?.length > 100) throw badRequest('Search text is too long.');
  if (values.mode && !['today', 'all'].includes(values.mode)) throw badRequest('Invalid obituary mode.');
  if (values.death_date && (!/^\d{4}-\d{2}-\d{2}$/.test(values.death_date) || !Number.isFinite(Date.parse(values.death_date)) || new Date(values.death_date).toISOString().slice(0, 10) !== values.death_date)) throw badRequest('Invalid death date.');
  for(const key of ['from','to'])if(values[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(values[key])||!Number.isFinite(Date.parse(values[key]))||new Date(values[key]).toISOString().slice(0,10)!==values[key]))throw badRequest('Invalid obituary date.');
  if(values.from&&values.to&&values.from>values.to)throw badRequest('From Date must be on or before To Date.');
  if(values.death_date&&(values.from||values.to))throw badRequest('Choose a date range or one Death date.');
  for (const [key, min, max] of [['month', 1, 12], ['year', 1000, 9998]]) {
    if (values[key] && (!/^\d+$/.test(values[key]) || Number(values[key]) < min || Number(values[key]) > max)) throw badRequest(`Invalid ${key}.`);
  }
  return values;
};
const scopeSql = (alias, codes) => codes === null ? Prisma.sql`TRUE`
  : codes.length ? Prisma.sql`${Prisma.raw(`${alias}.province_code`)} IN (${Prisma.join(codes)})` : Prisma.sql`FALSE`;
const option = (value, label) => ({ value, label: label || value });
const uniqueOptions = (rows) => [...new Map(rows.map((row) => [row.value, row])).values()].sort((a, b) => a.label.localeCompare(b.label));

// Composite values preserve province/type ownership when codes repeat across provinces.
export const loadDirectoryOptions = async (prisma, kind, codes, filters) => {
  const where = codes === null ? {} : { province_code: { in: codes } };
  const scoped = filters.province_code ? { province_code: filters.province_code } : where;
  const provinces = await prisma.province_mst.findMany({ where: { ...where, NOT: { province_code: 'ALL' } }, select: { province_code: true, province_name: true } });
  if (kind === 'obituary') return { province_code: uniqueOptions(provinces.map((p) => option(p.province_code, p.province_name))) };
  const [divisions, quickcodes] = await Promise.all([
    prisma.division_setup_mst.findMany({ where: scoped, select: { province_code: true, division_type_code: true, division_code: true, division_name: true } }),
    prisma.quickcode_mst.findMany({ where: { quick_code_type: { in: ['memtyp', 'destyp', 'natlty', 'diocse', 'schtyp', 'fortyp', 'yrform'] } }, select: { quick_code_type: true, quick_code: true, quickcode_name: true } }),
  ]);
  const options = {
    province_code: uniqueOptions(provinces.map((p) => option(p.province_code, p.province_name))),
    division: uniqueOptions(divisions.map((d) => option(JSON.stringify([d.province_code, d.division_type_code, d.division_code]), filters.province_code ? d.division_name : `${d.division_name} (${provinces.find((p) => p.province_code === d.province_code)?.province_name || d.province_code})`))),
  };
  const quick = (type) => uniqueOptions(quickcodes.filter((q) => q.quick_code_type === type).map((q) => option(q.quick_code, q.quickcode_name)));
  if (kind === 'confrere') {
    const apostolates = await prisma.apostolates_mst.findMany({ where: scoped, select: { apostolate_code: true, apostolate_name: true } });
    return { ...options, member_type_code: quick('memtyp'), designation_code: quick('destyp'), nationality_code: quick('natlty'), apostolate_code: uniqueOptions(apostolates.map(a => option(a.apostolate_code, a.apostolate_name))) };
  }
  if (kind === 'scholastic') return { ...options, member_type_code: quick('memtyp'), nationality_code: quick('natlty'), scholastic_type_code: quick('schtyp'), formation_type_code: quick('fortyp'), year_formation_code: quick('yrform') };
  let division = null;
  if (filters.division) {
    const row = divisions.find((d) => JSON.stringify([d.province_code, d.division_type_code, d.division_code]) === filters.division);
    if (!row) throw badRequest('Invalid Division for selected Province.');
    division = { province_code: row.province_code, division_type_code: row.division_type_code, division_code: row.division_code };
  }
  const [apostolates, communities, states, countries, dioceses] = await Promise.all([
    prisma.apostolates_mst.findMany({ where: scoped, select: { apostolate_code: true, apostolate_name: true, centre_type_code: true, centre_type_name: true } }),
    prisma.community_house_dtl.findMany({ where: division || scoped, select: { community_house_code: true, community_house_name: true } }),
    prisma.state_mst.findMany({ where: { ...scoped, ...(filters.country_code ? { country_code: filters.country_code } : {}) }, select: { state_code: true, state_name: true, country_code: true } }),
    prisma.country_mst.findMany({ where: scoped, select: { country_code: true, country_name: true } }),
    prisma.centre_dtl.findMany({ where: scoped, distinct: ['diocese_code'], select: { diocese_code: true } }),
  ]);
  const dioceseNames = new Map(quickcodes.filter((q) => q.quick_code_type === 'diocse').map((q) => [q.quick_code, q.quickcode_name]));
  return { ...options,
    apostolate_code: uniqueOptions(apostolates.map((a) => option(a.apostolate_code, a.apostolate_name))),
    centre_type_code: uniqueOptions(apostolates.filter((a) => !filters.apostolate_code || a.apostolate_code === filters.apostolate_code).map((a) => option(a.centre_type_code, a.centre_type_name))),
    diocese_code: uniqueOptions(dioceses.map((d) => option(d.diocese_code, dioceseNames.get(d.diocese_code)))),
    community_house_code: uniqueOptions(communities.map((c) => option(c.community_house_code, c.community_house_name))),
    state: uniqueOptions(states.map((s) => option(JSON.stringify([s.country_code, s.state_code]), s.state_name))),
    country_code: uniqueOptions(countries.map((c) => option(c.country_code, c.country_name))),
  };
};

export const directorySql = (kind, filters, codes) => {
  const clauses = [scopeSql('r', codes)];
  if (filters.province_code) clauses.push(Prisma.sql`r.province_code = ${filters.province_code}`);
  if (['confrere', 'scholastic'].includes(kind)) clauses.push(Prisma.sql`r.is_active = TRUE`);
  if (kind === 'obituary') {
    if (filters.death_date) clauses.push(Prisma.sql`(r.death_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = ${filters.death_date}::date`);
    else if (filters.month || filters.year) {
      if (filters.year) {
        const year = Number(filters.year), month = Number(filters.month || 1);
        const start = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+05:30`);
        const endYear = filters.month && month < 12 ? year : year + 1;
        const endMonth = filters.month && month < 12 ? month + 1 : 1;
        const end = new Date(`${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00+05:30`);
        clauses.push(Prisma.sql`r.death_date >= ${start} AND r.death_date < ${end}`);
      } else clauses.push(Prisma.sql`EXTRACT(MONTH FROM (r.death_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')) = ${Number(filters.month)}`);
    }
    else if(filters.from||filters.to){
      if(filters.from)clauses.push(Prisma.sql`r.death_date >= ${new Date(`${filters.from}T00:00:00+05:30`)}`);
      if(filters.to)clauses.push(Prisma.sql`r.death_date < ${new Date(new Date(`${filters.to}T00:00:00+05:30`).getTime()+86400000)}`);
    }
    else if (filters.mode !== 'all') clauses.push(Prisma.sql`(r.death_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`);
  }
  for (const field of filterFields[kind].filter((f) => !['province_code', 'division', 'state', 'designation_code', 'scholastic_type_code', 'formation_type_code', 'year_formation_code'].includes(f))) {
    if (filters[field] && !(kind === 'confrere' && field === 'apostolate_code')) clauses.push(Prisma.sql`${Prisma.raw(`r.${field}`)} = ${filters[field]}`);
  }
  if (filters.state) {
    const [country, state] = JSON.parse(filters.state);
    clauses.push(Prisma.sql`r.country_code = ${country} AND r.state_code = ${state}`);
  }
  const appointment = [];
  if (filters.division) {
    const [province, type, division] = JSON.parse(filters.division);
    const alias = ['confrere', 'scholastic'].includes(kind) ? 'a' : 'r';
    clauses.push(Prisma.sql`r.province_code = ${province}`);
    const clause = Prisma.sql`${Prisma.raw(`${alias}.province_code`)} = ${province} AND ${Prisma.raw(`${alias}.division_type_code`)} = ${type} AND ${Prisma.raw(`${alias}.division_code`)} = ${division}`;
    if (['confrere', 'scholastic'].includes(kind)) appointment.push(clause); else clauses.push(clause);
  }
  if (kind === 'scholastic') {
    for (const field of ['scholastic_type_code', 'formation_type_code', 'year_formation_code']) if (filters[field]) appointment.push(Prisma.sql`${Prisma.raw(`a.${field}`)} = ${filters[field]}`);
    if (appointment.length) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM scholastics_admisn_promon_dtl a WHERE a.scholastic_code = r.scholastic_code AND a.province_code = r.province_code AND a.end_date IS NULL AND ${scopeSql('a', codes)} AND ${Prisma.join(appointment, ' AND ')})`);
  }
  if (filters.designation_code) appointment.push(Prisma.sql`a.designation_code = ${filters.designation_code}`);
  if (kind !== 'scholastic' && appointment.length) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM appoint_transfer_dtl a WHERE a.confrer_code = r.confrer_code AND a.province_code = r.province_code AND a.is_active = TRUE AND ${scopeSql('a', codes)} AND ${Prisma.join(appointment, ' AND ')})`);
  if (kind === 'confrere' && filters.apostolate_code) {
    // Appointments and transfers share a table; older records are archived in history.
    // EXISTS avoids multiplying people/counts when several assignments match.
    const matchesApostolate = table => Prisma.sql`EXISTS (
      SELECT 1 FROM ${Prisma.raw(table)} ap
      JOIN centre_dtl ct ON ct.centre_code = ap.centre_code
        AND ct.province_code = ap.province_code
        AND ct.division_type_code = ap.division_type_code
        AND ct.division_code = ap.division_code
      JOIN apostolates_mst am ON am.apostolate_code = ct.apostolate_code
        AND am.province_code = ct.province_code AND am.centre_type_code = ct.centre_type_code
      WHERE ap.confrer_code = r.confrer_code AND ${scopeSql('ap', codes)}
        AND am.apostolate_code = ${filters.apostolate_code}
    )`;
    clauses.push(Prisma.sql`(${matchesApostolate('appoint_transfer_dtl')} OR ${matchesApostolate('appoint_transfer_his_dtl')})`);
  }
  const name = kind === 'centre' ? Prisma.sql`r.centre_name` : ['confrere', 'scholastic'].includes(kind)
    ? Prisma.sql`btrim(concat_ws(' ', r.first_name, r.middle_name, r.last_name))`
    : Prisma.sql`btrim(regexp_replace(coalesce(nullif(btrim(concat_ws(' ', coalesce(c.first_name, s.first_name), coalesce(c.middle_name, s.middle_name), coalesce(c.last_name, s.last_name))), ''), nullif(btrim(r.disease_name), ''), 'Name unavailable'), '[[:space:]]+', ' ', 'g'))`;
  if (filters.search) {
    const pattern = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(Prisma.sql`${name} ILIKE ${pattern}`);
  }
  const table = { confrere: 'confreres_dtl', scholastic: 'scholastics_dtl', centre: 'centre_dtl', obituary: 'obituary_dtl' }[kind];
  // Confrere codes are globally unique; scholastic codes have province ownership.
  // Legacy obituary imports store the deceased's name in disease_name when no relation exists.
  const joins = kind === 'obituary' ? Prisma.sql`LEFT JOIN confreres_dtl c ON c.confrer_code = r.confrer_scholastic_code LEFT JOIN scholastics_dtl s ON s.scholastic_code = r.confrer_scholastic_code AND s.province_code = r.province_code` : Prisma.empty;
  const from = Prisma.sql`FROM ${Prisma.raw(table)} r LEFT JOIN province_mst p ON p.province_code = r.province_code ${joins} WHERE ${Prisma.join(clauses, ' AND ')}`;
  const id = Prisma.raw(`r.${kind === 'confrere' ? 'confrer_code' : kind === 'scholastic' ? 'scholastic_code' : kind === 'centre' ? 'centre_code' : 'obituary_code'}`);
  const extra = kind === 'centre' ? Prisma.sql`r.division_type_code, r.division_code, r.centre_place,` : kind === 'obituary' ? Prisma.sql`r.confrer_scholastic_code, r.death_date, r.death_place, r.member_type_code,` : Prisma.sql`r.member_type_code, r.image_file_path,`;
  return {
    count: Prisma.sql`SELECT count(*)::int AS total ${from}`,
    rows: Prisma.sql`SELECT ${id} AS code, r.province_code, p.province_name, ${extra} ${name} AS name ${from} ORDER BY ${kind === 'obituary' ? Prisma.sql`r.death_date DESC NULLS LAST,` : Prisma.empty} ${name} ASC, ${id} ASC, r.province_code ASC ${kind === 'centre' ? Prisma.sql`, r.division_type_code, r.division_code` : kind === 'obituary' ? Prisma.sql`, r.confrer_scholastic_code` : Prisma.empty} ${filters.exportAll?Prisma.empty:Prisma.sql`LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}`}`,
  };
};

// Resolve applied values against the same scoped options used to validate the query.
// Composite option values stay intact; arrays represent multiple selected options.
export const appliedDirectoryFilters = (kind, filters, options) => filterFields[kind].flatMap(field => {
  const selected = Array.isArray(filters[field]) ? filters[field] : [filters[field]];
  const names = selected.filter(Boolean).map(value => options[field]?.find(item => item.value === value)?.label).filter(Boolean);
  return names.length ? [{ field, values: names }] : [];
});

export const fetchDirectory = async (prisma, kind, filters, codes) => {
  const options = await loadDirectoryOptions(prisma, kind, codes, filters);
  for (const field of filterFields[kind]) {
    if (filters[field] && !options[field]?.some((o) => o.value === filters[field])) throw badRequest(`Invalid ${field} for selected filters.`);
  }
  const sql = directorySql(kind, filters, codes);
  const [counts, rows, members] = await prisma.$transaction([
    prisma.$queryRaw(sql.count), prisma.$queryRaw(sql.rows),
    prisma.quickcode_mst.findMany({ where: { quick_code_type: 'memtyp' }, select: { quick_code: true, quickcode_name: true } }),
  ]);
  const names = new Map(members.map((m) => [m.quick_code, m.quickcode_name]));
  return { appliedFilters: appliedDirectoryFilters(kind, filters, options), data: rows.map((r) => ({ ...r, member_type_name: names.get(r.member_type_code) || null })), total: counts[0].total, page: filters.page, pageSize: filters.pageSize, totalPages: Math.ceil(counts[0].total / filters.pageSize) };
};
