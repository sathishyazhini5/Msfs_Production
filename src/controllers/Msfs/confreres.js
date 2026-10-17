import {provisionCreatedMember} from '../../services/memberCreationHook.js';
import { recordWhere } from '../../utils/recordAccess.js';
import { estatusRecordWhere } from '../../utils/estatusAccess.js';
import { mapConfrereImportRow, importFingerprint, normalizeConfrerePhones, retryableConfrereRow } from '../../utils/confrereImport.js';
import { PrismaClient } from '@prisma/client';
import xlsx from 'xlsx';
import { readConfrereExcelRows } from '../../utils/confrereExcel.js';
import fs from 'fs';
import path from 'path';
import { uploadBufferToBlob } from '../../middlewares/azureBlob.js';

import { JWT_SECRET } from "../../config/index.js";
const prisma = new PrismaClient();
import jwt from "jsonwebtoken";
import { provinceScopeWhere, resolveDataScope, sendScopeError } from '../../utils/dataScope.js';
import {
  ConfrereCreationError,
  createConfrereWithGeneratedCode,
  resolveAuthorizedProvince,
} from '../../services/confrereCreationService.js';

const maxLength = (str, len) => (str && str.length > len ? str.substring(0, len) : str);

const CONFRERE_IMPORT_JOBS = new Map();

const ensureImportErrorDir = () => {
  const errorDir = path.resolve(process.cwd(), 'uploads', 'import-errors');
  fs.mkdirSync(errorDir, { recursive: true });
  return errorDir;
};

const createConfrereImportErrorFile = (failedRecords, jobId) => {
  const errorRows = failedRecords.map((record) => ({
    ...retryableConfrereRow(record.details || record.row || {}),
    'Source Row': record.rowNumber,
    Error: record.error || 'Unknown upload error',
  }));

  const worksheet = xlsx.utils.json_to_sheet(errorRows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Failed Records');

  const fileName = `ConfreresUploadErrors_${jobId}.xlsx`;
  const errorDir = ensureImportErrorDir();
  const filePath = path.join(errorDir, fileName);
  xlsx.writeFile(workbook, filePath);

  return {
    fileName,
    filePath,
    fileUrl: `/uploads/import-errors/${fileName}`,
  };
};

const processConfrereExcelJob = async (jobId) => {
  const job = CONFRERE_IMPORT_JOBS.get(jobId);
  if (!job) return;

  job.status = 'processing';
  job.startedAt = new Date();
  job.progress = 0;

  try {
    const { buffer, originalname, mimetype } = job.file;
    const { decoded } = job;
    const createdBy = decoded.role_name || decoded.username || 'Unknown';

    const rows = readConfrereExcelRows(buffer);
    const blobUrl = await uploadBufferToBlob(buffer, originalname, mimetype);
    job.azureBlobUrl = blobUrl;

    job.totalRows = rows.length;
    const successRecords = [];
    const failedRecords = [];

    const safeLookup = async (value, type) => {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      try {
        return await fetchCodeByNameOrCode(value, type);
      } catch (error) {
        throw new Error(`${type}: ${error.message}`);
      }
    };

    for (const [index, row] of rows.entries()) {
      try {
        const province = await resolveAuthorizedProvince({
          prisma,
          user: decoded,
          requestedProvince: row['Province'] || job.file.requestedProvince || job.file.province_code || job.file.province,
        });
        const member_type_code = await safeLookup(row['Member Type'], 'memberType');
        const blood_group_code = await safeLookup(row['Blood Group'], 'bloodGroup');
        const nationality_code = await safeLookup(row['Nationality'], 'nationality');

        const data = mapConfrereImportRow(row, { member_type_code, blood_group_code, nationality_code }, job.userId || createdBy);
        const ordinationDate = data.ordination_date;
        data.import_key = importFingerprint(province.province_code, data);
        data.created_date = new Date();
        const imported = await prisma.confreres_dtl.findUnique({ where: { import_key: data.import_key } });
        if (imported) { const member_access=await provisionCreatedMember(prisma,'Confrere',imported,decoded.user_id || 'import');successRecords.push({ ...row, confrer_code: imported.confrer_code, skipped: true, member_access }); continue; }
        if (data.personal_mailid1) {
          const existing = await prisma.confreres_dtl.findFirst({ where: { personal_mailid1: { equals: data.personal_mailid1, mode: 'insensitive' } } });
          if (existing) throw new Error('personal_mailid1: this email already belongs to an existing Confrere. Review that record instead of importing a duplicate.');
        }

        const created = await createConfrereWithGeneratedCode({
          prisma,
          province,
          ordinationDate,
          data,
          role: decoded.role_name,
          source: 'EXCEL',
        });

        const member_access=await provisionCreatedMember(prisma,'Confrere',created,decoded.user_id || 'import');
        successRecords.push({ ...row, confrer_code: created.confrer_code, member_access });
      } catch (error) {
        console.error(`Error processing row: ${error.message}`, row);
        failedRecords.push({ row, rowNumber: (row.__rowNum__ ?? index + 1) + 1, error: error.message });
      } finally {
        job.processedRows = index + 1;
        job.progress = Math.round(((index + 1) / rows.length) * 100);
      }
    }

    job.savedCount = successRecords.length;
    job.failedCount = failedRecords.length;
    job.processedRows = rows.length;
    job.progress = 100;

    if (failedRecords.length > 0) {
      try {
        const errorFile = createConfrereImportErrorFile(failedRecords, jobId);
        job.errorFileUrl = errorFile.fileUrl;
        job.errorFileName = errorFile.fileName;
      } catch (error) {
        console.error('Unable to write import error file:', error.message);
      }
    }

    if (successRecords.length > 0 && failedRecords.length === 0) {
      job.status = 'completed';
      job.result = {
        message: 'All confreres uploaded successfully.',
        savedRecords: successRecords,
      };
    } else if (successRecords.length > 0 && failedRecords.length > 0) {
      job.status = 'completed_with_errors';
      job.result = {
        message: 'Some confreres uploaded successfully. Some failed.',
        savedRecords: successRecords,
        failedRecords: failedRecords.map(record => ({ details: retryableConfrereRow(record.row), rowNumber: record.rowNumber, error: record.error })),
      };
    } else {
      job.status = 'failed';
      job.result = {
        message: 'All confreres failed to upload.',
        failedRecords: failedRecords.map(record => ({ details: retryableConfrereRow(record.row), rowNumber: record.rowNumber, error: record.error })),
      };
    }

    job.finishedAt = new Date();
    return job;
  } catch (error) {
    console.error(`Confrere import job ${jobId} failed: ${error.message}`);
    job.status = 'failed';
    job.finishedAt = new Date();
    job.errorMessage = error.message;
    job.result = { message: error.message || 'An error occurred while processing the file.' };
    return job;
  }
};

export const getConfrereExcelJobStatus = async (req, res) => {
  const { jobId } = req.params;
  const job = CONFRERE_IMPORT_JOBS.get(jobId);

  if (!job) {
    return res.status(404).json({ message: 'Import job not found.' });
  }

  return res.status(200).json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress || 0,
    totalRows: job.totalRows || 0,
    processedRows: job.processedRows || 0,
    savedCount: job.savedCount || 0,
    failedCount: job.failedCount || 0,
    message: job.result?.message || job.message || 'Import is in progress.',
    errorFileUrl: job.errorFileUrl || null,
    errorFileName: job.errorFileName || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    result: job.result || null,
  });
};

