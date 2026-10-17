import {provisionCreatedMember} from '../../services/memberCreationHook.js';
import { estatusRecordWhere } from '../../utils/estatusAccess.js';
import { recordWhere } from '../../utils/recordAccess.js';
import { PrismaClient } from '@prisma/client';
import upload from '../../middlewares/multer.js';
import xlsx from 'xlsx';
import fs from 'fs';
import jwt from "jsonwebtoken";
import { error } from 'console';
import { JWT_SECRET } from "../../config/index.js";
import {uploadBufferToBlob} from "../../middlewares/azureBlob.js"
import multer from 'multer';
import { provinceScopeWhere, resolveDataScope, sendScopeError } from '../../utils/dataScope.js';
import { resolveAuthorizedProvince } from '../../services/confrereCreationService.js';
const excelUpload = multer();



const prisma = new PrismaClient();
const maxLength = (str, len) => (str && str.length > len ? str.substring(0, len) : str);

export const saveScholasticDetail = async (req, res) => {
  excelUpload.single('image_file')(req, res, async (err) => {
    if (err) {
      return res.status(500).json({ error: 'File upload error' });
    }

    try {
      console.log('Request Body:', req.body);
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

      const createdBy = decoded.role_name || decoded.username || "Unknown";
      const province = await resolveAuthorizedProvince({
        prisma,
        user: decoded,
        requestedProvince: req.body.province_code,
      });
      const province_code = province.province_code;

      // Remove spaces from keys in the request body
      const sanitizeKey = (key) => key.trim();
      const {

        first_name,
        middle_name,
        last_name,
        birth_date,
        baptism_date,
        confirmation_date,
        first_profession_date,
        final_profession_date,
        diaconate_ordination_date,
        ordination_date,
        personal1_isd,
        personal1_contact_no,
        watsup1_isd,
        watsup1_no,
        emergency_isd,
        emergency_contact_no,
        personal_mailid1,
        blood_group_code,
        nationality_code,
        language_code = 'en', // Set default value for language_code
        concurrency_val = 1, // Set default value for concurrency_val
        created_by,
        created_date,
      } = Object.fromEntries(
        Object.entries(req.body).map(([key, value]) => [sanitizeKey(key), value])
      );

      // Validate required fields
      const requiredFields = [
        { field: "first_name", message: "First Name is required" },
        { field: "last_name", message: "Last Name is required" },
        { field: "birth_date", message: "Birth date is required" },
        { field: "baptism_date", message: "Baptism date is required" },
        { field: "confirmation_date", message: "Confirmation date is required" },
        { field: "personal1_contact_no", message: "Personal Contact Number 1 is required" },
        { field: "personal1_isd", message: "Personal isd 1 is required" },
        { field: "blood_group_code", message: "Blood Group is required" },
        { field: "nationality_code", message: "Nationality is required" },
      ];

      const missingFields = requiredFields
        .filter(({ field }) => !req.body[field] || req.body[field].toString().trim() === "")
        .map(({ message }) => message);

      if (missingFields.length > 0) {
        return res.status(400).json({
          error: `Missing fields: ${missingFields.join(", ")}`,
        });
      }


      const existingEmail = personal_mailid1 ? await prisma.scholastics_dtl.findFirst({
        where: {
          personal_mailid1: {
            equals: personal_mailid1,
            mode: 'insensitive' // Case-insensitive check
          }
        }
      }) : null;

      if (existingEmail) {
        return res.status(400).json({ error: 'Email already exists.' });
      }

      // Convert date formats
      const parseDate = (dateStr) => {
        if (!dateStr || dateStr.trim() === "") return null; // Return null for empty strings
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
          throw new Error(`Invalid date format for ${dateStr}`);
        }
        return date;
      };

      // Parse required and optional dates
      const parsedBirthDate = parseDate(birth_date);
      const parsedBaptismDate = parseDate(baptism_date);
      const parsedConfirmationDate = parseDate(confirmation_date);

      // Optional dates
      const parsedFirstProfessionDate = parseDate(first_profession_date);
      const parsedFinalProfessionDate = parseDate(final_profession_date);
      const parsedDiaconateOrdinationDate = parseDate(diaconate_ordination_date);
      const parsedOrdinationDate = parseDate(ordination_date);

      // Generate scholastic_code with auto-increment logic
      const lastRecord = await prisma.scholastics_dtl.findFirst({
        orderBy: { scholastic_code: 'desc' }
      });

      let scholastic_code = 'SCH001'; // Default value if there are no records

      if (lastRecord) {
        const lastCode = parseInt(lastRecord.scholastic_code.replace('SCH', ''), 10);
        scholastic_code = `SCH${String(lastCode + 1).padStart(3, '0')}`;
      }

      // Image Upload to Azure Blob Storage ✅
      let image_file_name = null;
      let image_file_path = null;

      if (req.file) {
        image_file_name = maxLength(req.file.originalname, 100);
        image_file_path = await uploadBufferToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
      }
      // Set the current date if created_date is not provided
      const finalCreatedDate = created_date ? new Date(created_date) : new Date();

      // Insert the data into the database
      const newScholastic = await prisma.scholastics_dtl.create({
        data: {
          scholastic_code,
          province_code,
          first_name,
          middle_name: middle_name || null,
          last_name,
          image_file_name,
          image_file_path,
          birth_date: parsedBirthDate,
          baptism_date: parsedBaptismDate,
          confirmation_date: parsedConfirmationDate,
          first_profession_date: parsedFirstProfessionDate,
          final_profession_date: parsedFinalProfessionDate,
          diaconate_ordination_date: parsedDiaconateOrdinationDate,
          ordination_date: parsedOrdinationDate,
          personal1_isd: personal1_isd || null,
          personal1_contact_no: personal1_contact_no ? BigInt(personal1_contact_no) : null,
          watsup1_isd: watsup1_isd || null,
          watsup1_no: watsup1_no ? BigInt(watsup1_no) : null,
          emergency_isd: emergency_isd || null,
          emergency_contact_no: emergency_contact_no ? BigInt(emergency_contact_no) : null,
          personal_mailid1: personal_mailid1 || '',
          blood_group_code: blood_group_code || null,
          nationality_code: nationality_code || null,
          language_code,
          concurrency_val,
          created_by: res.locals.user?.user_id || createdBy,
          created_date: finalCreatedDate,
        }
      });

      // Convert BigInt fields to strings before sending response
      const responseData = JSON.parse(
        JSON.stringify(newScholastic, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      );

      responseData.member_access=await provisionCreatedMember(prisma,'Scholastic',newScholastic,res.locals.user?.user_id || 'administrator');
      res.status(201).json(responseData);
    } catch (error) {
      console.log(error);
      res.status(error.status || 500).json({ error: error.message });
    }
  });
};

