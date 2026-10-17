import {localCalendar} from '../../services/annualWishService.js';
import {loadDashboardOccasions} from '../../services/dashboardOccasionsService.js';
import prisma from '../../utils/prisma.js';
import { resolveDataScope, provinceScopeWhere } from '../../utils/dataScope.js';
import express from 'express';
import { deleteEventById, getAllEvents, getEventById, saveEvent, updateEvent,sendEventMail } from '../../controllers/Msfs/Event_Dlt.js'
import { authenticate } from '../../middlewares/authenticate.js';


const router = express.Router();
router.get('/event-calendar-context', (req,res)=>res.json({today:localCalendar().date,timezone:process.env.APP_TIMEZONE || 'Asia/Kolkata'}));
router.get('/dashboard-occasions', async(req,res,next)=>{try {const {provinceCodes}=await resolveDataScope(req,prisma,req.query.province_code);res.json(await loadDashboardOccasions(prisma,provinceCodes,req.query.month));}catch(error){next(error);}});
router.get('/dashboard-event-provinces', async (req,res,next) => {
  try { const {provinceCodes} = await resolveDataScope(req,prisma); res.json(await prisma.province_mst.findMany({where:{...provinceScopeWhere(provinceCodes),NOT:{province_code:'ALL'}},select:{province_code:true,province_name:true}})); } catch(error){next(error);}
});
router.post('/saveevent',authenticate,saveEvent)
router.post('/sendEventMail',sendEventMail)
router.get('/getEvents',getEventById)
router.get('/getallEvent',getAllEvents)
router.put('/updateEvents', authenticate, updateEvent)
router.delete('/deleteEvents',deleteEventById)

export const eventRouter = router;
