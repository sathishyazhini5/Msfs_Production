// Explicit member projection. Admin profiles keep their existing full responses.
const fields = new Set([
  'code', 'confrer_code', 'scholastic_code', 'centre_code', 'obituary_code', 'confrer_scholastic_code',
  'province_code', 'province_name', 'division_type_code', 'division_code', 'division_name',
  'name', 'first_name', 'middle_name', 'last_name', 'member_type_name', 'member_type_code',
  'nationality_name', 'nationality_code', 'image_file_name', 'image_file_path',
  'birth_date', 'baptism_date', 'confirmation_date', 'first_profession_date', 'final_profession_date', 'ordination_date',
  'personal_mailid1', 'personal1_contact_no', 'personal1_isd',
  'current_designation', 'previous_designations', 'current_centre_name', 'designation_name', 'designation_code',
  'centre_name', 'centre_type_name', 'apostolate_name', 'community_house_name', 'diocese_name',
  'appointment_date', 'installation_date', 'commencement_date', 'end_date', 'designation_end_date',
  'formation_type_name', 'scholastic_type_name', 'year_formation_name', 'promotion_to_name',
  'death_date', 'death_place', 'place', 'country_name', 'state_name',
  'phone1_no', 'phone1_isd', 'email', 'website', 'data',
]);
export function memberRecordProjection(value) {
  if (Array.isArray(value)) return value.map(memberRecordProjection);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, memberRecordProjection(item)]));
}
