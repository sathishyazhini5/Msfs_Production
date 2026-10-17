import {provisionCreatedMember} from '../../services/memberCreationHook.js';
import { officePersonDetails } from '../../utils/officePersonDetails.js';
import { resolveAuthorizedProvince } from '../../services/confrereCreationService.js';
import { officeCategories, validateOfficeSelections } from '../../utils/officeTypes.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

import { JWT_SECRET } from "../../config/index.js";

import jwt from "jsonwebtoken";
import { provinceScopeWhere, resolveDataScope, sendScopeError } from '../../utils/dataScope.js';
// Utility function to convert BigInt values to strings
function jsonifyBigInt(obj) {
  return JSON.parse(
    JSON.stringify(obj, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

// Utility function to generate the next curia_code
async function generateCuriaCode() {
  const lastRecord = await prisma.curia_advisors_dtl.findFirst({
    orderBy: {
      curia_code: 'desc',
    },
    select: {
      curia_code: true,
    },
  });

  if (lastRecord && lastRecord.curia_code) {
    const lastCodeNumber = parseInt(lastRecord.curia_code.slice(3), 10);
    const nextCodeNumber = lastCodeNumber + 1;
    return `CUR${String(nextCodeNumber).padStart(3, '0')}`;
  } else {
    return 'CUR001';
  }
}

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

//import { prisma } from '../prismaClient'; // Adjust the import path as needed
//import { generateCuriaCode, jsonifyBigInt } from '../utils'; // Assuming you have these utility functions

export async function saveCuriaAdvisorDetails(req, res) {
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
      return res.status(error.status || 500).json({ error: "Failed to verify token" });
    }

    const provinceNameFromToken = decoded.province_name;
    const createdBy = decoded.role_name || decoded.username || 'Unknown';


    const data = req.body;
    await validateOfficeSelections(prisma, data);

    // Debug: Log input data
    console.log('Input Data:', data);

    const requiredFields = [
      { field: "division_code", name: "Division Name" },
      { field: "division_type_code", name: "Division Type Code" },
      { field: "confrer_code", name: "Confrere Code" },
      { field: "designation_code", name: "Designation Code" },
      { field: "appointment_date", name: "Date of Appointment" },
      { field: "installation_date", name: "Date of Installation" },
      { field: "mandate_code", name: "Mandate Type" },
      { field: "mandate_end_date", name: "Mandate End Date" },
      { field: "personal1_contact_no", name: "Personal Contact Number" },
      { field: "personal1_isd", name: "Personal ISD" },
      { field: "office_mailid1", name: "Office Email ID" },
      { field: "office1_contact_no", name: "Office Contact Number" },
      { field: "office1_isd", name: "Office ISD" },
    ];

    const missingFields = requiredFields
      .filter(({ field }) => !data[field] || (typeof data[field] === 'string' && data[field].trim() === ''))
      .map(({ name }) => name);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const province = await resolveAuthorizedProvince({ prisma, user: decoded, requestedProvince: data.province_code });
    const province_code = province.province_code; // Use this in saveData

    // Validate confrer_code and check if it belongs to the province
    const confrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code: data.confrer_code,
        province_code, // Ensure confrer_code belongs to the correct province
      },
    });
    if (!confrere) {
      return res.status(404).json({ error: `Confrer code '${data.confrer_code}' not found in province '${provinceNameFromToken}'.` });
    }
    // Prevent duplicate save for same confrer_code
const existingAdvisor = await prisma.curia_advisors_dtl.findFirst({
  where: {
    confrer_code: data.confrer_code,
    province_code,
  },
});