export const getAllScholastics = async (req, res) => {
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code || null);

    // Get all scholastic details
    const scholastics = await prisma.scholastics_dtl.findMany({
      where: {
        ...provinceScopeWhere(provinceCodes),
        is_active: true,
      },
    });

    const responseData = scholastics.map((s) => {
      return {
        ...s,
        image_file_path: s.image_file_path || null,
        personal1_contact_no: s.personal1_contact_no ? s.personal1_contact_no.toString() : null,
        watsup1_no: s.watsup1_no ? s.watsup1_no.toString() : null,
        emergency_contact_no: s.emergency_contact_no ? s.emergency_contact_no.toString() : null,
      };
    }).sort((a, b) => {
      const nameA = `${a.first_name} ${a.middle_name || ''} ${a.last_name}`.trim().toLowerCase();
      const nameB = `${b.first_name} ${b.middle_name || ''} ${b.last_name}`.trim().toLowerCase();
      return nameA.localeCompare(nameB);
    });

    res.status(200).json(responseData);
  } catch (error) {
    console.log(error);
    sendScopeError(res, error, "Failed to load scholastics");
  }
};


export const getScholasticDetailByCode = async (req, res) => {
  const { scholastic_code } = req.query;

  try {
    if (scholastic_code) {
      // Get the scholastic detail by scholastic_code using findFirst
      const scholastic = await prisma.scholastics_dtl.findFirst({
        where: { scholastic_code },
      });

      if (!scholastic) {
        return res.status(404).json({ error: 'Scholastic not found.' });
      }

      // Convert BigInt fields to strings before sending response
      const responseData = JSON.parse(
        JSON.stringify(scholastic, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      );

      return res.status(200).json(responseData);
    } else {
      return res.status(400).json({ error: 'scholastic_code is required.' });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
};


export const deleteScholasticByCode = async (req, res) => {
  const { scholastic_code } = req.params;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const provinceName = decoded.province_name;
    const province = await prisma.province_mst.findFirst({
      where: { province_name: provinceName },
      select: { province_code: true },
    });

    if (!province) {
      return res.status(404).json({ error: "Province not found for the given name" });
    }

    const province_code = province.province_code;

    if (!scholastic_code) {
      return res.status(400).json({ error: 'scholastic_code is required.' });
    }

    const linkedConfrere = await prisma.confreres_dtl.findFirst({
      where: { confrer_code: scholastic_code },
    });

    const scholastic = await prisma.scholastics_dtl.findFirst({
      where: { scholastic_code },
    });

    if (!scholastic) {
      return res.status(404).json({ error: 'Scholastic not found.' });
    }

     // 🆕 Check if scholastic_code is used inside scholastics_feedback_dtl
    const feedbackExists = await prisma.scholastics_feedback_dtl.findFirst({
      where: { scholastic_code },
    });

    if (feedbackExists) {
      return res.status(400).json({
        error: "Cannot delete Scholastic because it is used in Scholastics Feedback table."
      });
    }

    const deletedScholastic = await prisma.scholastics_dtl.delete({
      where: {
        scholastic_code_province_code: {
          scholastic_code: scholastic.scholastic_code,
          province_code: province_code,
        },
      },
    });

    const responseData = JSON.parse(
      JSON.stringify(deletedScholastic, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    );

    if (linkedConfrere) {
      res.status(200).json({ 
        message: 'Scholastic deleted successfully, but it was linked with a Confrere.', 
        data: responseData 
      });
    } else {
      res.status(200).json({ 
        message: 'Scholastic deleted successfully.', 
        data: responseData 
      });
    }

  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
};



export const updateScholasticDetail = async (req, res) => {
  excelUpload.single('image_file')(req, res, async (err) => {
    if (err) {
      return res.status(500).json({ error: 'File upload error' });
    }

    const { scholastic_code } = req.params;

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

      const provinceName = decoded.province_name;
      const UpdateBy = decoded.role_name || decoded.username || "Unknown";

      const province = await prisma.province_mst.findFirst({
        where: { province_name: provinceName },
        select: { province_code: true, short_name: true },
      });

      if (!province) {
        return res.status(404).json({ error: "Province not found for the given name" });
      }

      const province_code = province.province_code;

      if (!scholastic_code) {
        return res.status(400).json({ error: 'scholastic_code is required.' });
      }

      const scholastic = await prisma.scholastics_dtl.findFirst({
        where: { scholastic_code },
      });

      if (!scholastic) {
        return res.status(404).json({ error: 'Scholastic not found.' });
      }



      // Parse request data
      const sanitizeKey = (key) => key.trim();
      let {
        ordination_date,
        birth_date,
        baptism_date,
        confirmation_date,
        first_profession_date,
        final_profession_date,
        diaconate_ordination_date,
        member_type_code,
        personal_mailid1,
        personal2_isd,
        personal2_contact_no,
        personal3_isd,
        personal3_contact_no,
        ...updateFields
      } = Object.fromEntries(
        Object.entries(req.body).filter(([key]) => key !== "nationality_name")

      );

      // Validate required fields
      const requiredFields = [
        { field: "first_name", message: "First Name is required" },
        { field: "last_name", message: "Last Name is required" },
        { field: "birth_date", message: "Birth date is required" },
        { field: "baptism_date", message: "Baptism date is required" },
        { field: "confirmation_date", message: "Confirmation date is required" },
        { field: "personal1_contact_no", message: "Personal Contact Number 1 is required" },
        { field: "personal1_isd", message: "Personal isd 1 is required" },
        { field: "personal_mailid1", message: "Personal Email is required" },
        { field: "blood_group_code", message: "Blood Group is required" },
        { field: "nationality_code", message: "Nationality is required" },
      ];

      const missingFields = requiredFields
        .filter(({ field }) => !req.body[field] || req.body[field].toString().trim() === "")
        .map(({ message }) => message);

      if (missingFields.length > 0) {
        return res.status(400).json({
          error: `Missing fields: ${missingFields.join(", ")}`,
        });
      }

      // Check if the new email is already used by another record
      if (personal_mailid1) {
        const existingEmail = await prisma.scholastics_dtl.findFirst({
          where: {
            personal_mailid1: {
              equals: personal_mailid1,
              mode: 'insensitive', // Case-insensitive check
            },
            scholastic_code: {
              not: scholastic_code, // Exclude the current record
            },
          },
        });

        if (existingEmail) {
          return res.status(400).json({ error: 'Email already exists.' });
        }
      }

      // Image upload to Azure Blob Storage
     
      let image_file_name = scholastic.image_file_name;
      let image_file_path = scholastic.image_file_path;
      if (req.file) {
        image_file_name = req.file.originalname;
        image_file_path = await uploadBufferToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
      }


      

      const parseDate = (dateStr) => {
        if (!dateStr) return null;
        const parsedDate = new Date(dateStr);
        return isNaN(parsedDate.getTime()) ? null : parsedDate;
      };


      const parsedBirthDate = parseDate(birth_date);
      const parsedBaptismDate = parseDate(baptism_date);
      const parsedConfirmationDate = parseDate(confirmation_date)
      const parsedOrdinationDate = parseDate(ordination_date);
      const parsedFirstProfessionDate = parseDate(first_profession_date);
      const parsedFinalProfessionDate = parseDate(final_profession_date);
      const parsedDiaconateOrdinationDate = parseDate(diaconate_ordination_date);


      const parseBigIntField = (value) => {
        return value && value.trim() !== '' ? BigInt(value.trim()) : null;
      };

      delete updateFields.image_file; // Remove image_file manually
      // Update scholastics_dtl
      const updatedScholastic = await prisma.scholastics_dtl.update({
        where: {
          scholastic_code_province_code: {
            scholastic_code: scholastic.scholastic_code,
            province_code: scholastic.province_code,
          },
        },
        data: {
          ...updateFields,
          first_profession_date: parsedFirstProfessionDate || scholastic.first_profession_date,
          final_profession_date: parsedFinalProfessionDate || scholastic.final_profession_date,
          diaconate_ordination_date: parsedDiaconateOrdinationDate || scholastic.diaconate_ordination_date,
          ordination_date: parsedOrdinationDate || scholastic.ordination_date,
          birth_date: parsedBirthDate || scholastic.birth_date,
          baptism_date: parsedBaptismDate || scholastic.baptism_date,
          confirmation_date: parsedConfirmationDate || scholastic.confirmation_date,
          member_type_code: req.body.member_type_code || scholastic.member_type_code,
          watsup1_no: parseBigIntField(req.body.watsup1_no),
          emergency_contact_no: parseBigIntField(req.body.emergency_contact_no),
          image_file_name: req.file ? req.file.originalname : scholastic.image_file_name,
          image_file_path: req.file ? req.file.path : scholastic.image_file_path,
          personal_mailid1: req.body.personal_mailid1 || scholastic.personal_mailid1,
          updated_date: new Date(),
          image_file_name,
          image_file_path,
        },
      });

      // Create confreres_dtl entry if ordination_date is provided
      if (parsedOrdinationDate) {

        if (parsedOrdinationDate) {
          const confrerCode = `${scholastic.scholastic_code}`;

          const confreresData = {
            confrer_code: confrerCode, // Generated confrere code
            province_code: scholastic.province_code,
            first_name: req.body.first_name || scholastic.first_name || null,
            middle_name: req.body.middle_name || scholastic.middle_name || null,
            last_name: req.body.last_name || scholastic.last_name || null,
            birth_date: req.body.birth_date ? parseDate(req.body.birth_date) : scholastic.birth_date || null,
            confirmation_date: req.body.confirmation_date ? parseDate(req.body.confirmation_date) : scholastic.confirmation_date || null,
            baptism_date: req.body.baptism_date ? parseDate(req.body.baptism_date) : scholastic.baptism_date || null,
            blood_group_code: req.body.blood_group_code || scholastic.blood_group_code || null,
            nationality_code: req.body.nationality_code || scholastic.nationality_code || null,
            first_profession_date: req.body.first_profession_date
              ? parseDate(req.body.first_profession_date)
              : scholastic.first_profession_date || null,
            final_profession_date: req.body.final_profession_date
              ? parseDate(req.body.final_profession_date)
              : scholastic.final_profession_date || null,
            personal_mailid1: req.body.personal_mailid1 || scholastic.personal_mailid1 || null,
            ordination_date: parsedOrdinationDate,
            member_type_code: member_type_code || scholastic.member_type_code || null,
            personal1_isd: req.body.personal1_isd || scholastic.personal1_isd || null,
            personal1_contact_no: req.body.personal1_contact_no
              ? String(req.body.personal1_contact_no)
              : scholastic.personal1_contact_no
                ? String(scholastic.personal1_contact_no)
                : null,
            personal2_isd: req.body.personal2_isd || scholastic.personal2_isd || null,
            personal2_contact_no: req.body.personal2_contact_no
              ? String(req.body.personal2_contact_no)
              : scholastic.personal2_contact_no
                ? String(scholastic.personal2_contact_no)
                : null,
            personal3_isd: req.body.personal3_isd || scholastic.personal3_isd || null,
            personal3_contact_no: req.body.personal3_contact_no
              ? String(req.body.personal3_contact_no)
              : scholastic.personal3_contact_no
                ? String(scholastic.personal3_contact_no)
                : null,
            watsup1_isd: req.body.watsup1_isd || scholastic.watsup1_isd || null,
            watsup1_no: req.body.watsup1_no
              ? String(req.body.watsup1_no)
              : scholastic.watsup1_no
                ? String(scholastic.watsup1_no)
                : null,
            emergency_isd: req.body.emergency_isd || scholastic.emergency_isd || null,
            emergency_contact_no: req.body.emergency_contact_no
              ? String(req.body.emergency_contact_no)
              : scholastic.emergency_contact_no
                ? String(scholastic.emergency_contact_no)
                : null,
            image_file_name: image_file_name,   // ✅ Should be here
            image_file_path: image_file_path,   // ✅ Should be here
            created_by: res.locals.user?.user_id || UpdateBy,
            created_date: new Date(),
          };
          

          // Validate the BigInt fields to avoid saving invalid data
          if (isNaN(confreresData.personal2_contact_no)) {
            confreresData.personal2_contact_no = null;
          }
          if (isNaN(confreresData.personal3_contact_no)) {
            confreresData.personal3_contact_no = null;
          }

          const existingConfrer = await prisma.confreres_dtl.findFirst({
            where: {
              confrer_code: confrerCode,
              province_code: scholastic.province_code,
            },
          });

          if (existingConfrer) {
            // Update existing confreres_dtl record
            await prisma.confreres_dtl.update({
              where: {
                confrer_code_province_code: {
                  confrer_code: confrerCode, // Unique confrer code
                  province_code: scholastic.province_code, // Province code
                },
              },
              data: confreresData,
            });
          } else {
            // Create new confreres_dtl record
            await prisma.confreres_dtl.create({ data: confreresData });
          }
        }
      }

      const responseData = JSON.parse(
        JSON.stringify(updatedScholastic, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      );

      res.status(200).json(responseData);
    } catch (error) {
      console.error('Error updating scholastic:', error);
      res.status(500).json({ error: error.message });
    }
  });
};





export const saveScholasticByExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Token validation
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: error.name === "TokenExpiredError" ? "Token has expired" : "Invalid token" });
    }

    const provinceNameFromToken = decoded.province_name;
    const createdBy = decoded.role_name || decoded.username || 'Unknown';
    if (!provinceNameFromToken) {
      return res.status(400).json({ error: "Province information is missing in token" });
    }

    // Fetch province_code
    const { province_code } = await fetchCodeByName(provinceNameFromToken, 'province');

    // Upload Excel to Azure
    const { buffer, originalname, mimetype } = req.file;
    const blobUrl = await uploadBufferToBlob(buffer, originalname, mimetype);
    console.log(`Excel uploaded to Azure: ${blobUrl}`);

    // Parse Excel
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return res.status(400).json({ error: 'Excel sheet is empty or corrupted.' });
    }

    const rows = xlsx.utils.sheet_to_json(sheet);
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'No data found in the Excel file.' });
    }

    const successRecords = [];
    const failedRecords = [];

    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      if (typeof dateStr === 'number') return new Date((dateStr - 25569) * 86400 * 1000);
      const match = dateStr.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
      if (match) return new Date(`${match[3]}-${match[2]}-${match[1]}`);
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) throw new Error(`Invalid date: ${dateStr}`);
      return parsed;
    };

    for (const row of rows) {
      try {
        const rowProvinceCode = row['Province']
          ? await fetchCodeByName(row['Province'], 'province')
          : province_code;

        const blood_group_code = row['Blood Group'] ? await fetchCodeByName(row['Blood Group'], 'bloodGroup') : null;
        const nationality_code = row['Nationality'] ? await fetchCodeByName(row['Nationality'], 'nationality') : null;

        const lastRecord = await prisma.scholastics_dtl.findFirst({
          orderBy: { scholastic_code: 'desc' }
        });

        let scholastic_code = 'SCH001';
        if (lastRecord) {
          const lastCode = parseInt(lastRecord.scholastic_code.replace('SCH', ''), 10);
          scholastic_code = `SCH${String(lastCode + 1).padStart(3, '0')}`;
        }

        const existingConfrere = row['Personal Email'] ? await prisma.scholastics_dtl.findFirst({
          where: { personal_mailid1: row['Personal Email'] },
        }) : null;

        if (existingConfrere) {
          failedRecords.push({ row, error: 'Email already exists' });
          continue;
        }

        const newScholasticData = {
          scholastic_code,
          province_code: rowProvinceCode,
          blood_group_code: blood_group_code ? maxLength(blood_group_code, 10) : null,
          nationality_code,
          first_name: row['First Name'],
          middle_name: row['Middle Name'] || null,
          last_name: row['Last Name'],
          birth_date: row['Date of Birth'] ? parseDate(row['Date of Birth']) : null,
          baptism_date: row['Baptism Date'] ? parseDate(row['Baptism Date']) : null,
          confirmation_date: row['Confirmation Date'] ? parseDate(row['Confirmation Date']) : null,
          first_profession_date: row['First Profession Date'] ? parseDate(row['First Profession Date']) : null,
          final_profession_date: row['Final Profession Date'] ? parseDate(row['Final Profession Date']) : null,
          diaconate_ordination_date: row['Diaconate Ordination Date'] ? parseDate(row['Diaconate Ordination Date']) : null,
          ordination_date: row['Ordination Date'] ? parseDate(row['Ordination Date']) : null,
          personal1_isd: row['Personal ISD'] ? String(row['Personal ISD']) : null,
          personal1_contact_no: row['Personal Contact No'] ? BigInt(row['Personal Contact No']) : null,
          watsup1_isd: row['Watsup ISD'] ? String(row['Watsup ISD']) : null,
          watsup1_no: row['Watsup No'] ? BigInt(row['Watsup No']) : null,
          emergency_isd: row['Emergency ISD'] ? String(row['Emergency ISD']) : null,
          emergency_contact_no: row['Emergency Contact No'] ? BigInt(row['Emergency Contact No']) : null,
          personal_mailid1: row['Personal Email'] || '',
          language_code: 'en',
          concurrency_val: 1,
          created_by: res.locals.user?.user_id || createdBy,
          created_date: row['Created Date'] ? new Date(row['Created Date']) : new Date(),
        };

        const createdMember=await prisma.scholastics_dtl.create({ data: newScholasticData });
        const member_access=await provisionCreatedMember(prisma,'Scholastic',createdMember,res.locals.user?.user_id || 'import');
        successRecords.push({...row,member_access});
      } catch (err) {
        failedRecords.push({ row, error: err.message });
      }
    }

    // Final response
    if (successRecords.length && !failedRecords.length) {
      return res.status(200).json({ message: 'All scholastic details uploaded successfully.', savedRecords: successRecords });
    } else if (successRecords.length && failedRecords.length) {
      return res.status(207).json({
        message: 'Some records uploaded. Some failed.',
        savedRecords: successRecords,
        failedRecords
      });
    } else {
      return res.status(400).json({
        message: 'All records failed.',
        failedRecords
      });
    }

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'An error occurred while processing the file.' });
  }
};



