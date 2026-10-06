// Match the Confrere profile's current-designation rule.
export async function officePersonDetails(prisma, person) {
  const appointments = person ? await prisma.appoint_transfer_dtl.findMany({
    where: { confrer_code: person.confrer_code, designation_end_date: null, is_active: true },
    select: { designation_code: true }, orderBy: { designation_appn_date: 'desc' },
  }) : [];
  const names = appointments.length ? await prisma.quickcode_mst.findMany({
    where: { quick_code_type: 'destyp', quick_code: { in: appointments.map(a => a.designation_code).filter(Boolean) } },
    select: { quick_code: true, quickcode_name: true },
  }) : [];
  const designation = [...new Set(appointments.map(a => names.find(n => n.quick_code === a.designation_code)?.quickcode_name).filter(Boolean))].join(', ') || 'Not available';
  const mobile = person?.personal1_contact_no;
  return { current_designations: designation, mobile_number: mobile == null || mobile === '' ? 'Not available' : [person.personal1_isd, String(mobile)].filter(Boolean).join(' ') };
}