if (existingAdvisor) {
  return res.status(400).json({
    error: `Confrere  is already added as Curia Advisor.`,
  });
}


    // Validate division_code from division_setup_mst table
    const division = await prisma.division_setup_mst.findFirst({
      where: {
        division_code: data.division_code,
        division_type_code: data.division_type_code,
        province_code,
      },
    });
    if (!division) {
      return res.status(404).json({ error: `Division code ${data.division_code} not found.` });
    }

    // Validate division_type_code from quickcode_mst table
    const divisionType = await prisma.quickcode_mst.findUnique({
      where: {
        quick_code_type_quick_code: {
          quick_code_type: 'divtyp',
          quick_code: data.division_type_code,
        },
      },
    });
    if (!divisionType) {
      return res.status(400).json({ error: `Invalid division_type_code: ${data.division_type_code}.` });
    }



    // Validate mandate_code from quickcode_mst table
    const mandateCode = await prisma.quickcode_mst.findUnique({
      where: {
        quick_code_type_quick_code: {
          quick_code_type: 'mandat',
          quick_code: data.mandate_code,
        },
      },
    });
    if (!mandateCode) {
      return res.status(400).json({ error: `Invalid mandate_code: ${data.mandate_code}.` });
    }

    // Validate designation_code from quickcode_mst table
    const designationCode = await prisma.quickcode_mst.findUnique({
      where: {
        quick_code_type_quick_code: {
          quick_code_type: 'destyp',
          quick_code: data.designation_code,
        },
      },
    });
    if (!designationCode) {
      return res.status(400).json({ error: `Invalid designation_code: ${data.designation_code}.` });
    }

    // Validate `personal_mailid1` is not null or empty


    // Generate the curia_code
    const curia_code = await generateCuriaCode();

    // Prepare the data for saving
    const saveData = {
      ...data,
      confrer_code: data.confrer_code,
      province_code, // Derived from token
      division_type_code: data.division_type_code,
      division_code: data.division_code,
      designation_code: data.designation_code,
      pcic_off_code: data.pcic_off_code === undefined ? undefined : (data.pcic_off_code || null),
      gcic_off_code: data.gcic_off_code === undefined ? undefined : (data.gcic_off_code || null),
      curia_code,
      appointment_date: new Date(data.appointment_date),
      mandate_code: data.mandate_code,
      installation_date: new Date(data.installation_date),
      mandate_end_date: new Date(data.mandate_end_date),
      personal1_isd: data.personal1_isd || '',
      personal1_contact_no: data.personal1_contact_no ? BigInt(data.personal1_contact_no) : null,
      watsup1_isd: data.watsup1_isd || '',
      watsup1_no: data.watsup1_no ? BigInt(data.watsup1_no) : null,
      personal_mailid1: data.personal_mailid1 || '',
      office1_isd: data.office1_isd || '',
      office1_contact_no: data.office1_contact_no ? BigInt(data.office1_contact_no) : null,
      office2_isd: data.office2_isd || '',
      office2_contact_no: data.office2_contact_no ? BigInt(data.office2_contact_no) : null,
      office_mailid1: data.office_mailid1,
      language_code: 'en',
      concurrency_val: 1,
      created_by: createdBy,
      created_date: new Date(),
      updated_by: null,
      updated_date: null,
    };

    // Save the record
    const savedRecord = await prisma.curia_advisors_dtl.create({
      data: saveData,
    });

    // Convert BigInt values to strings before sending the response
    const jsonResponse = jsonifyBigInt(savedRecord);
    jsonResponse.member_access=await provisionCreatedMember(prisma,'Curia',savedRecord,res.locals.user?.user_id || 'administrator');

    return res.status(201).json(jsonResponse);
  } catch (error) {
    console.error('Error saving curia advisor details:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'An error occurred while saving curia advisor details.' });
  } finally {
    await prisma.$disconnect();
  }
}





// Helper function to convert BigInt values to strings

