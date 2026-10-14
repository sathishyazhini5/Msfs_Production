import express from 'express';
import { createConcretion , deleteConcretion, getConcretions,updateConcretion } from '../../controllers/Admin/concrertion.js';
import { authenticate } from '../../middlewares/authenticate.js';
import {requireSuperAdmin} from '../../utils/tenantHierarchy.js';
const router = express.Router();

// Route to create a new concretion and map it to a province
router.post('/createConcretion', authenticate,requireSuperAdmin,createConcretion);
router.get('/getConcretions',getConcretions)
router.put('/updateConcretion/:concretion_code',requireSuperAdmin,updateConcretion)
router.delete('/concretion/:concretion_code', requireSuperAdmin,deleteConcretion);

export const concertionRouter = router;
