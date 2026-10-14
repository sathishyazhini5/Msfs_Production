import {provinceMutationAllowed} from '../../utils/tenantHierarchy.js';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { sendEmail } from '../../middlewares/emailService.js';
import { StatusCodes } from 'http-status-codes';
import { JWT_SECRET } from "../../config/index.js";
import jwt from "jsonwebtoken";
const prisma = new PrismaClient();

const generateNextProvinceCode = async () => {
  const maxCodeResult = await prisma.province_mst.findMany({
    where: {
      NOT: { province_code: 'ALL' }, // Exclude the 'ALL' static code
    },
    orderBy: { province_code: 'desc' },
    take: 1,
    select: { province_code: true },
  });

  let nextCode = "PR001"; // Default starting code
  if (maxCodeResult.length > 0) {
    const maxCode = maxCodeResult[0].province_code;
    const numericPart = parseInt(maxCode.substring(2), 10);
    const nextNumericPart = numericPart + 1;
    nextCode = `PR${nextNumericPart.toString().padStart(3, "0")}`;
  }
  return nextCode;
};


const generateNextQuickCode = async () => {
  const maxQuickCodeResult = await prisma.quickcode_mst.findMany({
    where: { quick_code_type: "rolnam" },
    orderBy: { quick_code: "desc" },
    take: 1,
    select: { quick_code: true },
  });

  let nextQuickCode = "RN001";
  if (maxQuickCodeResult.length > 0) {
    const maxCode = maxQuickCodeResult[0].quick_code;
    const numericPart = parseInt(maxCode.substring(2), 10);
    const nextNumericPart = numericPart + 1;
    nextQuickCode = `RN${nextNumericPart.toString().padStart(3, "0")}`;
  }
  return nextQuickCode;
};

