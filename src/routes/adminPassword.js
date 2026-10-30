import express from 'express';
import bcrypt from 'bcrypt';
import {authenticate} from '../middlewares/authenticate.js';
import prisma from '../utils/prisma.js';
export const adminPasswordRouter=express.Router();
adminPasswordRouter.post('/auth/change-password',authenticate,async(req,res)=>{
  try {
    if(res.locals.user.role_name==='estatus member')return res.status(403).json({error:'Member access is read-only.'});
    const user=await prisma.users_mst.findUnique({where:{user_id:res.locals.user.user_id}});
    const password=req.body.newPassword;
    if(!user || !user.must_change_password || !await bcrypt.compare(String(req.body.currentPassword || ''),user.password))return res.status(403).json({error:'Unable to change this password.'});
    if(typeof password!=='string'||password.length<12||password.length>128 || await bcrypt.compare(password,user.password))return res.status(400).json({error:'Choose a different password with 12–128 characters.'});
    const result=await prisma.users_mst.updateMany({where:{user_id:user.user_id,password:user.password},data:{password:await bcrypt.hash(password,12),must_change_password:false}});
    if(result.count!==1)return res.status(409).json({error:'Password changed concurrently. Sign in again.'});
    res.json({message:'Password changed. Sign in with your new password.'});
  }catch{res.status(500).json({error:'Unable to change password.'});}
});
