import {NODE_ENV} from '../config/index.js';
import cron from 'node-cron';
import {sendTodayAnniversaries} from '../controllers/Msfs/anniversarynotification.js';
import {logger} from '../utils/logger.js';
export const anniversaryJob=cron.schedule('0 0 * * *',async()=>{
 try{await sendTodayAnniversaries();}catch(error){logger.error(`Annual wish job failed: ${error.code || error.name}`);}
},{timezone:process.env.APP_TIMEZONE || 'Asia/Kolkata',scheduled:process.env.ANNIVERSARY_EMAILS_ENABLED==='true' || (process.env.ANNIVERSARY_EMAILS_ENABLED===undefined && NODE_ENV==='production')});
