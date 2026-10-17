// Read-only verification against the configured database. No mail or password changes.
import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { indexRouter } from '../src/routes/index.js';
const db=new PrismaClient();
const app=express();app.use(express.json());app.use((req,res,next)=>{req.cookies={};next();});app.use('/api',indexRouter);
app.use((error,req,res,next)=>res.status(error.status || 500).json({message:error.message}));
const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
const base=`http://127.0.0.1:${server.address().port}/api`;
const originalLog=console.log;console.log=()=>{};
try {
  const links=await db.memberAccess.findMany({where:{enabled:true,password_changed_at:null,password_initialized_at:{not:null}},orderBy:{created_at:'asc'}});
  const offices=await db.curia_advisors_dtl.findMany({select:{confrer_code:true,province_code:true}});
  const samples=[
    ['Confrere',links.find(link=>link.person_kind==='Confrere')],
    ['Scholastic',links.find(link=>link.person_kind==='Scholastic')],
    ['Curia overlap',links.find(link=>link.person_kind==='Curia'||offices.some(office=>office.confrer_code===link.person_code&&office.province_code===link.province_code))],
  ];
  const results=[];
  for(const [kind,link] of samples){
    if(!link){results.push({kind,status:'no_eligible_sample'});continue;}
    const signIn=await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:link.user_id,password:'pass123'})});
    assert.equal(signIn.status,200);const identity=await signIn.json();assert.equal(identity.redirect,'/estatus');assert.equal(identity.data.role_name,'estatus member');assert.equal(identity.data.password,undefined);
    const headers={Authorization:`Bearer ${identity.accessToken}`};
    const list=await fetch(`${base}/estatus/confrere?province_code=${link.province_code}&page=1&pageSize=5`,{headers});assert.equal(list.status,200);const rows=await list.json();assert.ok(Array.isArray(rows.data));
    const filters=await fetch(`${base}/estatus/confrere/filters?province_code=${link.province_code}`,{headers});assert.equal(filters.status,200);
    const directoryKind=link.person_kind==='Scholastic'?'scholastic':'confrere';
    const details=await fetch(`${base}/estatus/${directoryKind}/record/${encodeURIComponent(link.person_code)}?province_code=${link.province_code}`,{headers});assert.equal(details.status,200);const profile=await details.json();
    assert.equal(profile.password,undefined);assert.equal(profile.password_hash,undefined);assert.equal(profile.feedbacks,undefined);
    for(const path of ['/platform/dashboard','/getusers','/estatus/confrere/export'])assert.equal((await fetch(base+path,{headers})).status,403);
    const foreign=await db.province_mst.findFirst({where:{concretion_code:{not:link.concretion_code}}});
    if(foreign){
      assert.equal((await fetch(`${base}/estatus/confrere?province_code=${foreign.province_code}`,{headers})).status,403);
      assert.equal((await fetch(`${base}/estatus/${directoryKind}/record/${encodeURIComponent(link.person_code)}?province_code=${foreign.province_code}`,{headers})).status,404);
    }
    results.push({kind,status:'passed',redirect:identity.redirect,list:true,filters:true,detail:true,adminDenied:true,crossCongregationDenied:Boolean(foreign)});
  }
  originalLog(JSON.stringify({environment:'confirmed-development',readOnly:true,results}));
} finally {console.log=originalLog;await new Promise(resolve=>server.close(resolve));await db.$disconnect();}
