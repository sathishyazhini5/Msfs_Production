import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
let serial = 0;
export async function loadController(relative, prisma, {send} = {}) {
  const url = new URL(relative, import.meta.url);
  const require = createRequire(url);
  const key = `test-prisma-${++serial}`;
  globalThis[key] = prisma;
  if (send) globalThis[`${key}-send`] = send;
  let source = await readFile(url, 'utf8');
  // Controller tests never contact SMTP; notifications are tested with injected senders.
  source = source.replace(/import \{accountAudit\} from [^;]+;/, 'const accountAudit = async () => {};');
  source = source.replace(/const prisma = new PrismaClient\(\);/, `const prisma = globalThis[${JSON.stringify(key)}];`);
  if (send) source = source.replace('send:sendAccountEmail', `send:globalThis[${JSON.stringify(`${key}-send`)}]`);
  source = source.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, url).href
      : isBuiltin(specifier) ? specifier : pathToFileURL(require.resolve(specifier)).href;
    return `from ${JSON.stringify(resolved)}`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${key}`);
}
export const response = (user = {}) => ({ statusCode: 200, locals: { user }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
export function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(value => matches(row, value));
    if (key === 'OR') return expected.some(value => matches(row, value));
    if (key === 'NOT') return !matches(row, expected);
    const actual = row[key] ?? null;
    if (expected === null) return actual === null;
    if (expected instanceof Date) return new Date(actual).getTime() === expected.getTime();
    if (typeof expected !== 'object') return actual === expected;
    if (!(key in row) && !['in', 'not', 'notIn', 'equals', 'contains'].some(op => op in expected)) return matches(row, expected);
    return Object.entries(expected).every(([op, value]) => {
      if (op === 'mode') return true;
      if (op === 'in') return value.includes(actual);
      if (op === 'notIn') return !value.includes(actual);
      if (op === 'not') return actual !== value;
      if (op === 'equals') return expected.mode === 'insensitive' ? String(actual).toLowerCase() === String(value).toLowerCase() : actual === value;
      if (op === 'contains') return String(actual || '').toLowerCase().includes(String(value).toLowerCase());
      throw new Error(`Unimplemented test matcher: ${op}`);
    });
  });
}
export function database(tables) {
  const db = { $disconnect: async () => {}, $executeRaw: async () => 1, $transaction: async fn => fn(db) };
  for (const [name, rows] of Object.entries(tables)) {
    const find = ({ where, select, skip = 0, take, orderBy } = {}) => {
      let result = rows.filter(row => matches(row, where));
      if (orderBy) for (const order of (Array.isArray(orderBy) ? orderBy : [orderBy]).slice().reverse()) {
        const [key, direction] = Object.entries(order)[0];
        result.sort((a,b) => String(a[key]).localeCompare(String(b[key])) * (direction === 'desc' ? -1 : 1));
      }
      return result.slice(skip, take === undefined ? undefined : skip + take).map(row => select ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : { ...row });
    };
    db[name] = {
      findMany: async args => find(args), findFirst: async args => find(args)[0] || null,
      findUnique: async args => find(args)[0] || null, count: async ({ where } = {}) => rows.filter(row => matches(row, where)).length,
      create: async ({ data }) => { const row = { ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => { const row = rows.find(row => matches(row, where)); if (!row) throw Object.assign(new Error('Missing record'), { code: 'P2025' }); Object.assign(row, Object.fromEntries(Object.entries(data).filter(([,value]) => value !== undefined))); return { ...row }; },
      updateMany: async ({ where, data }) => { rows.filter(row => matches(row, where)).forEach(row => Object.assign(row, data)); return {}; },
      deleteMany: async ({ where }) => { for (let i=rows.length-1;i>=0;i--) if (matches(rows[i],where)) rows.splice(i,1); return {}; },
      aggregate: async () => ({ _max: { confrer_seq_no: 0 } }),
    };
  }
  return db;
}
