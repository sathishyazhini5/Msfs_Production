import express from 'express';
import {PrismaClient} from '@prisma/client';
import {PlatformService} from '../services/platformService.js';
import {resolveDataScope,sendScopeError} from '../utils/dataScope.js';
const db=new PrismaClient(),service=new PlatformService(db);
export const platformRouter=express.Router();
platformRouter.get('/platform/dashboard',async(req,res)=>{try{res.json(await service.dashboard(await resolveDataScope(req,db),req.query));}catch(e){sendScopeError(res,e,'Unable to load platform metrics.');}});
