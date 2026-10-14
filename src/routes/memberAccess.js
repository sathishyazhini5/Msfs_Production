import express from 'express';
import {PrismaClient} from '@prisma/client';
import {MemberAccessService} from '../services/memberAccessService.js';
import {resolveDataScope,sendScopeError} from '../utils/dataScope.js';
const db=new PrismaClient(),service=new MemberAccessService({db});
export const memberAccessRouter=express.Router();
memberAccessRouter.get('/member-access/candidates',async(req,res)=>{try{
 const scope=await resolveDataScope(req,db);
 const search=String(req.query.search || '');if(search.length>100)throw Object.assign(new Error('Search is too long.'),{status:400});
 const page=Number(req.query.page || 1);if(!Number.isInteger(page)||page<1)throw Object.assign(new Error('Invalid page.'),{status:400});
 const rows=await service.directory(scope,search);res.json({records:rows.slice((page-1)*25,page*25),total:rows.length,page});
}catch(e){sendScopeError(res,e,'Unable to load member identities.');}});
memberAccessRouter.post('/member-access',async(req,res)=>{try{res.status(201).json(await service.provision(await resolveDataScope(req,db),req.body));}catch(e){sendScopeError(res,e,'Unable to provision member access.');}});