async function fetchCodeByName(name, type) {
  name = name.trim();
  let whereCondition = {};

  switch (type) {
    case 'province':
      whereCondition = {
        OR: [
          { province_name: { equals: name, mode: 'insensitive' } },
          { province_code: name }
        ]
      };
      break;
    case 'bloodGroup':
      whereCondition = {
        bloodgroup: { equals: name, mode: 'insensitive' }
      };
      break;
    case 'nationality':
      whereCondition = {
        OR: [
          { quickcode_name: name, quick_code_type: 'natlty' },
          { quick_code: name }
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
    throw new Error(`${type} name '${name}' not found`);
  }

  return type === 'province' ? result.province_code : (type === 'bloodGroup' ? result.BloodGroup : result.quick_code);
}


export const getScholasticDetails = async (req, res) => {
  const { scholastic_code } = req.params;

  try {
    if (scholastic_code) {
      // Get the scholastic detail by scholastic_code using findFirst
      const scholastic = await prisma.scholastics_dtl.findFirst({
        where: estatusRecordWhere(req) || await recordWhere(req, prisma, { scholastic_code }),
      });

      if (!scholastic) {
        return res.status(404).json({ error: 'Scholastic not found.' });
      }

      // Destructure first_name, middle_name, last_name, and nationality_code from scholastic
      const { first_name, middle_name, last_name, nationality_code, province_code } = scholastic;
      console.log("Nationality Code:", nationality_code);

      // Define or extract the quick_code_type based on your application logic
      const quick_code_type = 'natlty'; // Make sure this is the correct type
      console.log("Quick Code Type:", quick_code_type);

      // Find the nationality name from quickcode_mst
      let nationalityCode = await prisma.quickcode_mst.findFirst({
        where: {
          quick_code_type: quick_code_type,
          quick_code: nationality_code, // nationality_code from scholastic
        },
        select: { quickcode_name: true },
      });

      console.log("Nationality Code Found:", nationalityCode);

      // If no nationality code is found, set the value to "N/A"
      const nationality_name = nationalityCode ? nationalityCode.quickcode_name : 'N/A';

      const scholasticFeedback = await prisma.scholastics_feedback_dtl.findMany({
        where: { scholastic_code, province_code },
      });

      // if (!scholasticFeedback || scholasticFeedback.length === 0) {
      //   return res.status(404).json({ error: 'No feedback details found for this scholastic.' });
      // }

      // Combine first, middle, and last names
      const full_name = `${first_name || ''} ${middle_name || ''} ${last_name || ''}`.trim();

      let province = await prisma.province_mst.findFirst({
        where: { province_code },
        select: { province_name: true },
      });

      console.log("Province Found:", province);

      const province_name = province ? province.province_name : 'N/A';

      const getQuickCodeNames = async (formationTypeCode, scholasticTypeCode, promotionToCode) => {
        try {
          // Fetch the formation type name
          const formationType = await prisma.quickcode_mst.findFirst({
            where: {
              quick_code: formationTypeCode,
              quick_code_type: 'fortyp',
            },
          });

          // Fetch the scholastic type name
          const scholasticType = await prisma.quickcode_mst.findFirst({
            where: {
              quick_code: scholasticTypeCode,
              quick_code_type: 'schtyp'
            },
          });

          // Fetch the promotion to name
          const promotionTo = await prisma.quickcode_mst.findFirst({
            where: {
              quick_code: promotionToCode,
              quick_code_type: 'promto'
            },
          });

          return {
            formationTypeName: formationType ? formationType.quickcode_name : 'Unknown',
            scholasticTypeName: scholasticType ? scholasticType.quickcode_name : 'Unknown',
            promotionToName: promotionTo ? promotionTo.quickcode_name : 'Unknown',
          };
        } catch (error) {
          console.error('Error fetching quickcodes:', error);
        }
      };

      let admissionPromoDetails = await prisma.scholastics_admisn_promon_dtl.findMany({
        where: { scholastic_code, province_code },
        orderBy: {
          start_date: 'desc', // Sort by start date to prioritize the most recent entry
        },
      });

      // Initialize current promotion and previous promotions array
      let currentPromotion = null;
      let previousPromotion = [];

      // Loop through the promotions to separate the current and previous ones
      for (const promo of admissionPromoDetails) {
        if (promo.end_date === null) {
          // Current promotion (end_date is null)
          currentPromotion = promo;
        } else {
          // Add to previous promotions (end_date is not null)
          previousPromotion.push(promo);
        }
      }

      // Log for debugging
      console.log("Current Promotion Found:", currentPromotion);
      console.log("Previous Promotion Found:", previousPromotion);

      const quickCodeNamesCurrent = await getQuickCodeNames(
        currentPromotion?.formation_type_code,
        currentPromotion?.scholastic_type_code,
        currentPromotion?.promotion_to_code
      );

      // // Fetch quick code names for previous promotion
      // const previousPromotionsWithNames = await Promise.all(
      //   previousPromotion.map(async (promo) => {
      //     const quickCodeNames = await getQuickCodeNames(
      //       promo.formation_type_code,
      //       promo.scholastic_type_code,
      //       promo.promotion_to_code
      //     );

      //     return {
      //       ...promo,
      //       formation_type_name: quickCodeNames.formationTypeName,
      //       scholastic_type_name: quickCodeNames.scholasticTypeName,
      //       promotion_to_name: quickCodeNames.promotionToName,
      //     };
      //   })
      // );

      // Fetch historical promotion details from scholastics_admisn_his_dtl (history table)
      const previousPromotionsHistory = await prisma.scholastics_admisn_his_dtl.findMany({
        where: { scholastic_code, province_code },
        orderBy: { scholastic_his_seq_no: 'desc' }, // Order by historical sequence number
      })

      // Fetch quick code names for historical promotions
      const previousPromotionsWithNames = await Promise.all(
        previousPromotionsHistory.map(async (promo) => {
          const quickCodeNames = await getQuickCodeNames(
            promo.formation_type_code,
            promo.scholastic_type_code,
            promo.promotion_to_code
          );

          return {
            ...promo,
            formation_type_name: quickCodeNames.formationTypeName,
            scholastic_type_name: quickCodeNames.scholasticTypeName,
            promotion_to_name: quickCodeNames.promotionToName,
          };
        })
      );

      // Convert BigInt fields to strings before sending response
      const responseData = {
        ...JSON.parse(
          JSON.stringify(scholastic, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          )
        ),
        nationality_name,
        full_name,
        feedback_details: scholasticFeedback,
        province_name,
        current_promotion_details: currentPromotion
          ? {
            ...currentPromotion,
            formation_type_name: quickCodeNamesCurrent.formationTypeName,
            scholastic_type_name: quickCodeNamesCurrent.scholasticTypeName,
            promotion_to_name: quickCodeNamesCurrent.promotionToName,
          }
          : null,// Current promotion details with added names
        // previous_promotion_details: previousPromotionsWithNames,
        previous_promotion_details: previousPromotionsWithNames,
      }

      return res.status(200).json(responseData);
    } else {
      return res.status(400).json({ error: 'scholastic_code is required.' });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.message });
  }
};


export const getAcademicDetailsByScholasticCode = async (req, res) => {
  const { scholastic_code } = req.params; // Assuming scholastic_code is passed as a URL parameter
  // Authentication check: Extract the token from headers
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

  // Extract province_name from the decoded token and fetch the corresponding province_code
  const provinceName = decoded.province_name;
  const province = await prisma.province_mst.findFirst({
    where: { province_name: provinceName },
    select: { province_code: true },
  });

  if (!province) {
    return res.status(404).json({ error: "Province not found for the given name" });
  }

  const province_code = province.province_code;
  try {
    // Fetch scholastic details
    const scholasticDetails = await prisma.scholastics_admisn_promon_dtl.findMany({
      where: { scholastic_code, province_code },
      select: {
        scholastic_type_code: true,
        academic_year: true,
        province_code: true, // This should return multiple entries if available
      },
    });

    // Check if scholastic details were found
    if (!scholasticDetails || scholasticDetails.length === 0) {
      return res.status(404).json({ message: 'Scholastic details not found for the provided code.' });
    }

    // Fetch quickcode name based on scholastic type code for the first found entry
    const scholasticTypes = await Promise.all(
      scholasticDetails.map(async (detail) => {
        const quickcode = await prisma.quickcode_mst.findFirst({
          where: { quick_code: detail.scholastic_type_code },
          select: { quickcode_name: true },
        });

        // Return the detail with the associated quickcode name
        return {
          ...detail,
          quickcode_name: quickcode ? quickcode.quickcode_name : null, // Include quickcode name if available
        };
      })
    );

    // Collect all unique province codes from the results
    const provinceCodes = [...new Set(scholasticDetails.map(detail => detail.province_code))]; // Unique codes

    // Fetch all province names based on the unique province codes
    const provinces = await prisma.province_mst.findMany({
      where: { province_code: { in: provinceCodes } },
      select: { province_name: true },
    });

    // Create the academic details string
    const academicDetails = scholasticTypes.map(detail => {
      return `${detail.quickcode_name || 'N/A'} ${detail.academic_year}`;
    });

    // Extract province names from the fetched province data
    const provinceNames = provinces.map(province => province.province_name);

    // Return the structured academic details
    res.status(200).json({
      academic_details: academicDetails,
      province_code: provinceCodes.join(', '), // Return the joined codes as a string
      province_name: provinceNames, // Include the array of province names in the response
    });
  } catch (error) {
    console.error(error); // Log the error for debugging
    res.status(500).json({ message: 'An error occurred while retrieving academic details.' });
  }
};

export const getAllScholasticsForExport = async (req, res) => {
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code || null);

    // Fetch Scholastic details filtered by province_code
    const scholastics = await prisma.scholastics_dtl.findMany({
      where: provinceScopeWhere(provinceCodes),
    });

    // Fetch related details for mappings (e.g., blood group, nationality, member type)
    const [quickCodes, nationalities, memberTypes] = await Promise.all([
      prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: { in: ["blodgp"] }, // Blood Group codes
        },
        select: { quick_code: true, quickcode_name: true },
      }),
      prisma.quickcode_mst.findMany({
        where: { quick_code_type: "natlty" }, // Nationality codes
        select: { quick_code: true, quickcode_name: true },
      }),
      prisma.quickcode_mst.findMany({
        where: { quick_code_type: "memtyp" }, // Member type codes
        select: { quick_code: true, quickcode_name: true },
      }),
    ]);

    const quickCodeMap = new Map(quickCodes.map((qc) => [qc.quick_code, qc.quickcode_name]));
    const nationalitiesMap = new Map(nationalities.map((n) => [n.quick_code, n.quickcode_name]));
    const memberTypesMap = new Map(memberTypes.map((m) => [m.quick_code, m.quickcode_name]));

    // Map Scholastic details with additional details
    const scholasticsWithDetails = scholastics.map((scholastic) => ({
      ...scholastic,
      blood_group_name: quickCodeMap.get(scholastic.blood_group_code) || null,
      nationality_name: nationalitiesMap.get(scholastic.nationality_code) || null,
      member_type_name: memberTypesMap.get(scholastic.member_type_code) || null,
      personal1_contact_no: scholastic.personal1_contact_no?.toString() || null,
      watsup1_no: scholastic.watsup1_no?.toString() || null,
      emergency_contact_no: scholastic.emergency_contact_no?.toString() || null,
    }));

    // Return the data
    res.status(200).json(scholasticsWithDetails);
  } catch (error) {
    console.error("Error fetching Scholastic details:", error.message);
    sendScopeError(res, error, "Internal Server Error");
  }
};
