import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma.js';
import {JWT_SECRET} from '../config/index.js';
import {sendAccountEmail} from '../middlewares/emailService.js';
import {MemberOtpService} from '../services/memberOtpService.js';
const service = new MemberOtpService(prisma,sendAccountEmail);
export const memberOtpRouter = express.Router();
// Fixed-window limits bound work before any identity lookup. Per-email cooldown is persistent.
const requests = new Map();
memberOtpRouter.use('/auth/member-otp', (req,res,next) => {
  const key = req.ip, now = Date.now();
  for (const [ip, entry] of requests) if (entry.until <= now) requests.delete(ip);
  const entry = requests.get(key) || {count:0,until:now+900000};
  requests.set(key,entry);
  if (++entry.count > 30) return res.status(429).json({error:'Too many attempts. Try again later.'});
  res.set('Cache-Control','no-store'); res.set('Referrer-Policy','no-referrer'); next();
});
memberOtpRouter.post('/auth/member-otp/request',async(req,res) => {
  try { await service.request(req.body.email); }
  catch { /* Keep eligibility and delivery outcomes private; a later resend can retry. */ }
  res.json({message:'If eligible, a code has been sent. Wait one minute before resending.'});
});
memberOtpRouter.post('/auth/member-otp/verify',async(req,res) => {
  try {
    const result = await service.verify(req.body.email,req.body.otp,req.body.identity,req.get('user-agent'));
    if (result.choices) return res.json(result);
    const session=result.session;
    res.json({accessToken:jwt.sign({role_name:'estatus member',member_session:session.id,province_code:session.identity.province_code,concretion_code:session.identity.concretion_code},JWT_SECRET,{expiresIn:'8h'}),data:{role_name:'estatus member'},redirect:'/estatus'});
  } catch(error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to verify code.'}); }
});
memberOtpRouter.get('/auth/member-otp/revoke',async(req,res) => {
  try {
    await service.revoke(req.query.session,req.query.token);
    // POST to this same URL; GETs from email scanners never revoke a session.
    res.type('html').send('<!doctype html><html><title>Revoke E-Status session</title><meta name="referrer" content="no-referrer"><body><h1>Revoke this sign-in?</h1><form method="post"><button type="submit">Confirm: Not me / revoke this session</button></form></body></html>');
  } catch { res.status(400).send('This security link is invalid or expired.'); }
});
memberOtpRouter.post('/auth/member-otp/revoke',async(req,res) => {
  try { await service.revoke(req.query.session,req.query.token,true); res.send('Session revoked.'); }
  catch { res.status(400).send('This security link is invalid or expired.'); }
});