export const createProvince = async (req, res, next) => {

  const { provinceName, shortName, email,concretionName, languageCode = 'en' } = req.body;

  console.log('Request body:', req.body);

 
  try {
    if(!await provinceMutationAllowed(req,res,prisma))return;

    const existingProvinceByName = await prisma.province_mst.findFirst({
      where: {
        province_name: provinceName,
      },
    });

    if (existingProvinceByName) {
      console.log('Validation Error: Province name already exists');
      return res.status(400).json({ error: 'Province name is already in use. Please choose a different name.' });
    }

    const concretion = await prisma.concretion_defination_mst.findFirst({
      where: {
        ...(concretionName?{concretion_name:concretionName}:{}),
        concretion_code: req.body.concretion_code  
      },
      select: { concretion_code: true },
    });
    
    if (!concretion) {
      return res.status(404).json({ error: 'Concretion not found for the given name' });
    }
    
    const concretionCode = concretion.concretion_code;
    


    const existingUser = await prisma.users_mst.findFirst({
      where: { user_id: email },
    });

    if (existingUser) {
      console.log('Validation Error: Email already exists');
      return res.status(400).json({ error: 'Email is already in use' });
    }
    const currentUserRole = res.locals.user?.role_name || 'Unknown';
    const provinceCode = await generateNextProvinceCode();
    const defaultPassword = 'pass123';

    const newProvince = await prisma.province_mst.create({
      data: {
        province_code: provinceCode,
        province_name: provinceName,
        concretion_code: req.body.concretion_code,
        short_name: shortName,
        email: email,
        language_code: languageCode,
        concurrency_val: 1,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    const quickCode = await generateNextQuickCode();

    await prisma.quickcode_mst.create({
      data: {
        quick_code_type: 'rolnam',
        quick_code: quickCode,
        quickcode_name: 'Province Admin',
        language_code: languageCode,
        concurrency_val: 1,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const user = await prisma.users_mst.create({
      data: {
        user_type_code: quickCode,
        prov_concre_code: provinceCode,
        user_id: email,
        first_name: email.split('@')[0], // Extract first name from email
        last_name: null,
        password: hashedPassword,
        role_code: quickCode,
        role_name: 'Province Admin',
        language_code: languageCode,
        concurrency_val: 1,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    // Log role_name and first_name in the terminal
    console.log(`User created with role_name: '${user.role_name}' and first_name: '${user.first_name}'`);

    const emailSubject = 'Your Admin Account Details';
    const emailBody = `Hello,\n\nYour admin account has been created.\n\nUsername: ${email}\nPassword: ${defaultPassword}\nPlease change your password upon first login.`;

    await sendEmail(email, emailSubject, emailBody);

    res.status(201).json(newProvince);
  } catch (error) {
    console.error('Error saving province:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};


export const updateProvince = async (req, res) => {

const { province_code } = req.params;
const { province_name, short_name, email,concretionName, languageCode = 'en' } = req.body;

console.log(`Updating province with code: ${province_code}`);
console.log('Request body:', req.body);



try {
    if(!await provinceMutationAllowed(req,res,prisma))return;
  // Get current user role from authentication middleware
  const updatedBy = res.locals.user?.role_name || 'Unknown';
  
  // Retrieve existing province and user records
  const existingProvince = await prisma.province_mst.findUnique({ where: { province_code } });
  const existingUser = await prisma.users_mst.findFirst({ where: { prov_concre_code: province_code } });

  if (!existingProvince) {
    return res.status(404).json({ error: 'Province not found' });
  }

  const concretion = await prisma.concretion_defination_mst.findFirst({
    where: {
      concretion_name: concretionName,
      concretion_code: req.body.concretion_code  
    },
    select: { concretion_code: true },
  });
  
  if (!concretion) {
    return res.status(404).json({ error: 'Concretion not found for the given name' });
  }
  
  const concretionCode = concretion.concretion_code;
  // Update province details in province_mst
  const updatedProvince = await prisma.province_mst.update({
    where: { province_code },
    data: {
      province_name,
      concretion_code: req.body.concretion_code,
      short_name,
      email,
      language_code: languageCode,
      updated_by: updatedBy,
      updated_date: new Date(),
    },
  });

  // Check if email changed and update users_mst if needed
  if (existingUser && existingUser.user_id !== email) {
    const defaultPassword = 'pass123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    await prisma.users_mst.update({
      where: {
        user_type_code_prov_concre_code_user_id: {
          user_type_code: existingUser.user_type_code,
          prov_concre_code: province_code,
          user_id: existingUser.user_id,
        },
      },
      data: {
        user_id: email,
        first_name: email.split('@')[0],
        password: hashedPassword,
        updated_by: updatedBy,
        updated_date: new Date(),
      },
    });

    // Send notification email to the new address
    const emailSubject = 'Your Updated Admin Account Details';
    const emailBody = `Hello,\n\nYour admin account has been updated.\n\nUsername: ${email}\nPassword: ${defaultPassword}\nPlease change your password upon first login.`;
    await sendEmail(email, emailSubject, emailBody);

    console.log(`User updated with role_name: '${existingUser.role_name}' and new email: '${email}'`);
  }

  res.status(StatusCodes.OK).json(updatedProvince);
} catch (error) {
  console.error('Error updating province:', error.message);
  console.error('Error details:', error); // Log full error for debugging
  res.status(500).json({ error: 'Internal server error' });
}
};




export const getProvincesdetails = async (req, res, next) => {
try {
// Fetch all provinces data from the database
const provinces = await prisma.province_mst.findMany({where: req.provinceManagementWhere || {}});

// Assuming you're using Prisma or any other ORM to fetch from the database
const formattedProvinces = await Promise.all(provinces.map(async (province) => {
  // Fetch the concretion_name based on the concretion_code
  let concretionName = 'N/A'; // Default value in case concretion_code is NULL or doesn't match
  if (province.concretion_code && province.concretion_code !== 'N/A') {
    const concretion = await prisma.concretion_defination_mst.findFirst({
      where: { concretion_code: province.concretion_code },
      select: { concretion_name: true }, // Select only the concretion_name field
    });

    // If concretion is found, use the retrieved concretion_name
    if (concretion) {
      concretionName = concretion.concretion_name;
    }
  }

  // Return the updated province object with concretion_name
  return {
    ...province,
    concretion_code: province.concretion_code || 'N/A', // Replace NULL with 'N/A'
    concretion_name: concretionName, // Add the retrieved concretion_name
  };
}));

console.log(formattedProvinces);


// Respond with the retrieved provinces
res.status(200).json(formattedProvinces);
} catch (error) {
console.error('Error fetching provinces:', error.message);
res.status(500).json({ error: 'Internal server error' });
}
};


export const getProvinces = async (req, res) => {
  try {
    // Fetch all provinces with all fields from the model
    const provinces = await prisma.province_mst.findMany();

    if (!provinces || provinces.length === 0) {
      console.error('No provinces found');
      return res.status(404).json({ error: 'No provinces found' });
    }

    // Return the province data directly
    res.status(200).json(provinces);
  } catch (error) {
    console.error('Error fetching provinces:', error.message); // Log the error message
    console.error('Error details:', error); // Log the full error details
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getConcretion = async (req, res) => {
  const { concretion_code } = req.params; // Extract the concretion_code from the path parameters
  const prisma = new PrismaClient();

  try {
    // Validate input
    if (!concretion_code) {
      return res.status(400).json({ error: 'Concretion code is required' });
    }

    // Fetch provinces matching the provided concretion_code
    const provinces = await prisma.province_mst.findMany({
      where: { concretion_code },
    });

    if (!provinces || provinces.length === 0) {
      console.error(`No provinces found for concretion_code: ${concretion_code}`);
      return res.status(404).json({ error: 'No provinces found for the provided concretion code' });
    }

    // Return the filtered province data
    res.status(200).json(provinces);
  } catch (error) {
    console.error('Error fetching provinces:', error.message); // Log the error message
    console.error('Error details:', error); // Log the full error details
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    await prisma.$disconnect(); // Ensure the Prisma client disconnects
  }
};




// export const deleteProvince = async (req, res) => {
//   const { province_code } = req.params;

//   // Validate the required field
//   if (!province_code) {
//     return res.status(400).json({ error: 'Province code is required' });
//   }

//   try {
//     // Check for dependencies in related tables
//     const relatedTables = [
//       { name: 'country_mst', column: 'province_code' },
//       { name: 'state_mst', column: 'province_code' },
//       { name: 'division_setup_mst', column: 'province_code' },
//       { name: 'quickcode_mst', column: 'province_code' },
//       { name: 'province_country_map_mst', column: 'province_code' },
//       { name: 'apostolates_mst', column: 'province_code' },
//       { name: 'users_mst', column: 'prov_concre_code' },
//       { name: 'headquarters_dtl', column: 'province_code' },
//       { name: 'confreres_dtl', column: 'province_code' },
//       { name: 'departures_dtl', column: 'province_code' },
//       { name: 'announcements_dtl', column: 'province_code' },
//       { name: 'event_dtl', column: 'province_code' },
//       { name: 'obituary_dtl', column: 'province_code' },
//     ];

//     for (const table of relatedTables) {
//       const dependency = await prisma[table.name].findFirst({
//         where: {
//           [table.column]: province_code,
//         },
//       });

//       if (dependency) {
//         return res.status(400).json({
//           error: `Province code "${province_code}" is already in use in ${table.name}.`,
//         });
//       }
//     }

//     const quickcodeEntries = await prisma.quickcode_mst.findMany({
//       where: {
//         province_code: province_code,
//       },
//     });

//     // Separate 'rolnam' and other quick_code_types
//     const rolnamEntries = quickcodeEntries.filter(entry => entry.quick_code_type === 'rolnam');
//     const otherEntries = quickcodeEntries.filter(entry => entry.quick_code_type !== 'rolnam');

//     // 🔴 If the province exists in quickcode_mst under other quick_code_types, prevent deletion
//     if (otherEntries.length > 0) {
//       return res.status(400).json({
//         error: `Province code "${province_code}" is in use in quickcode_mst under other quick_code_types: ${otherEntries.map(e => e.quick_code_type).join(', ')}`,
//       });
//     }

//     // ✅ If the province exists **only** in quickcode_mst under 'rolnam', proceed with deletion
//     if (rolnamEntries.length > 0) {
//       // Delete users first
//       const deletedUsers = await prisma.users_mst.deleteMany({
//         where: {
//           prov_concre_code: province_code,
//         },
//       });
//       console.log(`Deleted ${deletedUsers.count} users from users_mst associated with province_code: ${province_code}`);

//       // Delete 'rolnam' entries from quickcode_mst
//       await prisma.quickcode_mst.deleteMany({
//         where: {
//           province_code: province_code,
//           quick_code_type: 'rolnam',
//         },
//       });
//       console.log(`Deleted ${rolnamEntries.length} entries from quickcode_mst for quick_code_type "rolnam"`);

//       // Delete province
//       await prisma.province_mst.delete({
//         where: { province_code },
//       });

//       return res.status(200).json({
//         message: `Province deleted successfully. ${deletedUsers.count} related users and ${rolnamEntries.length} 'rolnam' quickcode entries also deleted.`,
//       });
//     }

//     // ❌ If province exists in `quickcode_mst` but does not match deletion conditions, block deletion
//     return res.status(400).json({
//       error: `Province code "${province_code}" exists in quickcode_mst but does not match deletion conditions.`,
//     });

//   } catch (error) {
//     console.error('Error deleting province:', error.message); // Log the error message
//     console.error('Error details:', error); // Log the full error details
//     res.status(500).json({ error: 'Internal server error' });
//   }
// };


export const deleteProvince = async (req, res) => {
  const { province_code } = req.params;

  // Validate required input
  if (!province_code) {
    return res.status(400).json({ error: "Province code is required." });
  }

  try {
    if(!await provinceMutationAllowed(req,res,prisma))return;
    // Step 1️⃣: Check for dependencies in related tables (excluding quickcode_mst)
    const relatedTables = [
      { name: "country_mst", column: "province_code" },
      { name: "state_mst", column: "province_code" },
      { name: "division_setup_mst", column: "province_code" },
      { name: "province_country_map_mst", column: "province_code" },
      { name: "apostolates_mst", column: "province_code" },
      { name: "headquarters_dtl", column: "province_code" },
      { name: "confreres_dtl", column: "province_code" },
      { name: "departures_dtl", column: "province_code" },
      { name: "announcements_dtl", column: "province_code" },
      { name: "event_dtl", column: "province_code" },
      { name: "obituary_dtl", column: "province_code" },
    ];

    for (const table of relatedTables) {
      const dependency = await prisma[table.name].findFirst({
        where: { [table.column]: province_code },
      });

      if (dependency) {
        return res.status(400).json({
          error: `❌ Province code "${province_code}" is already in use in table "${table.name}". Deletion blocked.`,
        });
      }
    }

    // Step 2️⃣: Check `quickcode_mst` for province_code usage
    const quickcodeEntries = await prisma.quickcode_mst.findMany({
      where: { province_code },
    });

    // Separate 'rolnam' and other quick_code_types
    const rolnamEntries = quickcodeEntries.filter(
      (entry) => entry.quick_code_type === "rolnam"
    );
    const otherEntries = quickcodeEntries.filter(
      (entry) => entry.quick_code_type !== "rolnam"
    );

    // 🚫 Block deletion if province exists in `quickcode_mst` under other quick_code_types
    if (otherEntries.length > 0) {
      return res.status(400).json({
        error: `❌ Province code "${province_code}" exists in quickcode_mst under other quick_code_types: ${otherEntries
          .map((e) => e.quick_code_type)
          .join(", ")}. Deletion blocked.`,
      });
    }

    // ✅ Step 3️⃣: Delete users, quickcode_mst (only 'rolnam'), and province
    if (rolnamEntries.length > 0) {
      // Delete related users first
      const deletedUsers = await prisma.users_mst.deleteMany({
        where: { prov_concre_code: province_code },
      });

      console.log(
        `✅ Deleted ${deletedUsers.count} users from users_mst for province_code: ${province_code}`
      );

      // Delete 'rolnam' entries from quickcode_mst
      const deletedQuickcodes = await prisma.quickcode_mst.deleteMany({
        where: { province_code, quick_code_type: "rolnam" },
      });

      console.log(
        `✅ Deleted ${deletedQuickcodes.count} entries from quickcode_mst for quick_code_type "rolnam"`
      );

      // Delete province
      await prisma.province_mst.delete({ where: { province_code } });

      return res.status(200).json({
        message: `✅ Province deleted successfully. ${deletedUsers.count} users and ${deletedQuickcodes.count} 'rolnam' quickcode entries also deleted.`,
      });
    }

    // ❌ If province exists in quickcode_mst but does not match deletion conditions, block deletion
    return res.status(400).json({
      error: `❌ Province code "${province_code}" exists in quickcode_mst but does not match deletion conditions.`,
    });
  } catch (error) {
    console.error("❌ Error deleting province:", error.message);
    console.error("Error details:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

export async function getConfrereDetails(req, res) {
const { province_code } = req.params;

try {
// Fetch the matching province from the province_mst table
const province = await prisma.province_mst.findFirst({
  where: { province_code },
});

// If province not found, return a 404 error
if (!province) {
  return res.status(404).json({ error: `Province code ${province_code} not found.` });
}

// Fetch confrere details from confreres_dtl table based on province_code
const confreres = await prisma.confreres_dtl.findMany({
  where: { province_code },
  select: {
    confrer_code: true,
    first_name: true,
    middle_name: true,
    last_name: true,
    member_type_code: true,
    personal_mailid1: true,
    image_file_name: true,
    image_file_path: true,
    birth_date: true,
    baptism_date: true,
    confirmation_date: true,
    first_profession_date: true,
    final_profession_date: true,
    ordination_date: true,
    personal1_isd: true,
    personal1_contact_no: true,
    personal2_isd: true,
    personal2_contact_no: true,
    personal3_isd: true,
    personal3_contact_no: true,
    watsup1_isd: true,
    watsup1_no: true,
    watsup2_isd: true,
    watsup2_no: true,
    watsup3_isd: true,
    watsup3_no: true,
    emergency_isd: true,
    emergency_contact_no: true,
    blood_group_code: true,
    nationality_code: true,
    language_code: true,
    created_by: true,
    created_date: true,
    updated_by: true,
    updated_date: true,
  },
});

// Convert BigInt fields to strings and format confrer_name
const formattedConfreres = await Promise.all(confreres.map(async (confrere) => {
  // Combine first, middle, and last names to form confrer_name
  const confrer_name = [confrere.first_name, confrere.middle_name, confrere.last_name]
    .filter(Boolean)
    .join(' ');

  // Fetch member type name from quickcode_mst table
  let memberType = null;

  // Fetch member type name only if member_type_code is valid
  if (confrere.member_type_code) {
    memberType = await prisma.quickcode_mst.findFirst({
      where: {
        quick_code_type: 'memtyp',
        quick_code: confrere.member_type_code,
      },
      select: { quickcode_name: true },
    });
  }
  // Format confrer_name with member_type_name in brackets if found
  const formattedName = memberType
    ? `${confrer_name} [${memberType.quickcode_name}]`
    : confrer_name;

  // Convert all BigInt fields to strings
  const convertedConfrere = convertBigIntToString({
    ...confrere,
    confrer_name: formattedName,
  });

  // Remove first_name, middle_name, last_name, and member_type_code from response
  delete convertedConfrere.first_name;
  delete convertedConfrere.middle_name;
  delete convertedConfrere.last_name;
  delete convertedConfrere.member_type_code;

  return convertedConfrere;
}));

// If no confrere found, return an empty array
if (formattedConfreres.length === 0) {
  return res.status(200).json({ message: 'No confrere found for the specified criteria.', confreres: [] });
}

// Return the list of confrere details
return res.status(200).json(formattedConfreres);
} catch (error) {
console.error('Error fetching confrere details:', error);
return res.status(500).json({ error: 'An error occurred while fetching confrere details.' });
} finally {
await prisma.$disconnect();
}
}

// Helper function to convert BigInt to strings
function convertBigIntToString(obj) {
return Object.fromEntries(
Object.entries(obj).map(([key, value]) =>
  typeof value === 'bigint' ? [key, value.toString()] : [key, value]
)
);
}

export const getAcademicYearByProvinceCode = async (req, res) => {
// Extracting the 'province_code' from the request parameters
const { province_code } = req.params;

try {
// Querying the database to find the academic year by 'province_code'
const provinceDetails = await prisma.province_country_map_mst.findFirst({
  where: {
    province_code: province_code,
  },
  select: {
    academic_year: true
  },
});

// Handling case when no province is found
if (!provinceDetails) {
  return res.status(404).json({ message: 'Province not found for the given code' });
}

// Successfully returning the academic year
return res.status(200).json({
  message: 'Academic year fetched successfully',
  data: {
    academic_year: provinceDetails.academic_year,
  },
});
} catch (error) {
console.error('Error fetching academic year:', error);
return res.status(500).json({
  message: 'Failed to retrieve academic year',
  error: error.message,
});
}
};


export const getProvinceByLogin = async (req, res, next) => {
try {
const authHeader = req.headers.authorization;

// Ensure token is provided
if (!authHeader || !authHeader.startsWith("Bearer ")) {
  return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Access token is missing or invalid" });
}

// Extract the token
const token = authHeader.split(" ")[1];

// Verify and decode token
let decoded;
try {
  decoded = jwt.verify(token, JWT_SECRET);
} catch (error) {
  if (error.name === "TokenExpiredError") {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Token has expired" });
  }
  if (error.name === "JsonWebTokenError") {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: "Invalid token" });
  }
  return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Failed to verify token" });
}

// Extract province_name from decoded token
const provinceName = decoded.province_name;

// Fetch province details from database
const province = await prisma.province_mst.findFirst({
  where: {
    province_name: provinceName,
  },
  select: {
    province_name: true,
    province_code: true,
  },
});

if (!province) {
  return res.status(StatusCodes.NOT_FOUND).json({ error: "Province not found" });
}

// Return province details
res.status(StatusCodes.OK).json(province);
} catch (error) {
console.error("Error fetching province:", error.message);
res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: "Internal server error" });
} finally {
await prisma.$disconnect();
}
};