export const saveConfrereByExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access token is missing or invalid' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token has expired' });
      }
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
      }
      return res.status(500).json({ error: 'Failed to verify token' });
    }

    try {
      readConfrereExcelRows(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const jobId = `confrere-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      status: 'queued',
      progress: 0,
      totalRows: 0,
      processedRows: 0,
      savedCount: 0,
      failedCount: 0,
      startedAt: null,
      finishedAt: null,
      result: null,
      userId: decoded.user_id || decoded.username || decoded.role_name || 'Unknown',
      message: 'Import queued for processing.',
      file: {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        requestedProvince: req.body.province_code || req.body.province || req.body.provinceName,
      },
      decoded,
    };

    CONFRERE_IMPORT_JOBS.set(jobId, job);

    setImmediate(async () => {
      try {
        await processConfrereExcelJob(jobId);
      } catch (error) {
        const activeJob = CONFRERE_IMPORT_JOBS.get(jobId);
        if (activeJob) {
          activeJob.status = 'failed';
          activeJob.finishedAt = new Date();
          activeJob.result = { message: error.message || 'Background import failed.' };
        }
      }
    });

    return res.status(202).json({
      message: 'Confrere upload accepted and is running in the background.',
      jobId,
      status: 'queued',
    });
  } catch (error) {
    console.error('Error queueing confreres upload:', error.message);
    res.status(500).json({ error: 'An error occurred while scheduling the file upload.' });
  }
};

async function fetchCodeByNameOrCode(nameOrCode, type) {
  const normalizedNameOrCode = String(nameOrCode || '').trim();
  let whereCondition = {};

  switch (type) {
    case 'province':
      whereCondition = {
        OR: [
          { province_name: { equals: normalizedNameOrCode, mode: 'insensitive' } },
          { province_code: normalizedNameOrCode }
        ],
      };
      break;
    case 'memberType':
      whereCondition = {
        OR: [
          { quickcode_name: { equals: normalizedNameOrCode, mode: 'insensitive' }, quick_code_type: 'memtyp' },
          { quick_code: { equals: normalizedNameOrCode, mode: 'insensitive' } }
        ],
      };
      break;
    case 'bloodGroup':
      whereCondition = {
        bloodgroup: { equals: normalizedNameOrCode, mode: 'insensitive' }
      };
      break;

    case 'nationality':
      whereCondition = {
        OR: [
          { quickcode_name: { equals: normalizedNameOrCode, mode: 'insensitive' }, quick_code_type: 'natlty' },
          { quick_code: { equals: normalizedNameOrCode, mode: 'insensitive' } }
        ],
      };
      break;
    default:
      throw new Error(`Unknown type: ${type}`);
  }

  const result = await prisma[type === 'province' ? 'province_mst' : (type === 'bloodGroup' ? 'bloodgroup_metadata' : 'quickcode_mst')].findFirst({
    where: whereCondition,
  });

  if (!result) {
    throw new Error(`${type} name or code ${normalizedNameOrCode} not found`);
  }

  return type === 'province' ? { province_code: result.province_code, country_code: result.country_code, short_name: result.short_name } : (type === 'bloodGroup' ? result.code : result.quick_code);
}


// const fetchLanguageCode = async () => {
//   const language = await prisma.languagemetadata.findFirst();

//   if (!language) {
//     throw new Error('No language code found in languagemetadata');
//   }

//   return language.language_code;
// };

// export const saveConfrere = async (req, res) => {
//   try {
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith("Bearer ")) {
//       return res.status(401).json({ error: "Access token is missing or invalid" });
//     }

//     const token = authHeader.split(" ")[1];
//     let decoded;
//     try {
//       decoded = jwt.verify(token, process.env.JWT_SECRET);
//     } catch (error) {
//       if (error.name === "TokenExpiredError") {
//         return res.status(401).json({ error: "Token has expired" });
//       }
//       if (error.name === "JsonWebTokenError") {
//         return res.status(401).json({ error: "Invalid token" });
//       }
//       return res.status(500).json({ error: "Failed to verify token" });
//     }

//     const provinceNameFromToken = decoded.province_name;
//     const createdBy = decoded.role_name || decoded.username || 'Unknown';
//     if (!provinceNameFromToken) {
//       return res.status(400).json({ error: "Province information is missing in token" });
//     }
//     const {

//       memberType,
//       bloodGroup,
//       nationality,
//       firstName,
//       middleName,
//       lastName,
//       dob,
//       baptismDate,
//       confirmationDate,
//       firstProfessionDate,
//       finalProfessionDate,
//       ordinationDate,
//       personal1Isd,
//       personal1,
//       personal2Isd,
//       personal2,
//       personal3Isd,
//       personal3,
//       whatsapp1Isd,
//       whatsapp1,
//       whatsapp2Isd,
//       whatsapp2,
//       whatsapp3Isd,
//       whatsapp3,
//       emergencyIsd,
//       emergencyContact,
//       email,
//     } = req.body;

//     console.log('Received data:', req.body);

//     // Validate required fields


//     const requiredFields = [
//       { field: "memberType", message: "Member type is required" },
//       { field: "firstName", message: "First Name is required" },
//       { field: "lastName", message: "Last Name is required" },
//       { field: "dob", message: "Birth date is required" },
//       { field: "firstProfessionDate", message: "First Profession date is required" },
//       { field: "finalProfessionDate", message: "Final Profession date is required" },
//       { field: "ordinationDate", message: "Ordination date is required" },
//       { field: "personal1", message: "Personal Contact1 is required" },
//       { field: "personal1Isd", message: "Personal isd 1 is required" },
//       { field: "email", message: "Email is required" },
//       { field: "nationality", message: "Nationality is required" },
//     ];

//     const missingFields = requiredFields
//       .filter(({ field }) => !req.body[field] || req.body[field].trim() === "")
//       .map(({ message }) => message);

//     if (missingFields.length > 0) {
//       return res.status(400).json({ error: `Missing fields: ${missingFields.join(", ")}` });
//     }

//     const lowercaseEmail = email.trim().toLowerCase();

//     const { province_code } = await fetchCodeByNameOrCode(provinceNameFromToken, 'province');
//     if (!province_code) {
//       return res.status(400).json({ error: "Invalid province in token" });
//     }


//     const confrer_code = await generateConfrerCode(province_code, ordinationDate);
//     const member_type_code = await fetchCodeByNameOrCode(memberType, 'memberType');
//     const blood_group_code = bloodGroup
//       ? await fetchCodeByNameOrCode(bloodGroup, "bloodGroup")
//       : null;
//     console.log("Blood Group Code:", blood_group_code);
//     const nationality_code = await fetchCodeByNameOrCode(nationality, 'nationality');
//     // const language_code = await fetchLanguageCode();

//     // Check if confrere with the same email already exists
//     const existingConfrere = await prisma.confreres_dtl.findFirst({
//       where: {
//         personal_mailid1: lowercaseEmail,
//       },
//     });

//     if (existingConfrere) {
//       return res.status(400).json({ error: 'Email ID already exists' });
//     }

//     const image_file_name = req.file ? maxLength(req.file.filename, 100) : null;
//     const image_file_path = req.file ? req.file.path : null;

//     const data = {
//       confrer_code: maxLength(confrer_code, 10),
//       province_code: maxLength(province_code, 10),
//       member_type_code: maxLength(member_type_code, 10),
//       first_name: maxLength(firstName, 50),
//       middle_name: maxLength(middleName, 50),
//       last_name: maxLength(lastName, 50),
//       image_file_name,
//       image_file_path,
//       birth_date: dob ? new Date(dob) : null,
//       baptism_date: baptismDate ? new Date(baptismDate) : null,
//       confirmation_date: confirmationDate ? new Date(confirmationDate) : null,
//       first_profession_date: firstProfessionDate ? new Date(firstProfessionDate) : null,
//       final_profession_date: finalProfessionDate ? new Date(finalProfessionDate) : null,
//       ordination_date: ordinationDate ? new Date(ordinationDate) : null,
//       personal1_isd: personal1Isd,
//       personal1_contact_no: personal1 ? String(personal1) : null,
//       personal2_isd: personal2Isd,
//       personal2_contact_no: personal2 ? String(personal2) : null,
//       personal3_isd: personal3Isd,
//       personal3_contact_no: personal3 ? String(personal3) : null,
//       watsup1_isd: whatsapp1Isd,
//       watsup1_no: whatsapp1 ? String(whatsapp1) : null,
//       watsup2_isd: whatsapp2Isd,
//       watsup2_no: whatsapp2 ? String(whatsapp2) : null,
//       watsup3_isd: whatsapp3Isd,
//       watsup3_no: whatsapp3 ? String(whatsapp3) : null,
//       emergency_isd: emergencyIsd,
//       emergency_contact_no: emergencyContact ? String(emergencyContact) : null,
//       personal_mailid1: maxLength(email, 255),
//       blood_group_code: bloodGroup,
//       nationality_code: maxLength(nationality_code, 10),
//       language_code: maxLength('en', 2),
//       concurrency_val: 1,
//       created_by: createdBy,
//       created_date: new Date(),
//     };

//     // Save confrere data to the database
//     const result = await prisma.confreres_dtl.create({ data });

//     const responseResult = {
//       ...result,
//       personal1_contact_no: result.personal1_contact_no ? result.personal1_contact_no.toString() : null,
//       personal2_contact_no: result.personal2_contact_no ? result.personal2_contact_no.toString() : null,
//       personal3_contact_no: result.personal3_contact_no ? result.personal3_contact_no.toString() : null,
//       watsup1_no: result.watsup1_no ? result.watsup1_no.toString() : null,
//       watsup2_no: result.watsup2_no ? result.watsup2_no.toString() : null,
//       watsup3_no: result.watsup3_no ? result.watsup3_no.toString() : null,
//       emergency_contact_no: result.emergency_contact_no ? result.emergency_contact_no.toString() : null,
//     };

//     res.status(200).json(responseResult);
//   } catch (error) {
//     console.error('Error saving confrere:', error.message);
//     res.status(500).json({ error: error.message || 'An error occurred while saving the confrere' });
//   }
// };

export const saveConfrere = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === "TokenExpiredError") return res.status(401).json({ error: "Token has expired" });
      if (error.name === "JsonWebTokenError") return res.status(401).json({ error: "Invalid token" });
      return res.status(500).json({ error: "Failed to verify token" });
    }

    const createdBy = decoded.role_name || decoded.username || 'Unknown';

    const {
      memberType, bloodGroup, nationality,
      firstName, middleName, lastName,
      dob, baptismDate, confirmationDate,
      firstProfessionDate, finalProfessionDate, ordinationDate,
      personal1Isd, personal1, personal2Isd, personal2, personal3Isd, personal3,
      whatsapp1Isd, whatsapp1, whatsapp2Isd, whatsapp2, whatsapp3Isd, whatsapp3,
      emergencyIsd, emergencyContact, email
    } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase() || null;

    const province = await resolveAuthorizedProvince({
      prisma,
      user: decoded,
      requestedProvince: req.body.province_code || req.body.province || req.body.provinceName,
    });
    const member_type_code = memberType ? await fetchCodeByNameOrCode(memberType, 'memberType') : null;
    const blood_group_code = bloodGroup ? await fetchCodeByNameOrCode(bloodGroup, "bloodGroup") : null;
    const nationality_code = nationality ? await fetchCodeByNameOrCode(nationality, 'nationality') : null;

    if (normalizedEmail) {
      const existingConfrere = await prisma.confreres_dtl.findFirst({
        where: { personal_mailid1: { equals: normalizedEmail, mode: 'insensitive' } },
      });
      if (existingConfrere) {
        return res.status(400).json({ error: 'Email ID already exists' });
      }
    }

    // ✅ Azure Blob Upload for Image
    let image_file_name = null;
    let image_file_url = null;

    if (req.file) {
      image_file_name = maxLength(req.file.originalname, 100);
      image_file_url = await uploadBufferToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    const data = {
      member_type_code: maxLength(member_type_code, 10),
      first_name: maxLength(firstName, 50),
      middle_name: maxLength(middleName, 50),
      last_name: maxLength(lastName, 50),
      image_file_name,
      image_file_path: image_file_url, // store the URL from Azure
      birth_date: dob ? new Date(dob) : null,
      baptism_date: baptismDate ? new Date(baptismDate) : null,
      confirmation_date: confirmationDate ? new Date(confirmationDate) : null,
      first_profession_date: firstProfessionDate ? new Date(firstProfessionDate) : null,
      final_profession_date: finalProfessionDate ? new Date(finalProfessionDate) : null,
      ordination_date: ordinationDate ? new Date(ordinationDate) : null,
      personal1_isd: personal1Isd,
      personal1_contact_no: personal1 ? String(personal1) : null,
      personal2_isd: personal2Isd,
      personal2_contact_no: personal2 ? String(personal2) : null,
      personal3_isd: personal3Isd,
      personal3_contact_no: personal3 ? String(personal3) : null,
      watsup1_isd: whatsapp1Isd,
      watsup1_no: whatsapp1 ? String(whatsapp1) : null,
      watsup2_isd: whatsapp2Isd,
      watsup2_no: whatsapp2 ? String(whatsapp2) : null,
      watsup3_isd: whatsapp3Isd,
      watsup3_no: whatsapp3 ? String(whatsapp3) : null,
      emergency_isd: emergencyIsd,
      emergency_contact_no: emergencyContact ? String(emergencyContact) : null,
      personal_mailid1: maxLength(normalizedEmail, 255),
      blood_group_code: bloodGroup,
      nationality_code: maxLength(nationality_code, 10),
      language_code: maxLength('en', 2),
      concurrency_val: 1,
      created_by: res.locals.user?.user_id || createdBy,
      created_date: new Date(),
    };

    const result = await createConfrereWithGeneratedCode({
      prisma,
      province,
      ordinationDate,
      data,
      role: decoded.role_name,
      source: 'MANUAL',
    });

    const member_access=await provisionCreatedMember(prisma,'Confrere',result,res.locals.user?.user_id || 'administrator');
    const responseResult = {
      ...result, member_access,
      personal1_contact_no: result.personal1_contact_no?.toString() || null,
      personal2_contact_no: result.personal2_contact_no?.toString() || null,
      personal3_contact_no: result.personal3_contact_no?.toString() || null,
      watsup1_no: result.watsup1_no?.toString() || null,
      watsup2_no: result.watsup2_no?.toString() || null,
      watsup3_no: result.watsup3_no?.toString() || null,
      emergency_contact_no: result.emergency_contact_no?.toString() || null,
    };

    res.status(200).json({ success: true, confrerCode: result.confrer_code, ...responseResult });
  } catch (error) {
    console.error('Error saving confrere:', error.message);
    const status = error instanceof ConfrereCreationError ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'An error occurred while saving the Confrere.' : error.message });
  }
};

export const getConfreres = async (req, res) => {
  try {
    const requestedProvince = req.query.province_code || null;
    const { provinceCodes } = await resolveDataScope(req, prisma, requestedProvince);

    const { confrer_code } = req.query;

    // Fetch supporting data
    const [memberTypes, provinces, nationalities] = await Promise.all([
      prisma.quickcode_mst.findMany({
        where: { quick_code_type: "memtyp" },
        select: { quick_code: true, quickcode_name: true },
      }),
      prisma.province_mst.findMany({
        select: { province_code: true, province_name: true },
      }),
      prisma.quickcode_mst.findMany({
        where: { quick_code_type: "natlty" }, // Adjusted to match the correct type for nationalities
        select: { quick_code: true, quickcode_name: true },
      }),
    ]);

    const provincesMap = new Map(provinces.map((p) => [p.province_code, p.province_name]));
    const memberTypesMap = new Map(memberTypes.map((m) => [m.quick_code, m.quickcode_name]));
    const nationalitiesMap = new Map(nationalities.map((n) => [n.quick_code, n.quickcode_name]));

    let confreres;

    const formatDate = (date) => (date ? new Date(date).toISOString().split("T")[0] : null);

    if (confrer_code) {
      // Fetch single confrere by confrer_code
      confreres = await prisma.confreres_dtl.findUnique({ where: { confrer_code } });

      if (!confreres) {
        return res.status(404).json({ error: "Confrere not found" });
      }

      if (provinceCodes !== null && !provinceCodes.includes(confreres.province_code)) {
        return res.status(403).json({ error: "You are not authorized to access this confrere's details" });
      }

      confreres = {
        ...confreres,
        province_name: provincesMap.get(confreres.province_code) || null,
        member_type_name: memberTypesMap.get(confreres.member_type_code) || null,
        nationality_name: nationalitiesMap.get(confreres.nationality_code) || null, // Corrected mapping
        birth_date: formatDate(confreres.birth_date),
        baptism_date: formatDate(confreres.baptism_date),
        confirmation_date: formatDate(confreres.confirmation_date),
        first_profession_date: formatDate(confreres.first_profession_date),
        final_profession_date: formatDate(confreres.final_profession_date),
        ordination_date: formatDate(confreres.ordination_date),
        created_date: formatDate(confreres.created_date),
        updated_date: formatDate(confreres.updated_date),
      };
    } else {
      // Fetch all confreres
      confreres = await prisma.confreres_dtl.findMany({
        where: { is_active: true, ...provinceScopeWhere(provinceCodes) },
        orderBy: [
       
          { first_name: 'asc' },
          { middle_name: 'asc' },
          { last_name: 'asc' },
        ],
      });
      confreres = confreres.map((confrere) => ({
          ...confrere,
          province_name: provincesMap.get(confrere.province_code) || null,
          member_type_name: memberTypesMap.get(confrere.member_type_code) || null,
          nationality_name: nationalitiesMap.get(confrere.nationality_code) || null, // Corrected mapping
          birth_date: formatDate(confrere.birth_date),
          baptism_date: formatDate(confrere.baptism_date),
          confirmation_date: formatDate(confrere.confirmation_date),
          first_profession_date: formatDate(confrere.first_profession_date),
          final_profession_date: formatDate(confrere.final_profession_date),
          ordination_date: formatDate(confrere.ordination_date),
          created_date: formatDate(confrere.created_date),
          updated_date: formatDate(confrere.updated_date),
          personal1_contact_no: confrere.personal1_contact_no?.toString() || null,
          personal2_contact_no: confrere.personal2_contact_no?.toString() || null,
          personal3_contact_no: confrere.personal3_contact_no?.toString() || null,
          watsup1_no: confrere.watsup1_no?.toString() || null,
          watsup2_no: confrere.watsup2_no?.toString() || null,
          watsup3_no: confrere.watsup3_no?.toString() || null,
          emergency_contact_no: confrere.emergency_contact_no?.toString() || null,
        }));
    }

    res.status(200).json(confreres);
  } catch (error) {
    console.error("Error fetching confreres:", error.message);
    sendScopeError(res, error, "An error occurred while fetching confreres");
  }
};







export const getNationalities = async (req, res) => {
  try {
    const nationalities = await prisma.quickcode_mst.findMany({
      where: {
        quick_code_type: 'natlty',
      },
      select: {
        quickcode_name: true,
        quick_code: true,
      },
    });

    res.status(200).json(nationalities);
  } catch (error) {
    console.error('Error fetching nationalities:', error);
    res.status(500).json({ error: 'An error occurred while fetching nationalities' });
  }
};

export const getAllConfreres = async (req, res) => {
  try {
    // Fetch all confreres from confreres_dtl table
    const confreres = await prisma.confreres_dtl.findMany(); // No include since there are no direct relations

    // Fetch member type names from quickcode_mst where quick_code_type is 'memtyp'
    const memberTypes = await prisma.quickcode_mst.findMany({
      where: {
        quick_code_type: 'memtyp',
      },
      select: {
        quick_code: true,
        quickcode_name: true,
      },
    });

    // Fetch province names from province_mst
    const provinces = await prisma.province_mst.findMany({
      select: {
        province_code: true,
        province_name: true,
      },
    });

    // Helper function to format date to 'yyyy-MM-dd'
    const formatDate = (date) => {
      return date ? new Date(date).toISOString().split('T')[0] : null;
    };

    // Function to get base64 encoded image
    const getImageAsBase64 = (filePath) => {
      try {
        const fullPath = path.join(__dirname, filePath);
        const imageData = fs.readFileSync(fullPath);
        return `data:image/png;base64,${imageData.toString('base64')}`;
      } catch (error) {
        console.error('Error reading image:', error);
        return null; // Return null if image is not found
      }
    };

    // Map the confreres data and merge with member type name, province name, and image file
    const responseResult = confreres.map((confrere) => {
      // Find the member type name based on the confrere's member_type_code
      const memberType = memberTypes.find((mt) => mt.quick_code === confrere.member_type_code);
      const memberTypeName = memberType ? memberType.quickcode_name : 'N/A';

      // Find the province name based on the confrere's province_code
      const province = provinces.find((p) => p.province_code === confrere.province_code);
      const provinceName = province ? province.province_name : 'N/A';

      // Get image data as base64 if available
      const imageFileBase64 = confrere.image_file_path ? getImageAsBase64(confrere.image_file_path) : null;

      return {
        confrer_code: confrere.confrer_code,
        member_type_name: memberTypeName, // Member type name from quickcode_mst
        province_name: provinceName, // Province name from province_mst
        first_name: confrere.first_name,
        middle_name: confrere.middle_name || '',
        last_name: confrere.last_name,
        birth_date: formatDate(confrere.birth_date),
        baptism_date: formatDate(confrere.baptism_date),
        confirmation_date: formatDate(confrere.confirmation_date),
        first_profession_date: formatDate(confrere.first_profession_date),
        final_profession_date: formatDate(confrere.final_profession_date),
        ordination_date: formatDate(confrere.ordination_date),
        personal1_contact_no: confrere.personal1_contact_no ? confrere.personal1_contact_no.toString() : null,
        personal2_contact_no: confrere.personal2_contact_no ? confrere.personal2_contact_no.toString() : null,
        personal3_contact_no: confrere.personal3_contact_no ? confrere.personal3_contact_no.toString() : null,
        watsup1_no: confrere.watsup1_no ? confrere.watsup1_no.toString() : null,
        watsup2_no: confrere.watsup2_no ? confrere.watsup2_no.toString() : null,
        watsup3_no: confrere.watsup3_no ? confrere.watsup3_no.toString() : null,
        emergency_contact_no: confrere.emergency_contact_no ? confrere.emergency_contact_no.toString() : null,
        personal_mailid1: confrere.personal_mailid1,
        blood_group_code: confrere.blood_group_code,
        nationality_code: confrere.nationality_code,
        concurrency_val: confrere.concurrency_val,
        created_by: confrere.created_by,
        created_date: formatDate(confrere.created_date),
        updated_by: confrere.updated_by,
        updated_date: formatDate(confrere.updated_date),
        image: imageFileBase64, // Add the image as base64 data
      };
    });

    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confreres:', error);
    res.status(500).json({ error: 'An error occurred while fetching confreres' });
  }
};

export const getConfrereDetails = async (req, res) => {
  try {
    const confreres = await prisma.confreres_dtl.findMany();

    const responseResult = await Promise.all(
      confreres.map(async (confrere) => {
        const memberType = await prisma.quickcode_mst.findFirst({
          where: {
            quick_code: confrere.member_type_code,
            quick_code_type: 'memtyp', // Ensure that you're fetching the correct member type
          },
          select: {
            quickcode_name: true,
          },
        });

        return {
          confrer_code: confrere.confrer_code,
          province_code: confrere.province_code,
          member_type_name: memberType ? memberType.quickcode_name : 'N/A', // Fetch the member type name
          full_name: `${confrere.first_name} ${confrere.middle_name || ''} ${confrere.last_name}`.trim(), // Concatenate the full name
          date_of_birth: confrere.birth_date ? confrere.birth_date.toISOString().split('T')[0] : null, // Format the date of birth
          ordination_date: confrere.ordination_date ? confrere.ordination_date.toISOString().split('T')[0] : null, // Format the ordination date
          // Add other fields as needed
        };
      })
    );

    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confrere details:', error);
    res.status(500).json({ error: 'An error occurred while fetching confrere details' });
  }
};

function jsonifyBigInt(obj) {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

export const updateConfrere = async (req, res) => {
  try {

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Token has expired" });
      }
      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({ error: "Invalid token" });
      }
      return res.status(500).json({ error: "Failed to verify token" });
    }

    const provinceNameFromToken = decoded.province_name;
    const updateBy = decoded.role_name || decoded.username || 'Unknown';

    if (!provinceNameFromToken) {
      return res.status(400).json({ error: "Province information is missing in token" });
    }
    const { confrer_code } = req.params;
    if (!confrer_code) {
      return res.status(400).json({ error: "Confrere code is required" });
    }

    const province = await prisma.province_mst.findFirst({
      where: { province_name: provinceNameFromToken },
      select: { province_code: true },
    });

    if (!province) {
      return res.status(404).json({ error: "Province not found for the given name" });
    }

    const province_code = province.province_code;
    const {
      memberType,
      bloodGroup,
      nationality,
      firstName,
      middleName,
      lastName,
      dob,
      baptismDate,
      confirmationDate,
      firstProfessionDate,
      finalProfessionDate,
      ordinationDate,
      personal1Isd,
      personal1,
       personal2Isd,  // ✅ NEW
  personal2,     // ✅ NEW
  personal3Isd,  // ✅ NEW
  personal3,     // ✅ NEW
      watsup1Isd,
      watsup1_no,
      email,
      language_code,
      updated_by,
      updated_date,
      emergencyIsd,
      emergencyContact
    } = req.body;


    const optionalDate = (value) => {
      if (value === undefined) return undefined;
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw Object.assign(new Error('Invalid date value'), { status: 400 });
      return date;
    };

    const existingEmail = email ? await prisma.confreres_dtl.findFirst({
      where: {
        personal_mailid1: {
          equals: email,
          mode: 'insensitive', // Case-insensitive comparison
        },
        confrer_code: { not: confrer_code }, // Exclude the current confrere
      },
    }) : null;

    if (existingEmail) {
      return res.status(400).json({ error: "The email is already in use." });
    }

    const existingConfrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code: confrer_code,
        province_code: province_code,
      },
    });
    
    
    if (!existingConfrere) {
      return res.status(404).json({ error: "Confrere not found" });
    }
    
    let image_file_name = existingConfrere.image_file_name;
    let image_file_url = existingConfrere.image_file_path;
    
    if (req.file) {
      image_file_name = maxLength(req.file.originalname, 100);
      image_file_url = await uploadBufferToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
    }
    


    

    const updatedConfrere = await prisma.confreres_dtl.update({
      where: {
        confrer_code_province_code: {
          confrer_code,
          province_code: province_code,
        },
      },
      data: normalizeConfrerePhones({
        member_type_code: memberType === undefined ? undefined : memberType || null,
        blood_group_code: bloodGroup === undefined ? undefined : bloodGroup || null,
        nationality_code: nationality === undefined ? undefined : nationality || null,
        first_name: firstName,
        middle_name: middleName,
        last_name: lastName,
        birth_date: optionalDate(dob),
        baptism_date: optionalDate(baptismDate),
        confirmation_date: optionalDate(confirmationDate),
        first_profession_date: optionalDate(firstProfessionDate),
        final_profession_date: optionalDate(finalProfessionDate),
        ordination_date: optionalDate(ordinationDate),
        personal1_isd: personal1Isd,
        personal1_contact_no: personal1 === undefined ? undefined : (personal1 ? String(personal1) : null),
          personal2_isd: personal2Isd,                     // ✅ NEW
  personal2_contact_no: personal2 === undefined ? undefined : (personal2 ? String(personal2) : null),
  personal3_isd: personal3Isd,                     // ✅ NEW
  personal3_contact_no: personal3 === undefined ? undefined : (personal3 ? String(personal3) : null),
        watsup1_isd: watsup1Isd,
        watsup1_no: watsup1_no === undefined ? undefined : (watsup1_no ? String(watsup1_no) : null), // Use correct key
        personal_mailid1: email,
        language_code,
        concurrency_val: 1,
        updated_by: res.locals.user?.user_id || updateBy,
        updated_date: updated_date ? new Date(updated_date) : new Date(),
        emergency_isd: emergencyIsd,
        emergency_contact_no: emergencyContact === undefined ? undefined : (emergencyContact ? String(emergencyContact) : null),
        image_file_name,
        image_file_path: image_file_url, // store the URL from Azure
      }, existingConfrere),
    });


    // Fetch all curia records associated with this confrere
    const curiaRecords = await prisma.curia_advisors_dtl.findMany({
      where: {
        confrer_code,
      },
    });

    if (curiaRecords.length > 0) {
      // Update curia_advisors_dtl for all matching records
      await prisma.curia_advisors_dtl.updateMany({
        where: {
          confrer_code,
        },
        data: {
          personal_mailid1: email,
          personal1_contact_no: updatedConfrere.personal1_contact_no ? BigInt(updatedConfrere.personal1_contact_no) : null,
          watsup1_no: updatedConfrere.watsup1_no ? BigInt(updatedConfrere.watsup1_no) : null,
          updated_by: res.locals.user?.user_id || updateBy,
          updated_date: updated_date ? new Date(updated_date) : new Date(),
        },
      });
    }

    // Convert BigInt values to strings before sending response
    const jsonResponse = jsonifyBigInt(updatedConfrere);

    res.status(200).json({
      message: 'Confrere and associated curia records updated successfully.',
      confrere: jsonResponse,
    });
  } catch (error) {
    console.error('Error updating confrere and curia:', error);
    res.status(error.status || 400).json({ error: error.message || 'An error occurred while updating confrere and curia records.' });
  }
};


export const deleteConfrere = async (req, res) => {
  try {

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Token has expired" });
      }
      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({ error: "Invalid token" });
      }
      return res.status(500).json({ error: "Failed to verify token" });
    }

    // Extract province information from the token
    const provinceNameFromToken = decoded.province_name;
    if (!provinceNameFromToken) {
      return res.status(400).json({ error: "Province information is missing in token" });
    }

    const { confrer_code } = req.params;

    // Validate province information
    const province = await prisma.province_mst.findFirst({
      where: { province_name: provinceNameFromToken },
      select: { province_code: true },
    });

    if (!province) {
      return res.status(404).json({ error: `Province not found for the given name: ${provinceNameFromToken}` });
    }

    const province_code = province.province_code;


    // Trim any leading/trailing spaces from the confrer_code
    const trimmedConfrerCode = confrer_code.trim();

    // Check if confrer_code exists in the database
    const existingConfrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code: { equals: trimmedConfrerCode, mode: 'insensitive' }, // Case-insensitive matching
      },
    });

    if (!existingConfrere) {
      return res.status(404).json({ error: `Confrere with code ${trimmedConfrerCode} not found` });
    }

    const tablesToCheck = [
      'confreres_feedback_dtl',
      'curia_advisors_dtl',
      'appoint_transfer_dtl',
    ];

    for (const table of tablesToCheck) {
      const isConfrereInUse = await prisma[table].findFirst({
        where: { confrer_code: trimmedConfrerCode },
      });
      if (isConfrereInUse) {
        return res.status(400).json({
          message: `Confrere cannot be deleted as it is being used in the MSFS Profile table: ${table}.`,
        });
      }
    }

    const tablesToCheckforConfrerScholastic = [
      'departures_dtl',
      'anniversary_notify_dtl',
      'obituary_dtl',
    ];

    for (const table of tablesToCheckforConfrerScholastic) {
      const isCountryscholasticInUse = await prisma[table].findFirst({
        where: { confrer_scholastic_code: trimmedConfrerCode },
      });

      if (isCountryscholasticInUse) {
        return res.status(400).json({
          message: `Confrere cannot be deleted as it is being used in the MSFS Profile table: ${table}.`,
        });
      }
    }

    // Delete the confrere from the confreres_dtl table
    await prisma.confreres_dtl.delete({
      where: {
        confrer_code_province_code: {
          confrer_code: existingConfrere.confrer_code,
          province_code: province_code,
        },
      },
    });

    res.status(200).json({ message: 'Confrere deleted successfully' });
  } catch (error) {
    console.error('Error deleting confrere:', error);
    res.status(500).json({ error: 'An error occurred while deleting the confrere' });
  }
};

export const getConfrereByCode = async (req, res) => {
  try {
    const { confrer_code } = req.params;

    // Find the confrere using confrer_code
    const confrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code,
      },
    });

    if (!confrere) {
      return res.status(404).json({ error: `Confrere with code ${confrer_code} not found` });
    }

    // Fetch related member type, blood group, and nationality names
    const memberType = confrere.member_type_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: confrere.member_type_code,
        quick_code_type: 'memtyp',
      },
      select: {
        quickcode_name: true,
      },
    }) : null;

    const bloodGroup = confrere.blood_group_code ? await prisma.bloodgroup_metadata.findFirst({
      where: {
        bloodgroup: confrere.blood_group_code,
      },
      select: {
        bloodgroup: true,
      },
    }) : null;

    const nationality = confrere.nationality_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: confrere.nationality_code,
        quick_code_type: 'natlty',
      },
      select: {
        quickcode_name: true,
      },
    }) : null;

    // Prepare the response object
    const responseResult = {
      confrer_code: confrere.confrer_code,
      province_code: confrere.province_code,
      member_type_name: memberType ? memberType.quickcode_name : 'N/A',
      blood_group_name: bloodGroup ? bloodGroup.bloodgroup : 'N/A',
      nationality_name: nationality ? nationality.quickcode_name : 'N/A',
      first_name: confrere.first_name,
      middle_name: confrere.middle_name,
      last_name: confrere.last_name,
      birth_date: confrere.birth_date ? confrere.birth_date.toISOString().split('T')[0] : null,
      baptism_date: confrere.baptism_date ? confrere.baptism_date.toISOString().split('T')[0] : null,
      confirmation_date: confrere.confirmation_date ? confrere.confirmation_date.toISOString().split('T')[0] : null,
      first_profession_date: confrere.first_profession_date ? confrere.first_profession_date.toISOString().split('T')[0] : null,
      final_profession_date: confrere.final_profession_date ? confrere.final_profession_date.toISOString().split('T')[0] : null,
      ordination_date: confrere.ordination_date ? confrere.ordination_date.toISOString().split('T')[0] : null,
      personal1_isd: confrere.personal1_isd,
      personal1_contact_no: confrere.personal1_contact_no ? confrere.personal1_contact_no.toString() : null,
      personal2_isd: confrere.personal2_isd,
      personal2_contact_no: confrere.personal2_contact_no ? confrere.personal2_contact_no.toString() : null,
      personal3_isd: confrere.personal3_isd,
      personal3_contact_no: confrere.personal3_contact_no ? confrere.personal3_contact_no.toString() : null,
      watsup1_isd: confrere.watsup1_isd,
      watsup1_no: confrere.watsup1_no ? confrere.watsup1_no.toString() : null,
      watsup2_isd: confrere.watsup2_isd,
      watsup2_no: confrere.watsup2_no ? confrere.watsup2_no.toString() : null,
      watsup3_isd: confrere.watsup3_isd,
      watsup3_no: confrere.watsup3_no ? confrere.watsup3_no.toString() : null,
      emergency_isd: confrere.emergency_isd,
      emergency_contact_no: confrere.emergency_contact_no ? confrere.emergency_contact_no.toString() : null,
      personal_mailid1: confrere.personal_mailid1,
      image_file_name: confrere.image_file_name,
      image_file_path: confrere.image_file_path,
    };

    // Send the response
    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confrere by code:', error);
    res.status(500).json({ error: error.message || 'An error occurred while fetching the confrere' });
  }
};

export const getConfrerebyprovinceandmember = async (req, res) => {
  const { province_code, member_type_code } = req.query;

  if (!province_code || !member_type_code) {
    return res.status(400).json({ error: 'Both province_code and member_type_code are required' });
  }

  try {
    // Step 1: Fetch confrere details from confreres_dtl
    const confrereDetails = await prisma.confreres_dtl.findMany({
      where: {
        province_code: province_code.trim(),
        member_type_code: member_type_code.trim(),
      },
      select: {
        confrer_code: true,
        first_name: true,
        middle_name: true,
        last_name: true,
        province_code: true,  // Fetch the codes to use in separate queries
        member_type_code: true,
      },
    });

    if (!confrereDetails.length) {
      return res.status(404).json({ error: 'No confrere details found for the given codes' });
    }

    // Step 2: Fetch related data (province name and member type name) separately
    const provinceCodes = confrereDetails.map((confrere) => confrere.province_code);
    const memberTypeCodes = confrereDetails.map((confrere) => confrere.member_type_code);

    const provinces = await prisma.province_mst.findMany({
      where: {
        province_code: { in: provinceCodes },
      },
      select: {
        province_code: true,
        province_name: true,
      },
    });

    const memberTypes = await prisma.quickcode_mst.findMany({
      where: {
        quick_code: { in: memberTypeCodes },
        quick_code_type: 'memtyp', // Assuming 'memtyp' is the type for member types
      },
      select: {
        quick_code: true,
        quickcode_name: true,
      },
    });

    // Step 3: Combine the results
    const formattedDetails = confrereDetails.map((confrere) => {
      const province = provinces.find((p) => p.province_code === confrere.province_code);
      const memberType = memberTypes.find((m) => m.quick_code === confrere.member_type_code);

      return {
        confrere_code: confrere.confrer_code,
        confrere_name: `${confrere.first_name} ${confrere.middle_name || ''} ${confrere.last_name}`.trim(),
        province_name: province ? province.province_name : null,
        member_type_name: memberType ? memberType.quickcode_name : null,
      };
    });


    formattedDetails.sort((a, b) => a.confrere_name.localeCompare(b.confrere_name));

    res.status(200).json({ data: formattedDetails });
  } catch (error) {
    console.error('Error fetching confrere details:', error.message);
    res.status(500).json({ error: 'An error occurred while fetching the confrere details' });
  }
};


export const getConfreresView = async (req, res) => {
  try {
    // Fetch data from the confreres_view
    const confreresData = await prisma.$queryRaw`
      SELECT 
        confrer_code, 
        first_name, 
        middle_name, 
        last_name, 
        birth_date, 
        ordination_date, 
        member_type_code, 
        province_code, 
        division_type_code, 
        division_code, 
        centre_code, 
        centre_place_code, 
        apostolate_code, 
        centre_name, 
        centre_place, 
        designation_code, 
        designation_appn_date, 
        designation_taken_date, 
        member_type_name, 
        division_type_name, 
        division_name, 
        province_name, 
        designation_name 
      FROM 
        estatus.confreres_view;
    `;

    // If no data is found
    if (confreresData.length === 0) {
      return res.status(404).json({ message: 'No data found' });
    }

    // Send the fetched data as a response
    res.json(confreresData);
  } catch (error) {
    console.error('Error retrieving confreres data:', error);
    res.status(500).json({ error: 'Failed to retrieve confreres data' });
  }
};

// export const saveConfrereByExcel = async (req, res) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({ error: 'No file uploaded.' });
//     }

//     // Read the file from the file system
//     let workbook;
//     try {
//       const filePath = req.file.path;
//       const fileBuffer = fs.readFileSync(filePath);
//       workbook = xlsx.read(fileBuffer, { type: 'buffer' });
//     } catch (parseError) {
//       console.error('Error parsing Excel file:', parseError);
//       return res.status(400).json({ error: 'Failed to parse Excel file. Please check the file format.' });
//     }

//     if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
//       return res.status(400).json({ error: 'The uploaded Excel file does not contain any sheets.' });
//     }

//     const sheetName = workbook.SheetNames[0];
//     const sheet = workbook.Sheets[sheetName];

//     if (!sheet) {
//       return res.status(400).json({ error: 'The sheet in the Excel file is empty or corrupted.' });
//     }

//     let rows;
//     try {
//       rows = xlsx.utils.sheet_to_json(sheet);
//     } catch (jsonError) {
//       console.error('Error converting sheet to JSON:', jsonError);
//       return res.status(400).json({ error: 'Failed to convert Excel sheet to JSON format.' });
//     }

//     if (!rows || rows.length === 0) {
//       return res.status(400).json({ error: 'No data found in the Excel file.' });
//     }

//     const successRecords = [];
//     const failedRecords = [];

//     // Process each row
//     for (const row of rows) {
//       try {
//         // Extract and convert fields
//         const personal2Isd = row['Personal2 ISD'] ? String(row['Personal2 ISD']) : null;
//         const personal2 = row['Personal2 Contact'] ? BigInt(row['Personal2 Contact']) : null;
//         const personal3Isd = row['Personal3 ISD'] ? String(row['Personal3 ISD']) : null;
//         const personal3 = row['Personal3 Contact'] ? BigInt(row['Personal3 Contact']) : null;
//         const whatsapp2Isd = row['WhatsApp2 ISD'] ? String(row['WhatsApp2 ISD']) : null;
//         const whatsapp2 = row['WhatsApp2'] ? BigInt(row['WhatsApp2']) : null;
//         const whatsapp3Isd = row['WhatsApp3 ISD'] ? String(row['WhatsApp3 ISD']) : null;
//         const whatsapp3 = row['WhatsApp3'] ? BigInt(row['WhatsApp3']) : null;
//         const emergencyIsd = row['Emergency ISD'] ? String(row['Emergency ISD']) : null;
//         const emergencyContact = row['Emergency Contact'] ? BigInt(row['Emergency Contact']) : null;
//         const updated_by = row['Updated By'] ? String(row['Updated By']) : null;
//         const updated_date = row['Updated Date'] ? new Date(row['Updated Date']) : null;

//         // Required fields check
//         if (!row['Province'] || !row['Ordination Date'] || !row['Email']) {
//           console.error('Missing required fields in row:', row);
//           failedRecords.push({ row, error: 'Missing required fields' });
//           continue; // Skip row
//         }

//         const { province_code } = await fetchCodeByNameOrCode(row['Province'], 'province');
//         const confrer_code = await generateConfrerCode(province_code, row['Ordination Date']);
//         const member_type_code = await fetchCodeByNameOrCode(row['Member Type'], 'memberType');
//         const blood_group_code = row['Blood Group'] ? await fetchCodeByNameOrCode(row['Blood Group'], 'bloodGroup') : null;
//         const nationality_code = row['Nationality'] ? await fetchCodeByNameOrCode(row['Nationality'], 'nationality') : null;

//         // Check for existing confrere
//         const existingConfrere = await prisma.confreres_dtl.findFirst({
//           where: { personal_mailid1: row['Email'] },
//         });

//         if (existingConfrere) {
//           console.warn(`Confrere with email ${row['Email']} already exists.`);
//           failedRecords.push({ row, error: 'Confrere with this email already exists' });
//           continue; // Skip row
//         }

//         // Prepare data for Prisma create, ensuring correct data types
//         const data = {
//           confrer_code: maxLength(confrer_code, 10),
//           province_code: maxLength(province_code, 10),
//           member_type_code: maxLength(member_type_code, 10),
//           first_name: maxLength(row['First Name'] || '', 50),
//           middle_name: maxLength(row['Middle Name'] || '', 50) || null,
//           last_name: maxLength(row['Last Name'] || '', 50),
//           birth_date: row['Date of Birth'] ? new Date(row['Date of Birth']) : null,
//           baptism_date: row['Baptism Date'] ? new Date(row['Baptism Date']) : null,
//           confirmation_date: row['Confirmation Date'] ? new Date(row['Confirmation Date']) : null,
//           first_profession_date: row['First Profession Date'] ? new Date(row['First Profession Date']) : null,
//           final_profession_date: row['Final Profession Date'] ? new Date(row['Final Profession Date']) : null,
//           ordination_date: row['Ordination Date'] ? new Date(row['Ordination Date']) : null,
//           personal_mailid1: maxLength(row['Email'], 255),
//           personal1_isd: row['Personal1 ISD'] ? String(row['Personal1 ISD']) : null,
//           personal1_contact_no: row['Personal1 Contact'] ? BigInt(row['Personal1 Contact']) : null,
//           personal2_isd: personal2Isd,
//           personal2_contact_no: personal2,
//           personal3_isd: personal3Isd,
//           personal3_contact_no: personal3,
//           watsup1_isd: row['WhatsApp1 ISD'] ? String(row['WhatsApp1 ISD']) : null,
//           watsup1_no: row['WhatsApp1'] ? BigInt(row['WhatsApp1']) : null,
//           watsup2_isd: whatsapp2Isd,
//           watsup2_no: whatsapp2,
//           watsup3_isd: whatsapp3Isd,
//           watsup3_no: whatsapp3,
//           emergency_isd: emergencyIsd,
//           emergency_contact_no: emergencyContact,
//           blood_group_code: blood_group_code ? maxLength(blood_group_code, 10) : null,
//           nationality_code: nationality_code ? maxLength(nationality_code, 10) : null,
//           language_code: maxLength(row['Language Code'] || '', 2),
//           concurrency_val: 1,
//           created_by: maxLength('admin', 50),
//           created_date: new Date(),
//           updated_by: maxLength(updated_by || '', 50),
//           updated_date: updated_date,
//         };

//         // Save confrere data to the database
//         await prisma.confreres_dtl.create({ data });
//         successRecords.push(row);
//       } catch (err) {
//         console.error(`Error processing row: ${err.message}`, row);
//         failedRecords.push({ row, error: err.message });
//       }
//     }

//     if (successRecords.length > 0 && failedRecords.length === 0) {
//       // All records were saved successfully
//       return res.status(200).json({
//         message: 'All confreres uploaded successfully.',
//         savedRecords: successRecords,
//       });
//     } else if (successRecords.length > 0 && failedRecords.length > 0) {
//       // Some records were saved successfully, some failed
//       return res.status(207).json({
//         message: 'Some confreres uploaded successfully. Some failed.',
//         savedRecords: successRecords,
//         failedRecords: failedRecords.map(record => ({
//           details: record.row,
//           error: record.error,
//         })),
//       });
//     } else {
//       // All records failed
//       return res.status(400).json({
//         message: 'All confreres failed to upload.',
//         failedRecords: failedRecords.map(record => ({
//           details: record.row,
//           error: record.error,
//         })),
//       });
//     }
//   } catch (error) {
//     console.error('Error uploading confreres:', error.message);
//     res.status(500).json({ error: 'An error occurred while processing the file.' });
//   }
// };


export const getConfrereByConfrere_code = async (req, res) => {
  try {
    // Trim any leading or trailing whitespace from confrer_code
    const confrer_code = req.params.confrer_code.trim();

    // Find the confrere using confrer_code
    const confrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code,
      },
    });

    // If confrere does not exist, return a 404 response
    if (!confrere) {
      return res.status(404).json({ error: `Confrere with code ${confrer_code} not found` });
    }

    // Find member type name from quickcode_mst
    const quickcode = confrere.member_type_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code_type: 'memtyp',
        quick_code: confrere.member_type_code,
      },
      select: {
        quickcode_name: true,
      },
    }) : null;

    // Combine the full name with member type name in the required format
    const memberTypeName = quickcode ? quickcode.quickcode_name : '';
    const confrereFullName = `${confrere.first_name} ${confrere.middle_name || ''} ${confrere.last_name}`.trim();
    const confrereNameWithMemberType = `${confrereFullName} [${memberTypeName}]`;

    // Prepare the response object with all the details
    const responseResult = {
      confrer_code: confrere.confrer_code,
      province_code: confrere.province_code,
      member_type_code: confrere.member_type_code,
      member_type_name: memberTypeName, // Add member type name to response
      confrere_name: confrereNameWithMemberType, // Full name with member type
      blood_group_code: confrere.blood_group_code,
      nationality_code: confrere.nationality_code,
      first_name: confrere.first_name, // Include first name
      middle_name: confrere.middle_name, // Include middle name
      last_name: confrere.last_name, // Include last name
      birth_date: confrere.birth_date ? confrere.birth_date.toISOString().split('T')[0] : null,
      baptism_date: confrere.baptism_date ? confrere.baptism_date.toISOString().split('T')[0] : null,
      confirmation_date: confrere.confirmation_date ? confrere.confirmation_date.toISOString().split('T')[0] : null,
      first_profession_date: confrere.first_profession_date ? confrere.first_profession_date.toISOString().split('T')[0] : null,
      final_profession_date: confrere.final_profession_date ? confrere.final_profession_date.toISOString().split('T')[0] : null,
      ordination_date: confrere.ordination_date ? confrere.ordination_date.toISOString().split('T')[0] : null,
      personal1_isd: confrere.personal1_isd,
      personal1_contact_no: confrere.personal1_contact_no ? confrere.personal1_contact_no.toString() : null,
      personal2_isd: confrere.personal2_isd,
      personal2_contact_no: confrere.personal2_contact_no ? confrere.personal2_contact_no.toString() : null,
      personal3_isd: confrere.personal3_isd,
      personal3_contact_no: confrere.personal3_contact_no ? confrere.personal3_contact_no.toString() : null,
      watsup1_isd: confrere.watsup1_isd,
      watsup1_no: confrere.watsup1_no ? confrere.watsup1_no.toString() : null,
      watsup2_isd: confrere.watsup2_isd,
      watsup2_no: confrere.watsup2_no ? confrere.watsup2_no.toString() : null,
      watsup3_isd: confrere.watsup3_isd,
      watsup3_no: confrere.watsup3_no ? confrere.watsup3_no.toString() : null,
      emergency_isd: confrere.emergency_isd,
      emergency_contact_no: confrere.emergency_contact_no ? confrere.emergency_contact_no.toString() : null,
      personal_mailid1: confrere.personal_mailid1,
      image_file_name: confrere.image_file_name,
      image_file_path: confrere.image_file_path,
      created_by: confrere.created_by,
      created_date: confrere.created_date,
      updated_by: confrere.updated_by,
      updated_date: confrere.updated_date,
    };

    // Send the response with confrere details
    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confrere by code:', error);
    res.status(500).json({ error: error.message || 'An error occurred while fetching the confrere' });
  }
};

// export const getConfrere = async (req, res) => {
//   try {
//     const { confrer_code } = req.params;

//     // Find the confrere using confrer_code
//     const confrere = await prisma.confreres_dtl.findFirst({
//       where: await recordWhere(req, prisma, { confrer_code }),
//     });

//     if (!confrere) {
//       return res.status(404).json({ error: `Confrere with code ${confrer_code} not found` });
//     }

//     // Fetch related member type and nationality names
//     const memberType = await prisma.quickcode_mst.findFirst({
//       where: {
//         quick_code: confrere.member_type_code,
//         quick_code_type: 'memtyp',
//       },
//       select: {
//         quickcode_name: true,
//       },
//     });

//     const nationality = await prisma.quickcode_mst.findFirst({
//       where: {
//         quick_code: confrere.nationality_code,
//         quick_code_type: 'natlty',
//       },
//       select: {
//         quickcode_name: true,
//       },
//     });

//      // Fetch blood group only if blood_group_code is not null
//      let bloodGroup = null;
//      if (confrere.blood_group_code) {
//        bloodGroup = await prisma.bloodgroup_metadata.findFirst({
//          where: {
//            bloodgroup: confrere.blood_group_code, // Correct field name
//          },
//          select: {
//            bloodgroup: true,
//          },
//        });
//      }

//     // Fetch province name from province_mst table using province_code
//     const province = await prisma.province_mst.findFirst({
//       where: {
//         province_code: confrere.province_code,
//       },
//       select: {
//         province_name: true,
//       },
//     });

//     const fullName = [confrere.first_name, confrere.middle_name, confrere.last_name]
//       .filter(Boolean) // Filter out null or undefined values
//       .join(' ');      // Join with a space

//     // Fetch feedback details from confreres_feedback_dtl table
//     let feedbacks = await prisma.confreres_feedback_dtl.findMany({
//       where: { confrer_code },
//       select: {
//         confrer_code:true,
//         confrer_feedback_seq_no: true,
//         commencement_date: true,
//         designation_code: true,
//         feedback_type_code: true,
//         title_subject: true,
//         feedback_description: true,
//         remarks: true,
//         signature: true,
//         feedback_file_name: true,
//         feedback_file_path: true,
//       },
//     });

//     // Fetch designation name for each feedback's designation_code
//     feedbacks = await Promise.all(feedbacks.map(async (feedback) => {
//       const designation = await prisma.quickcode_mst.findFirst({
//         where: {
//           quick_code: feedback.designation_code,
//           quick_code_type: 'destyp',
//         },
//         select: {
//           quickcode_name: true,
//         },
//       });
//       return {
//         ...feedback,
//         designation_name: designation ? designation.quickcode_name : 'N/A',
//       };
//     }));

//     const prepareContactField = (isd, contactNo) => (isd && contactNo) ? `${isd} ${contactNo}` : null;

//     // Prepare the response object
//     const responseResult = {
//       confrer_code: confrere.confrer_code,
//       province_code: confrere.province_code,
//       province_name: province ? province.province_name : 'N/A',
//       member_type_name: memberType ? memberType.quickcode_name : 'N/A',
//       blood_group_name: bloodGroup ? bloodGroup.bloodgroup : 'N/A',
//       nationality_name: nationality ? nationality.quickcode_name : 'N/A',
//       name: fullName || 'N/A',
//       birth_date: confrere.birth_date ? confrere.birth_date.toISOString().split('T')[0] : null,
//       baptism_date: confrere.baptism_date ? confrere.baptism_date.toISOString().split('T')[0] : null,
//       confirmation_date: confrere.confirmation_date ? confrere.confirmation_date.toISOString().split('T')[0] : null,
//       first_profession_date: confrere.first_profession_date ? confrere.first_profession_date.toISOString().split('T')[0] : null,
//       final_profession_date: confrere.final_profession_date ? confrere.final_profession_date.toISOString().split('T')[0] : null,
//       ordination_date: confrere.ordination_date ? confrere.ordination_date.toISOString().split('T')[0] : null,
//       personal1_contact_no: prepareContactField(confrere.personal1_isd, confrere.personal1_contact_no),
//       personal2_contact_no: prepareContactField(confrere.personal2_isd, confrere.personal2_contact_no),
//       personal3_contact_no: prepareContactField(confrere.personal3_isd, confrere.personal3_contact_no),
//       watsup1_no: prepareContactField(confrere.watsup1_isd, confrere.watsup1_no),
//       watsup2_no: prepareContactField(confrere.watsup2_isd, confrere.watsup2_no),
//       watsup3_no: prepareContactField(confrere.watsup3_isd, confrere.watsup3_no),
//       emergency_contact_no: prepareContactField(confrere.emergency_isd, confrere.emergency_contact_no),
//       personal_mailid1: confrere.personal_mailid1,
//       image_file_name: confrere.image_file_name,
//       image_file_path: confrere.image_file_path,
//       feedbacks: feedbacks.length > 0 ? feedbacks : 'No feedback available', // Feedback details with designation name
//     };

//     // Send the response
//     res.status(200).json(responseResult);
//   } catch (error) {
//     console.error('Error fetching confrere and feedback by code:', error);
//     res.status(500).json({ error: error.message || 'An error occurred while fetching the confrere' });
//   }
// };



export const getConfrere = async (req, res) => {
  try {
    const { confrer_code } = req.params;

    // Find the confrere using confrer_code
    const confrere = await prisma.confreres_dtl.findFirst({
      where: estatusRecordWhere(req) || await recordWhere(req, prisma, { confrer_code }),
    });

    if (!confrere) {
      return res.status(404).json({ error: `Confrere with code ${confrer_code} not found` });
    }

    // Fetch related member type and nationality names
    const memberType = confrere.member_type_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: confrere.member_type_code,
        quick_code_type: 'memtyp',
      },
      select: {
        quickcode_name: true,
      },
    }) : null;

    const nationality = confrere.nationality_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: confrere.nationality_code,
        quick_code_type: 'natlty',
      },
      select: {
        quickcode_name: true,
      },
    }) : null;

    // Fetch blood group only if blood_group_code is not null
    let bloodGroup = null;
    if (confrere.blood_group_code) {
      bloodGroup = await prisma.bloodgroup_metadata.findFirst({
        where: {
          bloodgroup: confrere.blood_group_code, // Correct field name
        },
        select: {
          bloodgroup: true,
        },
      });
    }

    // Fetch province name from province_mst table using province_code
    const province = await prisma.province_mst.findFirst({
      where: {
        province_code: confrere.province_code,
      },
      select: {
        province_name: true,
      },
    });

    const fullName = [confrere.first_name, confrere.middle_name, confrere.last_name]
      .filter(Boolean) // Filter out null or undefined values
      .join(' ');      // Join with a space

    // Fetch current designation (end_date = NULL)
    const currentDesignation = await prisma.appoint_transfer_dtl.findMany({
      where: { confrer_code, designation_end_date: null, is_active: true },
      select: {
        designation_code: true,
        designation_appn_date: true,
        centre_code: true,
        province_code: true,
        division_type_code: true,
        division_code: true,
      },
    });

    // Fetch previous designations (end_date != NULL)
    const previousDesignations = await Promise.all([
      prisma.appoint_transfer_dtl.findMany({
        where: {
          confrer_code,
          designation_end_date: { not: null },
        },
        select: {
          designation_code: true,
          designation_appn_date: true,
          designation_end_date: true,
          centre_code: true,
        },
      }),
    
      prisma.appoint_transfer_his_dtl.findMany({
        where: {
          confrer_code,
          designation_end_date: { not: null },
        },
        select: {
          designation_code: true,
          designation_appn_date: true,
          designation_end_date: true,
          centre_code: true,
        },
      }),
    ]);

    // Add designation names for current and previous designations
    // let currentDesignationDetails = null;
    const currentDesignationDetails = await Promise.all(
      currentDesignation.map(async (designation) => {
        const designationName = await prisma.quickcode_mst.findFirst({
          where: { quick_code: designation.designation_code, quick_code_type: 'destyp' },
          select: { quickcode_name: true },
        });

        const centreDetails = await prisma.centre_dtl.findFirst({
          where: { centre_code: designation.centre_code, province_code: designation.province_code, division_type_code: designation.division_type_code, division_code: designation.division_code },
          select: { centre_name: true, centre_place: true, address1: true, address2: true, address3: true },
        });

        const fullAddress = [centreDetails?.address1, centreDetails?.address2, centreDetails?.address3]
          .filter(Boolean)
          .join(', ') || 'N/A';

        let totalYearsServed = 0;
        let totalMonthsServed = 0;

        if (designation.designation_appn_date) {
          const startDate = new Date(designation.designation_appn_date);
          const currentDate = new Date();

          const yearsDifference = currentDate.getFullYear() - startDate.getFullYear();
          const monthsDifference = currentDate.getMonth() - startDate.getMonth();

          if (monthsDifference < 0) {
            totalYearsServed = yearsDifference - 1;
            totalMonthsServed = monthsDifference + 12;
          } else {
            totalYearsServed = yearsDifference;
            totalMonthsServed = monthsDifference;
          }
        }

        return {
          designation_name: designationName?.quickcode_name || 'N/A',
          start_date: designation.designation_appn_date?.toISOString().split('T')[0] || null,
          centre_name: centreDetails?.centre_name || 'Not assigned',
          centre_place: centreDetails?.centre_place || 'N/A',
          centre_address: fullAddress,
          total_years_served: `${totalYearsServed} Year(s) ${totalMonthsServed} Month(s)`,
        };
      })
    );


    // Flatten and sort by `designation_end_date` (descending)
const allPreviousDesignations = [...previousDesignations[0], ...previousDesignations[1]]
.sort((a, b) => new Date(b.designation_end_date) - new Date(a.designation_end_date));

// Process each designation to fetch additional details
const previousDesignationDetails = await Promise.all(
allPreviousDesignations.map(async (designation) => {
  // Fetch designation name
  const designationName = await prisma.quickcode_mst.findFirst({
    where: {
      quick_code: designation.designation_code,
      quick_code_type: 'destyp',
    },
    select: { quickcode_name: true },
  });

  // Fetch centre details
  const centreDetails = designation.centre_code
    ? await prisma.centre_dtl.findFirst({
        where: { centre_code: designation.centre_code },
        select: { centre_name: true, centre_place: true, address1: true, address2: true, address3: true },
      })
    : null;

  const fullAddress = centreDetails
    ? [centreDetails.address1, centreDetails.address2, centreDetails.address3]
        .filter(Boolean)
        .join(', ') || 'N/A'
    : 'N/A';

  // Calculate total years/months served
  let totalYearsServed = 0;
  let totalMonthsServed = 0;
  if (designation.designation_appn_date && designation.designation_end_date) {
    const startDate = new Date(designation.designation_appn_date);
    const endDate = new Date(designation.designation_end_date);
    const yearsDifference = endDate.getFullYear() - startDate.getFullYear();
    const monthsDifference = endDate.getMonth() - startDate.getMonth();

    if (monthsDifference < 0) {
      totalYearsServed = yearsDifference - 1;
      totalMonthsServed = monthsDifference + 12;
    } else {
      totalYearsServed = yearsDifference;
      totalMonthsServed = monthsDifference;
    }
  }

  return {
    designation_name: designationName?.quickcode_name || 'N/A',
    start_date: designation.designation_appn_date
      ? designation.designation_appn_date.toISOString().split('T')[0]
      : null,
    end_date: designation.designation_end_date
      ? designation.designation_end_date.toISOString().split('T')[0]
      : null,
    centre_name: centreDetails?.centre_name || 'N/A',
    centre_place: centreDetails?.centre_place || 'N/A',
    centre_address: fullAddress,
    total_years_served: `${totalYearsServed} Year(s) ${totalMonthsServed} Month(s)`,
  };
})
);



    // Fetch feedback details from confreres_feedback_dtl table
    let feedbacks = await prisma.confreres_feedback_dtl.findMany({
      where: { confrer_code },
      select: {
        confrer_code: true,
        confrer_feedback_seq_no: true,
        commencement_date: true,
        designation_code: true,
        feedback_type_code: true,
        title_subject: true,
        feedback_description: true,
        remarks: true,
        signature: true,
        feedback_file_name: true,
        feedback_file_path: true,
      },
    });

    // Fetch designation name for each feedback's designation_code
    feedbacks = await Promise.all(feedbacks.map(async (feedback) => {
      const designation = await prisma.quickcode_mst.findFirst({
        where: {
          quick_code: feedback.designation_code,
          quick_code_type: 'destyp',
        },
        select: {
          quickcode_name: true,
        },
      });
      return {
        ...feedback,
        designation_name: designation ? designation.quickcode_name : 'N/A',
      };
    }));

    const prepareContactField = (isd, contactNo) => (isd && contactNo) ? `${isd} ${contactNo}` : null;

    // Prepare the response object
    const responseResult = {
      confrer_code: confrere.confrer_code,
      province_code: confrere.province_code,
      province_name: province ? province.province_name : 'N/A',
      member_type_name: memberType ? memberType.quickcode_name : 'N/A',
      blood_group_name: bloodGroup ? bloodGroup.bloodgroup : 'N/A',
      nationality_name: nationality ? nationality.quickcode_name : 'N/A',
      name: fullName || 'N/A',
      birth_date: confrere.birth_date ? confrere.birth_date.toISOString().split('T')[0] : null,
      baptism_date: confrere.baptism_date ? confrere.baptism_date.toISOString().split('T')[0] : null,
      confirmation_date: confrere.confirmation_date ? confrere.confirmation_date.toISOString().split('T')[0] : null,
      first_profession_date: confrere.first_profession_date ? confrere.first_profession_date.toISOString().split('T')[0] : null,
      final_profession_date: confrere.final_profession_date ? confrere.final_profession_date.toISOString().split('T')[0] : null,
      ordination_date: confrere.ordination_date ? confrere.ordination_date.toISOString().split('T')[0] : null,
      personal1_contact_no: prepareContactField(confrere.personal1_isd, confrere.personal1_contact_no),
      personal2_contact_no: prepareContactField(confrere.personal2_isd, confrere.personal2_contact_no),
      personal3_contact_no: prepareContactField(confrere.personal3_isd, confrere.personal3_contact_no),
      watsup1_no: prepareContactField(confrere.watsup1_isd, confrere.watsup1_no),
      watsup2_no: prepareContactField(confrere.watsup2_isd, confrere.watsup2_no),
      watsup3_no: prepareContactField(confrere.watsup3_isd, confrere.watsup3_no),
      emergency_contact_no: prepareContactField(confrere.emergency_isd, confrere.emergency_contact_no),
      personal_mailid1: confrere.personal_mailid1,
      image_file_name: confrere.image_file_name,
      image_file_path: confrere.image_file_path,
      feedbacks: feedbacks.length > 0 ? feedbacks : 'No feedback available', // Feedback details with designation name
      current_designation: currentDesignationDetails || 'No current designation',
      current_centre_name: [...new Set(currentDesignationDetails.map((d) => d.centre_name).filter((name) => name !== 'Not assigned'))].join('; ') || 'Not assigned',
      previous_designations: previousDesignationDetails.length > 0 ? previousDesignationDetails : [],


    };

    // Send the response
    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confrere and feedback by code:', error);
    res.status(500).json({ error: error.message || 'An error occurred while fetching the confrere' });
  }
};










