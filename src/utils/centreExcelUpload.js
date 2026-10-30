import {storedCentreText} from './centreIdentifiers.js';
// Shared Centre form and Excel resolution. Quick Master is global; other records retain their scope.
const text = value => value == null ? '' : String(value).trim().replace(/\s+/g, ' ');
const normalized = value => text(value).toLowerCase();

async function named(db, model, field, name, where = {}, normalize = normalized) {
  const matches = (await db[model].findMany({ where }))
    .filter(record => (normalize(record[field]) === normalize(name) || normalized(record[{quickcode_name:'quick_code',country_name:'country_code',state_name:'state_code',division_name:'division_code',community_house_name:'community_house_code'}[field]]) === normalized(name)));
  if (matches.length > 1) throw new Error(`Ambiguous ${field}: "${name}" matches multiple records in this scope.`);
  return matches[0];
}

// Spreadsheet state names commonly omit word spacing (Tamilnadu / Tamil Nadu).
// Resolve only inside the same country and scope, and still reject ambiguity.
async function stateByName(db, name, province_code, country_code) {
  const compact = value => normalized(value).replace(/\s+/g, '');
  for (const normalize of [normalized, compact]) {
    for (const scope of [province_code, 'ALL']) {
      const state = await named(db, 'state_mst', 'state_name', name,
        { province_code: scope, country_code }, normalize);
      if (state) return state;
    }
  }
}

