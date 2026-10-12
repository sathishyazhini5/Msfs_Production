import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import {CircularQueue} from '../services/circularQueue.js';
import {createCircularWorkerRuntime} from './circularWorkerRuntime.js';
import {sendCircularEmail,circularMailConfigured} from '../middlewares/emailService.js';
import {downloadCircularBlob} from '../middlewares/azureBlob.js';
const db=new PrismaClient();
const worker=createCircularWorkerRuntime({db,queue:new CircularQueue({db,send:sendCircularEmail,download:downloadCircularBlob,concurrency:process.env.CIRCULAR_WORKER_CONCURRENCY}),enabled:()=>process.env.CIRCULAR_WORKER_ENABLED==='true',mailReady:circularMailConfigured});
let shutdown;
const stop=()=>shutdown ||= worker.stop().catch(error=>{console.error('Circular worker shutdown error:',error.code || error.name);process.exitCode=1;});
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {if(!await worker.start()) {console.log('Circular worker is disabled or mail configuration is incomplete.');await stop();}}
catch(error){console.error('Circular worker initialization failed:',error.code || error.name);process.exitCode=1;await stop();}
