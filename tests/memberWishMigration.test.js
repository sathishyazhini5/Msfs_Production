import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PrismaClient} from '@prisma/client';
const connection=process.env.CIRCULAR_TEST_DATABASE_URL;
test('additive migration and annual event unique identity prevent concurrent PM2 reservations',{skip:!connection},async()=>{
 const schema=`member_wish_test_${Date.now()}_${randomUUID().replaceAll('-','').slice(0,8)}`;assert.match(schema,/^member_wish_test_[a-z0-9_]+$/);
 const base=new PrismaClient({datasources:{db:{url:connection}}});let db;
 try{
  await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(connection);url.searchParams.set('schema',schema);db=new PrismaClient({datasources:{db:{url:url.toString()}}});
  assert.equal((await db.$queryRaw`SELECT current_schema() AS name`)[0].name,schema);
  await db.$executeRawUnsafe('CREATE TABLE "users_mst" ("user_id" VARCHAR(100) PRIMARY KEY)');
  const sql=await readFile(new URL('../src/prisma/migrations/20261014120000_member_access_annual_wishes/migration.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').filter(s=>s.trim()))await db.$executeRawUnsafe(statement);
  const claims=await Promise.allSettled(Array.from({length:8},()=>db.$executeRaw`INSERT INTO "AnnualWish" (person_identity,id,concretion_code,person_kind,person_code,province_code,event,year) VALUES ('Confrere:F1',${randomUUID()}::uuid,'C1','Confrere','F1','P1','Birthday',2026)`));
  assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);assert.equal((await db.$queryRaw`SELECT count(*)::int AS count FROM "AnnualWish"`)[0].count,1);
  await db.$executeRaw`UPDATE "AnnualWish" SET status='Retryable'`;
  const retries=await Promise.all(Array.from({length:8},()=>db.$executeRaw`UPDATE "AnnualWish" SET status='Processing',attempts=attempts+1 WHERE status='Retryable' AND attempts<3`));assert.equal(retries.reduce((a,b)=>a+b,0),1);
  await db.$executeRaw`INSERT INTO "users_mst" (user_id) VALUES ('member@example.test')`;
  await db.$executeRaw`INSERT INTO "MemberAccess" (user_id,person_kind,person_code,province_code,concretion_code,created_by) VALUES ('member@example.test','Confrere','F1','P1','C1','admin')`;
  assert.equal((await db.$queryRaw`SELECT enabled FROM "MemberAccess"`)[0].enabled,true);
 }finally{
  if(db)await db.$disconnect();assert.match(schema,/^member_wish_test_[a-z0-9_]+$/);await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await base.$disconnect();
 }
});
