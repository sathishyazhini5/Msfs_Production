import jwt from 'jsonwebtoken';
import {JWT_SECRET,EXPIRY_TIME} from '../config/index.js';
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
memberAccessRouter.post('/member-access',async(req,res)=>{try{const result=await service.provision(await resolveDataScope(req,db),req.body);if(result.status==='conflict')return res.status(409).json({error:`Member access was not changed (${result.reason}).`,...result});res.status(201).json(result);}catch(e){sendScopeError(res,e,'Unable to provision member access.');}});

memberAccessRouter.post('/member-access/change-initial-password',async(req,res)=>{
 try{
  const user=res.locals.user;
  if(user?.role_name!=='estatus member')return res.status(403).json({error:'This action is for member accounts.'});
  await service.changeInitialPassword(user.user_id,req.body.currentPassword,req.body.newPassword);
  const {iat,exp,password_change_required,password_version,...identity}=user;
  const access=await service.active(user.user_id);
  res.json({accessToken:jwt.sign({...identity,password_change_required:false,password_version:new Date(access.password_changed_at).getTime()},JWT_SECRET,{expiresIn:EXPIRY_TIME}),redirect:'/estatus'});
 }catch(error){sendScopeError(res,error,'Unable to change initial password.');}
});
