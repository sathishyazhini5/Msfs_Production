import test from 'node:test';
import assert from 'node:assert/strict';
import {requestAdminReset,completeAdminReset} from '../src/services/adminResetService.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {createAuthenticate} from '../src/middlewares/authenticate.js';
import {JWT_SECRET} from '../src/config/index.js';
import {response} from './helpers/controllerHarness.js';
function fixture() {
 let token; const mails=[],audits=[];
 const user={user_id:'admin@example.test',prov_concre_code:'P1',role_name:'Province Admin',must_change_password:true};
 const match=where=>token && Object.entries(where).every(([key,value])=>value?.lt!==undefined?token[key]<value.lt:value?.gt!==undefined?token[key]>value.gt:token[key]===value);
 const db={memberPasswordToken:{findUnique:async()=>token,upsert:async({create,update})=>token=token?{...token,...update}:create,updateMany:async({where})=>{if(!match(where))return {count:0};token.attempts++;return {count:1};},deleteMany:async({where})=>{if(!match(where))return {count:0};token=undefined;return {count:1};}},users_mst:{update:async({data})=>Object.assign(user,data)},$transaction:async fn=>fn(db)};
 const deps={send:async(...args)=>mails.push(args),audit:async(...args)=>audits.push(args)};
 return {db,user,deps,mails,audits,get token(){return token;}};
}
test('private admin reset link is hashed, single-use, and never passed to the audit sender',async()=>{
 const f=fixture();await requestAdminReset(f.db,f.user,f.deps);await requestAdminReset(f.db,f.user,f.deps);assert.equal(f.mails.length,1);
 const url=new URL(f.mails[0][2].match(/https:\/\/\S+/)[0]);const secret=url.searchParams.get('token');assert.notEqual(secret,f.token.token_hash);
 assert.equal(f.audits[0].length,3);assert.equal(f.audits[0][2],'reset requested');
 const password='New-private-password-2026';await completeAdminReset(f.db,f.user,secret,password,f.deps);
 assert.equal(f.user.must_change_password,false);assert.ok(await bcrypt.compare(password,f.user.password));assert.equal(f.audits.at(-1)[2],'reset completed');assert.equal(f.audits.at(-1).length,3);
 await assert.rejects(completeAdminReset(f.db,f.user,secret,password,f.deps),/invalid or expired/);
});
test('expired admin reset links fail without updating the account',async()=>{
 const f=fixture();await requestAdminReset(f.db,f.user,f.deps);f.token.expires_at=new Date(0);
 await assert.rejects(completeAdminReset(f.db,f.user,'invalid','New-private-password-2026',f.deps),/invalid or expired/);
 assert.equal(f.user.password,undefined);
});
test('temporary-password sessions cannot access data before or after the password is changed',async()=>{
 const account={user_id:'admin@example.test',role_name:'Super Admin',must_change_password:true};
 const authenticate=createAuthenticate({users_mst:{findFirst:async()=>account}});
 const token=jwt.sign({user_id:account.user_id,role_name:account.role_name,password_change_required:true},JWT_SECRET);
 const req={path:'/GetProvinces',cookies:{},header:()=>`Bearer ${token}`};
 for(const required of [true,false]){
   account.must_change_password=required;const res=response();await authenticate(req,res,()=>assert.fail('temporary session accessed data'));assert.equal(res.statusCode,403);
 }
 let allowed=false;await authenticate({...req,path:'/auth/change-password'},response(),()=>{allowed=true;});assert.equal(allowed,true);
});
