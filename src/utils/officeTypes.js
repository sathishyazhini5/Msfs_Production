// Resolve deployed metadata instead of inventing aliases for existing categories.
export async function officeCategories(prisma) {
  const rows = await prisma.meta_data_mst.findMany({ where: { screen_code: 'qckcode' } });
  const category = (prefix, fallback) => rows.find(row => row.meta_code === fallback)?.meta_code
    || rows.find(row => new RegExp(`^${prefix}`, 'i').test(row.meta_code_name.trim()))?.meta_code
    || fallback;
  return { pcic: category('PCIC', 'pcicof'), gcic: category('GCIC', 'gcicof') };
}

export async function validateOfficeSelections(prisma, data) {
  const categories = await officeCategories(prisma);
  for (const [field, category] of [['pcic_off_code', categories.pcic], ['gcic_off_code', categories.gcic]]) {
    if (data[field] == null || data[field] === '') continue;
    if (typeof data[field] !== 'string' || data[field].length > 10 || !await prisma.quickcode_mst.findFirst({
      where: { quick_code_type: category, quick_code: data[field] },
    })) throw Object.assign(new Error(`Invalid ${field}: select an existing office type.`), { status: 400 });
  }
}

export async function officeRecordWhere(prisma, type) {
  const active = await prisma.confreres_dtl.findMany({ where: { is_active: true }, select: { confrer_code: true } });
  return {
    [type === 'GCIC' ? 'gcic_off_code' : 'pcic_off_code']: { not: null, notIn: [''] },
    confrer_code: { in: active.map(row => row.confrer_code) },
  };
}
