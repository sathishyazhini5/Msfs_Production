import express from 'express';
import { createProvince,getProvincesdetails, getProvinces, deleteProvince, updateProvince ,getConfrereDetails,
     getAcademicYearByProvinceCode , getProvinceByLogin,  
     getConcretion} from '../../controllers/Matsertables/Province.js'; // Ensure correct path
import { authenticate } from '../../middlewares/authenticate.js';
import {PrismaClient} from '@prisma/client';
import {resolveDataScope,provinceScopeWhere,sendScopeError} from '../../utils/dataScope.js';
const router = express.Router();
const scopeDb=new PrismaClient();
const managementScope=async(req,res,next)=>{try{const scope=await resolveDataScope(req,scopeDb);req.provinceManagementWhere=provinceScopeWhere(scope.provinceCodes);next();}catch(e){sendScopeError(res,e,'Unable to authorize province management.');}};

router.post('/SaveProvince', authenticate, createProvince);

// Route to get all provinces
router.get('/GetProvinces', managementScope,getProvinces);

router.get('/getConcretion/:concretion_code', managementScope,getConcretion);


router.get('/Getdetailsofprovinces',managementScope,getProvincesdetails)

// Route to delete a province
router.delete('/DeleteProvince/:province_code', deleteProvince);

router.get('/getConfrereDetails/:province_code', getConfrereDetails)

router.put('/updateProvince/:province_code', authenticate, updateProvince);

router.get('/getacademicyearbyProvince/:province_code', getAcademicYearByProvinceCode);

router.get('/getprovincebylogin',getProvinceByLogin)

export const provinceRouter = router; // Ensure the export name is correct