export async function getCuriaAdvisorDetails(req, res) {
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code || null);

    const categories = await officeCategories(prisma);
    // Fetch all curia_advisors_dtl records filtered by province_code
    const curiaAdvisors = await prisma.curia_advisors_dtl.findMany({
      where: provinceScopeWhere(provinceCodes),
    });

    // Iterate over each record and fetch related data from other tables
    const detailedCuriaAdvisors = await Promise.all(
      curiaAdvisors.map(async (advisor) => {
        // Fetch confreres details using both confrer_code and province_code
        const confrere = await prisma.confreres_dtl.findUnique({
          where: {
            confrer_code_province_code: {
              confrer_code: advisor.confrer_code, // Use the confrer_code from the advisor
              province_code: advisor.province_code, // Ensure the province_code matches
            },
          },
          select: {
            first_name: true,
            middle_name: true,
            last_name: true,
          },
        });

        // Fetch province details (this can be redundant, as provinceCode is already used)
        const province = await prisma.province_mst.findUnique({
          where: { province_code: advisor.province_code },
          select: { province_name: true },
        });

        // Fetch division setup details using province_code, division_type_code, and division_code
        const division = await prisma.division_setup_mst.findUnique({
          where: {
            province_code_division_type_code_division_code: {
              province_code: advisor.province_code, // Add province_code
              division_type_code: advisor.division_type_code, // Add division_type_code
              division_code: advisor.division_code, // Add division_code
            },
          },
          select: { division_name: true },
        });

        // Fetch quickcode details for division type, designation, pcic office, and mandate
        const divisionType = await prisma.quickcode_mst.findFirst({
          where: { quick_code: advisor.division_type_code, quick_code_type: 'divtyp' },
          select: { quickcode_name: true },
        });

        const designation = await prisma.quickcode_mst.findFirst({
          where: { quick_code: advisor.designation_code, quick_code_type: 'destyp' },
          select: { quickcode_name: true },
        });

        const pcicOffice = advisor.pcic_off_code ? await prisma.quickcode_mst.findFirst({
          where: { quick_code: advisor.pcic_off_code, quick_code_type: categories.pcic },
          select: { quickcode_name: true },
        }) : null;

        const gcicOffice = advisor.gcic_off_code ? await prisma.quickcode_mst.findFirst({ where: { quick_code: advisor.gcic_off_code, quick_code_type: categories.gcic } }) : null;
        const mandate = await prisma.quickcode_mst.findFirst({
          where: { quick_code: advisor.mandate_code, quick_code_type: 'mandat' },
          select: { quickcode_name: true },
        });

        // Construct the final result with fetched related data
        const result = {
          ...advisor,
          confrer_name: `${confrere?.first_name} ${confrere?.middle_name || ''} ${confrere?.last_name}`,
          province_name: province?.province_name,
          division_name: division?.division_name,
          division_type_name: divisionType?.quickcode_name,
          designation_name: designation?.quickcode_name,
          pcic_off_name: pcicOffice?.quickcode_name,
          gcic_off_name: gcicOffice?.quickcode_name || null,
          mandate_name: mandate?.quickcode_name,
        };

        // Convert BigInt values to strings
        return jsonifyBigInt(result);
      })
    );

    return res.status(200).json(detailedCuriaAdvisors);
  } catch (error) {
    console.error('Error fetching curia advisor details:', error);
    return sendScopeError(res, error, 'An error occurred while fetching curia advisor details.');
  }
}








export async function getCuriaAdvisorByCode(req, res) {
  try {
    const { curia_code } = req.params;

    // Fetch the record with the given curia_code
    const curiaAdvisor = req.curiaRecord;

    // If the record is not found, return a 404 error
    if (!curiaAdvisor) {
      return res.status(404).json({ error: `Curia advisor with curia_code ${curia_code} not found.` });
    }

    // Convert BigInt values to strings before sending the response
    const jsonResponse = jsonifyBigInt(curiaAdvisor);

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Error fetching curia advisor details by curia_code:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'An error occurred while fetching curia advisor details.' });
  } finally {
    await prisma.$disconnect();
  }
}

