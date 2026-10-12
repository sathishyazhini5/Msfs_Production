import express from 'express';
import { reports } from '../controllers/reports.js';
export const reportsRouter = express.Router();
reportsRouter.get('/reports/metadata', reports);
reportsRouter.post('/reports/preview', reports);
