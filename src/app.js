import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOG_FORMAT, NODE_ENV, PORT } from './config/index.js';
import { logger, stream } from './utils/logger.js';
import { indexRouter } from './routes/index.js';
import {anniversaryJob} from './middlewares/anniversaryJob.js'

import {PrismaClient} from '@prisma/client';
import {CircularQueue} from './services/circularQueue.js';
import {createCircularWorkerRuntime} from './workers/circularWorkerRuntime.js';
import {sendCircularEmail,circularMailConfigured} from './middlewares/emailService.js';
import {downloadCircularBlob} from './middlewares/azureBlob.js';

const circularDb=new PrismaClient();
const circularWorker=createCircularWorkerRuntime({
  db:circularDb,
  queue:new CircularQueue({db:circularDb,send:sendCircularEmail,download:downloadCircularBlob,concurrency:process.env.CIRCULAR_WORKER_CONCURRENCY}),
  enabled:()=>process.env.CIRCULAR_WORKER_ENABLED==='true',mailReady:circularMailConfigured,log:logger,
});
const app = express();

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(__filename);

// ✅ Serve static logo image
app.use('/assets', express.static(path.join(_dirname, 'middlewares/MSFSLOGO')));


// Serve static files from the "uploads" directory
app.use('/uploads', express.static('uploads'));

// Middleware setup
app.use(morgan(LOG_FORMAT || 'combined', { stream }));


// Production Nginx adds CORS headers, so Express must not add a second copy.
if (NODE_ENV !== 'production' && process.env.CORS_MANAGED_BY_PROXY !== 'true') {
  app.use(cors({
    origin: ['http://localhost:3000','http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
}

app.use(hpp());
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10mb' })); // Increase the payload limit to 10MB
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Health check route
app.get('/healthcheck', (req, res) => {
  res.status(200).send('Server is online and healthy');
});

// Load routers with token verification middleware
const rootPath = '/api';
app.use(rootPath, indexRouter);

// Swagger setup
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'REST API',
      version: '1.0.0',
      description: 'API Documentation',
    },
    servers: [
      {
        url: `http://localhost:${PORT}/api`, // Adjust based on your environment
      },
    ],
  },
  apis: ['./swagger.yaml'], // Ensure the path is correct for your swagger file
};
const swaggerSpecs = swaggerJSDoc(swaggerOptions);

// Uncomment this if you wish to expose Swagger documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

// 404 Error handling for undefined routes
app.use((req, res, next) => {
  res.status(404).json({ message: 'Resource not found' });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Express Error: ${err.message}`, { stack: err.stack });
  res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});

// Global error handlers for unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason, promise });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { error: err });
});

// Start server
const server=app.listen(PORT, () => {
  circularWorker.start().catch(error=>logger.error(`Circular worker initialization failed: ${error.code || error.name}`));
  logger.info(`🚀 Server is running on http://localhost:${PORT}`);
});

let shutdown;
const stopBackend=()=>{
  if(shutdown)return shutdown;
  logger.info('Stopping API and draining the circular worker...');
  anniversaryJob.stop();
  shutdown=Promise.all([
    new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
    circularWorker.stop(),
  ]).then(()=>process.exit(0)).catch(error=>{
    logger.error(`Backend shutdown failed: ${error.code || error.name}`);process.exit(1);
  });
  return shutdown;
};
process.once('SIGINT',stopBackend);
process.once('SIGTERM',stopBackend);

export default app;