export async function deleteCuriaAdvisorDetails(req, res) {
  try {
    // Get the curia_code parameter and trim any whitespace
    let { curia_code } = req.params;
    curia_code = curia_code.trim();


    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Access token has expired" });
      }
      return res.status(401).json({ error: "Invalid token" });
    }

    console.log("Authenticated user:", decoded);

    // Validate that curia_code is provided
    if (!curia_code) {
      return res.status(400).json({ error: 'curia_code is required.' });
    }

    // Find the record by curia_code
    const existingRecord = req.curiaRecord;

    if (!existingRecord) {
      return res.status(404).json({ error: `Curia advisor with curia_code ${curia_code} not found.` });
    }

    // Get associated confrer_code from the existing record
    const { confrer_code: associatedConfrerCode } = existingRecord;

    // Validate if confrer_code exists
    if (associatedConfrerCode) {
      // Check if confrer_code is used in other tables
      const tablesToCheck = [
        
        'confreres_feedback_dtl',
        'appoint_transfer_dtl',
      ];

      for (const table of tablesToCheck) {
        const isConfrereInUse = await prisma[table].findFirst({
          where: { confrer_code: associatedConfrerCode },
        });
        if (isConfrereInUse) {
          return res.status(400).json({
            message: `Curia advisor cannot be deleted as its associated confrer_code is being used in the table: ${table}.`,
          });
        }
      }

      // Additional tables to check for confrer_scholastic_code usage
      const tablesToCheckForConfrerScholastic = [
        'departures_dtl',
        'anniversary_notify_dtl',
        'obituary_dtl',
      ];

      for (const table of tablesToCheckForConfrerScholastic) {
        const isCountryscholasticInUse = await prisma[table].findFirst({
          where: { confrer_scholastic_code: associatedConfrerCode },
        });
        if (isCountryscholasticInUse) {
          return res.status(400).json({
            message: `Curia advisor cannot be deleted as its associated confrer_code is being used in the table: ${table}.`,
          });
        }
      }
    }

    // If all checks pass, delete the record from the database
    await prisma.curia_advisors_dtl.deleteMany({
      where: { curia_code: existingRecord.curia_code, confrer_code: existingRecord.confrer_code, province_code: existingRecord.province_code, division_type_code: existingRecord.division_type_code, division_code: existingRecord.division_code },
    });

    return res.status(200).json({ message: `Curia advisor with curia_code has been deleted successfully.` });
  } catch (error) {
    console.error('Error deleting curia advisor details:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'An error occurred while deleting curia advisor details.' });
  } finally {
    await prisma.$disconnect();
  }
}






// export const getConfreresWithDetails = async (req, res) => {
//   try {
//     const confreres = await prisma.confreres_dtl.findMany();

//     const responseResult = await Promise.all(
//       confreres.map(asynic (confrere) => {
//         // Fetch the member type name from quickcode_mst
//         const memberType = await prisma.quickcode_mst.findFirst({
//           where: {
//             quick_code: confrere.member_type_code,
//             quick_code_type: 'memtyp',
//           },
//           select: {
//             quickcode_name: true,
//           },
//         });

//         // Build the full name
//         const fullName = `${confrere.first_name || ''} ${confrere.middle_name || ''} ${confrere.last_name || ''}`.trim();

//         // Confrere name with member type
//         const confrereNameWithMemberType = memberType
//           ? `${fullName} [${memberType.quickcode_name}]`
//           : fullName;

