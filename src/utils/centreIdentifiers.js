// Identifiers are text, never arithmetic. Reject values Excel may have rounded.
export function storedCentreText(value, field, maxLength) {
  if (value == null) return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15))
    throw Object.assign(new Error(`${field}: Excel numeric precision may be lost. Re-enter the original value in a Text cell.`), {status:400});
  const result = String(value);
  if (result.length > maxLength) throw Object.assign(new Error(`${field} exceeds ${maxLength} characters.`), {status:400});
  return result;
}

export function centreIdentifier(value, field, required = false) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15))
    throw Object.assign(new Error(`${field}: Excel numeric precision may be lost. Re-enter the original value in a Text cell.`), {status:400});
  let result = value == null ? '' : String(value).trim();
  if (!result) {
    if (required) throw Object.assign(new Error(`${field} is required.`), {status:400});
    return null;
  }
  if (/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(result)) {
    const match = result.match(/^(\+?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
    if (!match) throw Object.assign(new Error(`${field}: invalid scientific notation.`), {status:400});
    const digits = match[2] + (match[3] || '');
    const shift = Number(match[4]) - (match[3] || '').length;
    if (Math.abs(shift) > 40 || (shift < 0 && !digits.slice(shift).match(/^0+$/)))
      throw Object.assign(new Error(`${field}: use the original identifier as text.`), {status:400});
    result = match[1] + (shift >= 0 ? digits + '0'.repeat(shift) : (digits.slice(0, shift) || '0'));
  }
  const postal = field === 'Pin / Zipcode' || field === 'pin_zipcode';
  if (result.length > (postal ? 32 : 40) || !(postal ? /^[\p{L}\d][\p{L}\d -]*$/u : /^\+?[\d][\d ()-]*$/).test(result))
    throw Object.assign(new Error(`${field}: invalid ${postal ? 'postal code' : 'contact number'}.`), {status:400});
  return result;
}

export function normalizeCentreIdentifiers(source) {
  const data = {};
  for (const field of ['pin_zipcode', 'phone1_no', 'phone2_no', 'phone3_no', 'mobile1_no', 'mobile2_no', 'mobile3_no', 'watsup_no', 'fax_no']) {
    if (Object.hasOwn(source, field)) data[field] = centreIdentifier(source[field], field, ['pin_zipcode', 'phone1_no'].includes(field));
  }
  return data;
}