async function nextCode(db, model, field, prefix, where = {}, suffix = '') {
  const records = await db[model].findMany({ where, select: { [field]: true } });
  const pattern = new RegExp(`^${prefix}(\\d+)${suffix}$`);
  const maximum = records.reduce((max, record) => {
    const match = record[field].match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const code = `${prefix}${String(maximum + 1).padStart(3, '0')}${suffix}`;
  if (code.length > 10) throw new Error(`Cannot generate ${field}: code exceeds 10 characters.`);
  return code;
}

async function quick(db, category, name, audit) {
  const where = { quick_code_type: category };
  const existing = await named(db, 'quickcode_mst', 'quickcode_name', name, where);
  if (existing) return existing;
  return db.quickcode_mst.create({ data: {
    ...where, quick_code: await nextCode(db, 'quickcode_mst', 'quick_code', 'D', where),
    quickcode_name: name, ...audit,
  } });
}

const integer = (value, label, min, max) => {
  if (!/^\d+$/.test(text(value))) throw new Error(`${label} must be a whole number.`);
  const number = BigInt(text(value));
  if (number < min || number > max) throw new Error(`${label} is outside the supported range.`);
  return number;
};

export async function saveCentreExcelRow(prisma, source, context) {
  if (source.__parseError) throw new Error(source.__parseError);
  const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.trim(), text(value)]));
  const alias = (target, alternate) => { row[target] = row[target] || row[alternate]; };
  alias('Centre Type', 'Center Type');
  alias('Centre Type', 'Centre Type Name');
  alias('Apostolate/Department', 'Apostolate Name');
  alias('Name of the Centre', 'Name of the Center');
  alias('Place of the Centre', 'Place of the Center');
  alias('Name of the Diocese', 'Diocese');
  const required = ['Division Type', 'Name of the Division', 'Apostolate/Department', 'Centre Type',
    'Community House', 'Name of the Diocese', 'Name of the Centre', 'Place of the Centre',
    'Address 1', 'Address 2', 'Country', 'State', 'City/District'];
  const missing = required.filter(field => !row[field]);
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(', ')}`);
  const limits = { Country:100, State:100, 'Division Type': 100, 'Name of the Division': 50, 'Apostolate/Department': 100, 'Centre Type': 100,
    'Name of the Diocese': 100, 'Community House': 50, 'Name of the Centre': 100,
    'Place of the Centre': 100, 'City/District': 100, 'Personal1 ISD': 5,
    'Personal2 ISD': 5, 'Personal3 ISD': 5, 'WhatsApp ISD': 5,
    'Country ISD':5, 'State ISD':4, 'Office MailId 1': 255, 'Office MailId 2': 255, 'Office MailId 3': 255 };
  for (const [field, limit] of Object.entries(limits)) {
    if (row[field]?.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  }
  const data = {
    centre_name: source['Name of the Centre'] ?? source['Name of the Center'], centre_place: source['Place of the Centre'] ?? source['Place of the Center'],
    address1: source['Address 1'], address2: source['Address 2'], address3: source['Address 3'] ?? null,
    city_dist: source['City/District'], pin_zipcode: storedCentreText(source['Pin / Zipcode'], 'Pin / Zipcode', 32) ?? '',
  };
  for (const [prefix, header] of [['phone1', 'Personal1'], ['phone2', 'Personal2'], ['phone3', 'Personal3'], ['watsup', 'WhatsApp'], ['mobile1','Mobile1'], ['mobile2','Mobile2'], ['mobile3','Mobile3'], ['fax','Fax']]) {
    const contact = `${header} ${header === 'WhatsApp' ? 'no' : 'Contact'}`;
    data[`${prefix}_isd`] = source[`${header} ISD`] == null ? (prefix === 'phone1' ? '' : null) : String(source[`${header} ISD`]);
    data[`${prefix}_no`] = storedCentreText(source[contact], contact, 40) ?? (prefix === 'phone1' ? '' : null);
  }
  for (let index = 1; index <= 3; index++) {
    data[`office_mailid${index}`] = source[`Office MailId ${index}`] == null ? (index === 1 ? '' : null) : String(source[`Office MailId ${index}`]);
    data[`website${index}`] = source[`Official Website ${index}`] ?? null;
  }
  const concurrency = row['Concurrency Value'] || '1';
  const audit = { language_code: 'en', concurrency_val: 1, created_by: context.createdBy, created_date: new Date() };
  data.concurrency_val = Number(integer(concurrency, 'Concurrency Value', 0n, 2147483647n));

  // Serializable retries also protect name lookups and sequential code allocation
  // when two Excel uploads create the same missing master concurrently.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async db => {
        let province;
        const requested = row.Province || context.provinceCode || context.provinceName;
        if (!requested) throw new Error('Province is required in the row or authenticated user scope.');
        province = await db.province_mst.findUnique({ where: { province_code: requested } });
        if (!province) province = await named(db, 'province_mst', 'province_name', requested);
        if (!province || province.province_code === 'ALL') throw new Error(`Province "${requested}" was not found.`);
        const province_code = province.province_code;
        if (context.provinceCodes !== null && !context.provinceCodes.includes(province_code)) {
          throw new Error('Province is outside your authorized scope.');
        }
        const existing=context.centreIdentity ? await db.centre_dtl.findFirst({where:context.centreIdentity}) : null;
        if(context.centreIdentity && !existing)throw new Error('Centre changed or was deleted. Reload before saving.');
        let country = await named(db, 'country_mst', 'country_name', row.Country, { province_code })
          || await named(db, 'country_mst', 'country_name', row.Country, { province_code: 'ALL' });
        if (!country) {
          const isd = source['Country ISD'] == null ? '' : String(source['Country ISD']);
          country = await db.country_mst.create({data:{province_code,country_name:row.Country,country_code:await nextCode(db,'country_mst','country_code','CT'),ISD_code:isd,...audit}});
        }
        let state = await stateByName(db, row.State, province_code, country.country_code);
        if (!state) {
          const isd = source['State ISD'] == null ? '' : String(source['State ISD']);
          state = await db.state_mst.create({data:{province_code,country_code:country.country_code,state_name:row.State,state_code:await nextCode(db,'state_mst','state_code','ST'),ISD_code:isd,...audit}});
        }
        const divisionType = await quick(db, 'divtyp', row['Division Type'], audit);
        const divisionScope = { province_code, division_type_code: divisionType.quick_code };
        let division = await named(db, 'division_setup_mst', 'division_name', row['Name of the Division'], divisionScope);
        if (!division) {
          const existing = await db.division_setup_mst.findMany({ where: divisionScope });
          const maximum = existing.reduce((max, item) => {
            const match = item.division_code.match(/^D(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
          }, 0);
          const division_code = `D${maximum + 1}`;
          if (division_code.length > 10) throw new Error('Generated Division Code exceeds 10 characters.');
          division = await db.division_setup_mst.create({ data: {
            ...divisionScope, division_code, division_name: row['Name of the Division'], ...audit,
          } });
        }
        const scope = { province_code, division_type_code: divisionType.quick_code, division_code: division.division_code };
        const apostolate = await quick(db, 'apostl', row['Apostolate/Department'], audit);
        const centreType = await quick(db, 'ctrtyp', row['Centre Type'], audit);
        const diocese = await quick(db, 'diocse', row['Name of the Diocese'], audit);
        let house = await named(db, 'community_house_dtl', 'community_house_name', row['Community House'], scope);
        if (!house) house = await db.community_house_dtl.create({ data: {
          ...scope, community_house_name: row['Community House'], ...audit,
          community_house_code: await nextCode(db, 'community_house_dtl', 'community_house_code', 'CH', { province_code }, province_code),
        } });
        const mapping = { province_code, apostolate_code: apostolate.quick_code, centre_type_code: centreType.quick_code };
        if (!await db.apostolates_mst.findFirst({ where: mapping })) {
          await db.apostolates_mst.create({ data: { ...mapping, apostolate_name: apostolate.quickcode_name,
            centre_type_name: centreType.quickcode_name, ...audit } });
        }
        const resolved = {...data,...scope,...mapping,community_house_code:house.community_house_code,
          diocese_code:diocese.quick_code,country_code:country.country_code,state_code:state.state_code};
        // Shared contacts are valid. Only an identical complete row is a retry.
        // Do not use phone or email as a Centre's identity.
        if (!existing) {
          const prior=(await db.centre_dtl.findMany({where:scope})).find(centre=>Object.keys(resolved).every(key=>key==='concurrency_val' || normalized(centre[key])===normalized(resolved[key])));
          if(prior)return prior;
        }
        if(existing) return db.centre_dtl.update({where:{centre_code_province_code_division_type_code_division_code:context.centreIdentity},data:{...resolved,updated_by:context.createdBy,updated_date:new Date()}});
        return await db.centre_dtl.create({data:{...audit,...resolved,centre_code:await nextCode(db,'centre_dtl','centre_code','CEN')}});
      }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 });
    } catch (error) {
      if (!['P2034', 'P2002'].includes(error.code) || attempt === 2) throw error;
    }
  }
}