//         return {
//           confrer_code: confrere.confrer_code,
//           province_code: confrere.province_code,
//           confrere_name: confrereNameWithMemberType,
//           image_file_name: confrere.image_file_name,
//           image_file_path: confrere.image_file_path,
//           birth_date: confrere.birth_date,
//           baptism_date: confrere.baptism_date,
//           confirmation_date: confrere.confirmation_date,
//           first_profession_date: confrere.first_profession_date,
//           final_profession_date: confrere.final_profession_date,
//           ordination_date: confrere.ordination_date,
//           personal1_isd: confrere.personal1_isd,
//           personal1_contact_no: confrere.personal1_contact_no ? confrere.personal1_contact_no.toString() : null,
//           watsup1_isd: confrere.watsup1_isd,
//           watsup1_no: confrere.watsup1_no ? confrere.watsup1_no.toString() : null,
//           personal_mailid1: confrere.personal_mailid1,
//           office1_isd: confrere.office1_isd || '',
//           office1_contact_no: confrere.office1_contact_no ? BigInt(confrere.office1_contact_no) : null,
//           office2_isd: confrere.office2_isd || '',
//           office2_contact_no: confrere.office2_contact_no ? BigInt(confrere.office2_contact_no) : null,
//           office_mailid1: confrere.office_mailid1,
//           language_code: confrere.language_code,
//           concurrency_val: confrere.concurrency_val,
//           created_by: confrere.created_by,
//           created_date: confrere.created_date,
//           updated_by: confrere.updated_by,
//           updated_date: confrere.updated_date,
//         };
//       })
//     );

//     res.status(200).json(responseResult);
//   } catch (error) {
//     console.error('Error fetching confreres with details:', error);
//     res.status(500).json({ error: error.status ? error.message : 'An error occurred while fetching confreres with details' });
//   } finally {
//     // Disconnect from the database
//     await prisma.$disconnect();
//   }
// };



export const getConfreresWithDetails = async (req, res) => {
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code);
    const confreres = await prisma.confreres_dtl.findMany({ where: provinceScopeWhere(provinceCodes) });

    const responseResult = await Promise.all(
      confreres.map(async (confrere) => {
        // Fetch the member type name from quickcode_mst
        const memberType = confrere.member_type_code ? await prisma.quickcode_mst.findFirst({
          where: {
            quick_code: confrere.member_type_code,
            quick_code_type: 'memtyp',
          },
          select: {
            quickcode_name: true,
          },
        }) : null;

        // Build the full name
        const fullName = `${confrere.first_name || ''} ${confrere.middle_name || ''} ${confrere.last_name || ''}`.trim();

        // Confrere name with member type
        const confrereNameWithMemberType = memberType
          ? `${fullName} [${memberType.quickcode_name}]`
          : fullName;

        return {
          confrer_code: confrere.confrer_code,
          province_code: confrere.province_code,
          confrere_name: confrereNameWithMemberType,
          image_file_name: confrere.image_file_name,
          image_file_path: confrere.image_file_path,
          birth_date: confrere.birth_date,
          baptism_date: confrere.baptism_date,
          confirmation_date: confrere.confirmation_date,
          first_profession_date: confrere.first_profession_date,
          final_profession_date: confrere.final_profession_date,
          ordination_date: confrere.ordination_date,
          personal1_isd: confrere.personal1_isd,
          personal1_contact_no: confrere.personal1_contact_no ? confrere.personal1_contact_no.toString() : null,
          watsup1_isd: confrere.watsup1_isd,
          watsup1_no: confrere.watsup1_no ? confrere.watsup1_no.toString() : null,
          personal_mailid1: confrere.personal_mailid1,
          office1_isd: confrere.office1_isd || '',
          office1_contact_no: confrere.office1_contact_no ? confrere.office1_contact_no.toString() : null,
          office2_isd: confrere.office2_isd || '',
          office2_contact_no: confrere.office2_contact_no ? confrere.office2_contact_no.toString() : null,
          office_mailid1: confrere.office_mailid1,
          language_code: confrere.language_code,
          concurrency_val: confrere.concurrency_val,
          created_by: confrere.created_by,
          created_date: confrere.created_date,
          updated_by: confrere.updated_by,
          updated_date: confrere.updated_date,
        };
      })
    );

    res.status(200).json(responseResult);
  } catch (error) {
    console.error('Error fetching confreres with details:', error);
    return sendScopeError(res, error, 'An error occurred while fetching confreres with details');
  }
};


