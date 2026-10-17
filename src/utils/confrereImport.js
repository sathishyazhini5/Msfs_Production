import xlsx from 'xlsx';
import { createHash } from 'node:crypto';

export function normalizeTelephone(isdValue, numberValue, field = 'telephone') {
  const isdField = field.replace(/_contact_no$/, '_isd').replace(/_no$/, '_isd');
  let isd = String(isdValue ?? '').trim();
  let number = String(numberValue ?? '').trim();
  if (typeof numberValue === 'number' && !Number.isSafeInteger(numberValue)) throw new Error(`${field}: Excel number is not a safe integer; enter it as text.`);
  const area = isd.match(/^\+?(\d{1,3})\s*\((\d+)\)$/);
  if (area) { isd = `+${area[1]}`; }
  else if (isd) {
    if (!/^\+?\d{1,3}$/.test(isd)) throw new Error(`${isdField}: expected a country calling code such as +1 or +91.`);
    isd = `+${isd.replace(/^\+/, '')}`;
  }
  if (number) {
    if (!/^[\d\s().-]+$/.test(number)) throw new Error(`${field}: contains invalid telephone characters.`);
    number = number.replace(/\D/g, '');
    if (area) {
      // North American seven-digit local numbers need the supplied area code.
      if (area[1] === '1' && number.length === 7) number = area[2] + number;
      else if (!(number.startsWith(area[2]) && number.length > area[2].length)) throw new Error(`${field}: ambiguous area code; supply the full national number.`);
    }
    if (!number || number.length + isd.replace('+', '').length > 15) throw new Error(`${field}: telephone exceeds 15 international digits.`);
  } else if (area) throw new Error(`${field}: a local number is required with the area code.`);
  return { isd: isd || null, number: number || null };
}

export function excelDate(value, date1904 = false, field = 'date') {
  if (value == null || value === '') return null;
  let date;
  if (typeof value === 'number') {
    const parts = xlsx.SSF.parse_date_code(value, { date1904 });
    if (!parts || (!date1904 && value >= 60 && value < 61)) throw new Error(`${field}: invalid Excel date serial.`);
    date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  } else if (value instanceof Date) date = value;
  else {
    const text = String(value).trim();
    const parts = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/) || text.match(/^(\d{4})-(\d{2})-(\d{2})$/)?.map((v, i, a) => i === 1 ? a[3] : i === 3 ? a[1] : v);
    if (!parts) throw new Error(`${field}: use DD-MM-YYYY or YYYY-MM-DD.`);
    const [, d, m, y] = parts.map(Number);
    date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCDate() !== d || date.getUTCMonth() !== m - 1 || date.getUTCFullYear() !== y) throw new Error(`${field}: invalid calendar date.`);
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999) throw new Error(`${field}: invalid date.`);
  return date;
}

export const phoneFields = [
  ['Personal1 ISD', 'Personal1 Contact', 'personal1_isd', 'personal1_contact_no'],
  ['Personal2 ISD', 'Personal2 Contact', 'personal2_isd', 'personal2_contact_no'],
  ['Personal3 ISD', 'Personal3 Contact', 'personal3_isd', 'personal3_contact_no'],
  ['WhatsApp1 ISD', 'WhatsApp1', 'watsup1_isd', 'watsup1_no'],
  ['WhatsApp2 ISD', 'WhatsApp2', 'watsup2_isd', 'watsup2_no'],
  ['WhatsApp3 ISD', 'WhatsApp3', 'watsup3_isd', 'watsup3_no'],
  ['Emergency ISD', 'Emergency Contact', 'emergency_isd', 'emergency_contact_no'],
];

export function validateConfrerePayload(data) {
  const limits = { confrer_code: 15, province_code: 10, member_type_code: 10, first_name: 50, middle_name: 50, last_name: 50, image_file_name: 100, personal_mailid1: 255, blood_group_code: 10, nationality_code: 10, language_code: 2, created_by: 50, updated_by: 50 };
  for (const [, , isd, number] of phoneFields) { limits[isd] = 5; limits[number] = 15; }
  for (const [field, limit] of Object.entries(limits)) {
    if (data[field] != null && String(data[field]).length > limit) throw new Error(`${field}: maximum ${limit} characters; received ${String(data[field]).length}.`);
  }
  return data;
}

export function mapConfrereImportRow(row, codes, createdBy) {
  if (row.__mappingError__) throw new Error(row.__mappingError__);
  const text = key => row[key] == null ? null : String(row[key]).trim() || null;
  const data = { ...codes, first_name: text('First Name'), middle_name: text('Middle Name'), last_name: text('Last Name'), personal_mailid1: text('Email')?.toLowerCase() || null, language_code: text('Language Code') || 'en', created_by: createdBy, concurrency_val: 1 };
  if (!data.first_name) throw new Error('First Name: required.');
  for (const [header, field] of [['Date of Birth', 'birth_date'], ['Baptism Date', 'baptism_date'], ['Confirmation Date', 'confirmation_date'], ['First Profession Date', 'first_profession_date'], ['Final Profession Date', 'final_profession_date'], ['Ordination Date', 'ordination_date']]) data[field] = excelDate(row[header], row.__date1904__, header);
  for (const [isdHeader, numberHeader, isd, number] of phoneFields) {
    const normalized = normalizeTelephone(row[isdHeader], row[numberHeader], number);
    data[isd] = normalized.isd; data[number] = normalized.number;
  }
  return validateConfrerePayload(data);
}

export function importFingerprint(province, data) {
  const identity = { province, ...data };
  for (const field of ['created_by', 'created_date', 'concurrency_val']) delete identity[field];
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}

export function normalizeConfrerePhones(data, previous = {}) {
  const result = { ...data };
  for (const [, , isd, number] of phoneFields) {
    if (data[isd] === undefined && data[number] === undefined) continue;
    const phone = normalizeTelephone(data[isd] === undefined ? previous[isd] : data[isd], data[number] === undefined ? previous[number] : data[number], number);
    result[isd] = phone.isd; result[number] = phone.number;
  }
  return validateConfrerePayload(result);
}

// Failed rows may be downloaded by either the API or browser; canonical dates
// keep retries independent of the original workbook's 1900/1904 date system.
export function retryableConfrereRow(row) {
  const dateHeaders = ['Date of Birth', 'Baptism Date', 'Confirmation Date', 'First Profession Date', 'Final Profession Date', 'Ordination Date'];
  return Object.fromEntries(Object.entries(row).map(([key, original]) => {
    let value = original;
    if (dateHeaders.includes(key) && typeof value === 'number') {
      try { value = excelDate(value, row.__date1904__, key).toISOString().slice(0, 10); } catch { /* Retain invalid input for correction. */ }
    }
    return [key, value];
  }));
}