export async function updateCuriaAdvisorDetails(req, res) {
  try {
    const data = req.body;
    await validateOfficeSelections(prisma, data);
    const { curia_code } = req.params;

    // Debug: Log input data
    console.log('Input Data:', data);

    // Check if curia_code is provided
    if (!curia_code) {
      return res.status(400).json({ error: 'curia_code is required for updating.' });
    }

    // Ensure necessary fields are present to find the record
    if (!data.confrer_code) {
      return res.status(400).json({
        error: 'confrer_code  required for updating the curia details.',
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Access token has expired" });
      }
      return res.status(401).json({ error: "Invalid token" });
    }

    console.log("Authenticated user:", decoded);

    const requiredFields = [
      
      { field: "division_code", name: "Division Name" },
      { field: "division_type_code", name: "Division Type Code" },
      { field: "confrer_code", name: "Confrere Code" },
      { field: "designation_code", name: "Designation Code" },
      { field: "appointment_date", name: "Date of Appointment" },
      { field: "installation_date", name: "Date of Installation" },
      { field: "mandate_code", name: "Mandate Type" },
      { field: "mandate_end_date", name: "Mandate End Date" },
      // { field: "personal_mailid1", name: "Personal Email ID" },
      // { field: "personal1_contact_no", name: "Personal Contact Number" },
      // { field: "personal1_isd", name: "Personal ISD" },
      { field: "office_mailid1", name: "Office Email ID" },
      { field: "office1_contact_no", name: "Office Contact Number" },
      { field: "office1_isd", name: "Office ISD" },
    ];

    const missingFields = requiredFields
      .filter(({ field }) => !data[field] || (typeof data[field] === 'string' && data[field].trim() === ''))
      .map(({ name }) => name);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    // Find the record without division_type_code and division_code
    const existingRecord = req.curiaRecord;

    if (!existingRecord) {
      return res.status(404).json({ error: `No record found with curia_code ${curia_code}.` });
    }

    const division = await prisma.division_setup_mst.findFirst({ where: { province_code: existingRecord.province_code, division_type_code: data.division_type_code, division_code: data.division_code } });
    if (!division) return res.status(400).json({ error: 'Division does not belong to this Curia province.' });
    // Prepare the data for updating, allowing updates to division_type_code and division_code
    const updateData = {
      division_type_code: data.division_type_code, // These fields will be updated
      division_code: data.division_code, // These fields will be updated
      designation_code: data.designation_code,
      pcic_off_code: data.pcic_off_code === undefined ? undefined : (data.pcic_off_code || null),
      gcic_off_code: data.gcic_off_code === undefined ? undefined : (data.gcic_off_code || null),
      appointment_date: new Date(data.appointment_date),
      mandate_code: data.mandate_code,
      installation_date: new Date(data.installation_date),
      mandate_end_date: new Date(data.mandate_end_date),

      personal1_isd:existingRecord.personal1_isd,
      personal1_contact_no: existingRecord.personal1_contact_no,
      watsup1_isd:  existingRecord.watsup1_isd,
      watsup1_no: existingRecord.watsup1_no,
      personal_mailid1:existingRecord.personal_mailid1,
      office1_isd: data.office1_isd || '',
      office1_contact_no: data.office1_contact_no ? BigInt(data.office1_contact_no) : null,
      office2_isd: data.office2_isd || '',
      office2_contact_no: data.office2_contact_no ? BigInt(data.office2_contact_no) : null,
      office_mailid1: data.office_mailid1,
      language_code: 'en',
      concurrency_val: 1,
      updated_by: 'admin',
      updated_date: new Date(),
    };

    // Update the record
    const updatedRecord = await prisma.curia_advisors_dtl.update({
      where: { // Use the primary key fields to update the record
        curia_code_confrer_code_province_code_division_type_code_division_code: {
          curia_code: existingRecord.curia_code,
          confrer_code: existingRecord.confrer_code,
          province_code: existingRecord.province_code,
          division_type_code: existingRecord.division_type_code,
          division_code: existingRecord.division_code,
        },
      },
      data: updateData,
    });

    // Convert BigInt values to strings before sending the response
    const jsonResponse = jsonifyBigInt(updatedRecord);

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Error updating curia advisor details:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'An error occurred while updating curia advisor details.' });
  } finally {
    await prisma.$disconnect();
  }
}











export async function getCuriaAdvisor(req, res) {
  try {
    const { curia_code } = req.params;

    // Fetch the curia advisor details using the curia_code
    const curiaAdvisor = req.curiaRecord;

    // If the curia advisor is not found, return a 404 error
    if (!curiaAdvisor) {
      return res.status(404).json({ error: `Curia advisor with curia_code ${curia_code} not found.` });
    }

    // Fetch additional details as needed
    const province = await prisma.province_mst.findFirst({
      where: {
        province_code: curiaAdvisor.province_code,
      },
      select: {
        province_name: true,
      },
    });



    const divisionTypeQuickcode = await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: curiaAdvisor.division_type_code || '',
        quick_code_type: 'divtyp',
      },
      select: {
        quickcode_name: true,
      },
    });



    const designationQuickcode = await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: curiaAdvisor.designation_code || '',
        quick_code_type: 'destyp',
      },
      select: {
        quickcode_name: true,
      },
    });



    const division = await prisma.division_setup_mst.findFirst({
      where: {
        province_code: curiaAdvisor.province_code,
        division_type_code: curiaAdvisor.division_type_code,
        division_code: curiaAdvisor.division_code,
      },
      select: {
        division_name: true,
      },
    });



    const confrere = await prisma.confreres_dtl.findFirst({
      where: {
        confrer_code: curiaAdvisor.confrer_code,
      },
      select: {
        first_name: true,
        last_name: true,
        middle_name: true, confrer_code: true, personal1_isd: true, personal1_contact_no: true,
      },
    });

    const confrere_name = confrere 
      ? `${confrere.first_name} ${confrere.middle_name ? confrere.middle_name + ' ' : ''}${confrere.last_name}` 
      : null;

    const categories = await officeCategories(prisma);
    const gcicQuickcode = curiaAdvisor.gcic_off_code ? await prisma.quickcode_mst.findFirst({ where: { quick_code_type: categories.gcic, quick_code: curiaAdvisor.gcic_off_code } }) : null;
    const pcicQuickcode = curiaAdvisor.pcic_off_code ? await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: curiaAdvisor.pcic_off_code,
        quick_code_type: categories.pcic,
      },
      select: {
        quickcode_name: true,
      },
    }) : null;



    const mandateQuickcode = await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: curiaAdvisor.mandate_code || '',
        quick_code_type: 'mandat',
      },
      select: {
        quickcode_name: true,
      },
    });



    // Use the Curia record designation, matching the dashboard office popup.
    const personDetails = await officePersonDetails(prisma, confrere);

    // Combine the curia advisor details with additional data
    const jsonResponse = {
      ...jsonifyBigInt(curiaAdvisor),
      ...personDetails,
      current_designations: designationQuickcode?.quickcode_name || personDetails.current_designations,
      province_name: province?.province_name || curiaAdvisor.province_code,
      division_type_name: divisionTypeQuickcode?.quickcode_name || curiaAdvisor.division_type_code,
      designation_name: designationQuickcode?.quickcode_name || curiaAdvisor.designation_code,
      division_name: division?.division_name || curiaAdvisor.division_code,
      confrere_name: confrere_name,
      pcic_name: pcicQuickcode?.quickcode_name || null,
      gcic_name: gcicQuickcode?.quickcode_name || null,
      mandate_name: mandateQuickcode?.quickcode_name || curiaAdvisor.mandate_code,
      personal1_contact_no: `${curiaAdvisor.personal1_isd} ${curiaAdvisor.personal1_contact_no || ''}`,
      watsup1_no : `${curiaAdvisor.watsup1_isd} ${curiaAdvisor.watsup1_no || ''}`,
      office1_contact_no: `${curiaAdvisor.office1_isd} ${curiaAdvisor.office1_contact_no || ''}`,
      office2_contact_no: `${curiaAdvisor.office2_isd} ${curiaAdvisor.office2_contact_no || ''}`,
    };

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Error fetching curia advisor details by curia_code:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'An error occurred while fetching curia advisor details.' });
  } finally {
    await prisma.$disconnect();
  }
}


export async function getAllCuriaAdvisorsForExport(req, res) {
  try {
    // Validate and decode JWT
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
      return res.status(error.status || 500).json({ error: "Failed to verify token" });
    }

    const provinceName = decoded.province_name;

    // Fetch province_code based on province_name
    const province = await prisma.province_mst.findFirst({
      where: { province_name: provinceName },
      select: { province_code: true },
    });

    if (!province) {
      return res.status(404).json({ error: "Province not found for the logged-in user" });
    }

    const provinceCode = province.province_code;

    // Fetch all curia advisors filtered by province_code
    const curiaAdvisors = await prisma.curia_advisors_dtl.findMany({
      where: {
        province_code: provinceCode,
      },
    });

    // Fetch related data for mapping
    const [divisions, quickCodes] = await Promise.all([
      prisma.division_setup_mst.findMany({
        select: {
          division_code: true,
          division_name: true,
          division_type_code: true,
          province_code: true,
        },
      }),
      prisma.quickcode_mst.findMany({
        where: {
          quick_code_type: { in: ["divtyp", "destyp", "pcicof", "mandat"] },
        },
        select: {
          quick_code: true,
          quick_code_type: true,
          quickcode_name: true,
        },
      }),
    ]);

    const divisionMap = new Map(
      divisions.map((d) => [
        `${d.province_code}_${d.division_type_code}_${d.division_code}`,
        d.division_name,
      ])
    );

    const quickCodeMap = new Map(
      quickCodes.map((qc) => [`${qc.quick_code_type}_${qc.quick_code}`, qc.quickcode_name])
    );

    // Transform data to include human-readable names
    const detailedCuriaAdvisors = await Promise.all(
      curiaAdvisors.map(async (advisor) => {
        const confrere = await prisma.confreres_dtl.findUnique({
          where: {
            confrer_code_province_code: {
              confrer_code: advisor.confrer_code,
              province_code: advisor.province_code,
            },
          },
          select: {
            first_name: true,
            middle_name: true,
            last_name: true,
          },
        });

        return {
          ...advisor,
          confrere_name: `${confrere?.first_name} ${confrere?.middle_name || ""} ${confrere?.last_name}`.trim(),
          division_name: divisionMap.get(
            `${advisor.province_code}_${advisor.division_type_code}_${advisor.division_code}`
          ) || null,
          division_type_name: quickCodeMap.get(`divtyp_${advisor.division_type_code}`) || null,
          designation_name: quickCodeMap.get(`destyp_${advisor.designation_code}`) || null,
          pcic_off_name: quickCodeMap.get(`pcicof_${advisor.pcic_off_code}`) || null,
          mandate_name: quickCodeMap.get(`mandat_${advisor.mandate_code}`) || null,
          // Convert BigInt fields to string
          personal1_contact_no: advisor.personal1_contact_no?.toString() || null,
          watsup1_no: advisor.watsup1_no?.toString() || null,
          office1_contact_no: advisor.office1_contact_no?.toString() || null,
        };
      })
    );

    function convertBigIntToString(obj) {
      if (Array.isArray(obj)) {
        return obj.map(convertBigIntToString);
      } else if (obj !== null && typeof obj === 'object') {
        const converted = {};
        for (const key in obj) {
          const value = obj[key];
          converted[key] = typeof value === 'bigint'
            ? value.toString()
            : convertBigIntToString(value);
        }
        return converted;
      }
      return obj;
    }
   
res.status(200).json(convertBigIntToString(detailedCuriaAdvisors));
  } catch (error) {
    console.error("Error fetching curia advisors:", error);
    res.status(500).json({ error: "An error occurred while fetching curia advisor details." });
  } finally {
    await prisma.$disconnect();
  }
}

