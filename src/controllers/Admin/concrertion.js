import { PrismaClient } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import bcrypt from 'bcrypt';
import jwt from "jsonwebtoken";
import { sendEmail } from '../../middlewares/emailService.js';
const prisma = new PrismaClient();

  

const generateNextConcretionCode = async () => {
  // Fetch the maximum existing concretion_code
  const maxCodeResult = await prisma.concretion_defination_mst.findMany({
    orderBy: {
      concretion_code: 'desc',
    },
    take: 1,
    select: {
      concretion_code: true,
    },
  });

  let nextCode = 'conc001'; // Default to conc001 if no existing codes
  if (maxCodeResult.length > 0) {
    const maxCode = maxCodeResult[0].concretion_code;
    const numericPart = parseInt(maxCode.substring(4), 10);
    const nextNumericPart = numericPart + 1;
    nextCode = `conc${nextNumericPart.toString().padStart(3, '0')}`;
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


export const createConcretion = async (req, res, next) => {

  try {
        const currentUser = res.locals.user;
        if (currentUser?.role_name?.toLowerCase() !== 'super admin') {
          return res.status(403).json({ error: 'Only Super Admin users can create Congregation records.' });
        }

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
  
  const {
    concretionName,
    contactName,
    mobileIsd,
    mobileNo,
    email,
    status,
    languageCode = 'en'
  } = req.body;

  console.log('Request body:', req.body);

  // Validate the required fields
  if (!concretionName || !email) {
    console.log('Validation Error: Missing fields');
    return res.status(400).json({ error: 'concretionName and email are required' });
  }


    // Check if the provided email already exists in `concretion_defination_mst` or `users_mst`
    const existingConcretion = await prisma.concretion_defination_mst.findFirst({
      where: { email },
    });

    if (existingConcretion) {
      console.log('Validation Error: Email already exists in concretion_defination_mst');
      return res.status(400).json({ error: 'The provided email is already in use in concretion records. Please use a different email.' });
    }

    const existingUser = await prisma.users_mst.findFirst({
      where: { user_id: email },
    });

    if (existingUser) {
      console.log('Validation Error: Email already exists in users_mst');
      return res.status(400).json({ error: 'The provided email is already in use in user records. Please use a different email.' });
    }

    // Get the current user's role
    const currentUserRole = res.locals.user?.role_name || 'Unknown';

    // Generate the next sequential concretion code
    const concretionCode = await generateNextConcretionCode();
    const defaultPassword = 'pass123'; // Default password for the user

    // Create the concretion entry
    const newConcretion = await prisma.concretion_defination_mst.create({
      data: {
        concretion_code: concretionCode,
        concretion_name: concretionName,
        contact_name: contactName,
        mobile_isd: mobileIsd,
        mobile_no: mobileNo ? mobileNo.toString() : null,
        email,
        status,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    const quickCode = await generateNextQuickCode();

    await prisma.quickcode_mst.create({
      data: {
        quick_code_type: 'rolnam',
        quick_code: quickCode,
        quickcode_name: 'Congregation Admin',
        language_code: languageCode,
        concurrency_val: 1,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    // Hash the default password
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // Create a user entry for the concretion
    const user = await prisma.users_mst.create({
      data: {
        user_type_code: quickCode, // Use the concretion code as the user type
        prov_concre_code: concretionCode, // Link the user to the concretion
        user_id: email,
        first_name: contactName || email.split('@')[0], // Use contactName or extract from email
        last_name: null,
        password: hashedPassword,
        role_code: quickCode, // Role code is the same as the concretion code
        role_name: 'Concretion Admin',
        language_code: 'en',
        concurrency_val: 1,
        created_by: currentUserRole,
        created_date: new Date(),
      },
    });

    // Send an email notification
    const emailSubject = 'Your Concretion Registration Details';
    const emailBody = `
      Hello ${contactName || ''},

      Your concretion has been successfully registered.

      Concretion Name: ${concretionName}
      Contact Email: ${email}
      Status: ${status || 'Pending'}

      Admin Account Details:
      Username: ${email}
      Password: ${defaultPassword} (please change upon first login)

      Thank you for your support and trust.
    `;

    try {
      await sendEmail(email, emailSubject, emailBody);
      console.log(`Email successfully sent to ${email}`);
    } catch (emailError) {
      console.error(`Error sending email to ${email}:`, emailError.message);
    }

    // Respond with the created concretion entry
    res.status(201).json(newConcretion);
  } catch (error) {
    console.error('Error saving concretion:', error.message); // Log the error
    res.status(500).json({ error: 'Internal server error' }); // Respond with an error
  }
};


export const getConcretions = async (req, res, next) => {
  try {
    const user=res.locals.user,role=String(user?.role_name || '').trim().toLowerCase();
    if(role!=='super admin') {
      let code=user?.concretion_code;
      if(!code&&user?.province_code)code=(await prisma.province_mst.findUnique({where:{province_code:user.province_code}}))?.concretion_code;
      if(!code)return res.status(403).json({error:'Congregation scope is missing.'});
      return res.json(await prisma.concretion_defination_mst.findMany({where:{concretion_code:code}}));
    }
    // Write a raw SQL query to join concretion_defination_mst with province_mst based on province_code
    const concretions = await prisma.$queryRaw`
      SELECT 
        cd.concretion_code,
        cd.concretion_name, 
        cd.contact_name, 
        cd.mobile_no, 
        cd.email, 
        cd.status, 
        cd.mobile_isd
      FROM concretion_defination_mst cd
    `;

    // If no concretions found
    if (concretions.length === 0) {
      return res.status(404).json({ message: 'No concretions found' });
    }

    // Respond with the list of concretions
    res.status(200).json(concretions);
  } catch (error) {
    console.error('Error fetching concretions:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};


// export const updateConcretion = async (req, res) => {
//   const {
//     concretion_code, // Identifier for the concretion to update
//     provinceCodes, // Updated list of province codes
//     concretionName,
//     contactName,
//     mobileIsd,
//     mobileNo,
//     phoneIsd,
//     phoneNo,
//     email,
//     status,
//   } = req.body;

//   console.log('Request body:', req.body);

//   const currentUserRole = res.locals.user?.role_name; // Make sure this is correctly set
//   console.log('Current user role:', currentUserRole); // Debugging line


//   // Validate the required fields
//   if (!concretion_code || !provinceCodes || provinceCodes.length === 0) {
//     console.log('Validation Error: Missing fields');
//     return res.status(400).json({
//       error: 'concretionCode and at least one provinceCode are required',
//     });
//   }

//   // Ensure provinceCodes are unique
//   const uniqueProvinceCodes = [...new Set(provinceCodes.map((code) => code.trim()))];

//   try {
//     // Check if the concretion exists
//     const existingConcretion = await prisma.concretion_defination_mst.findMany({
//       where: { concretion_code: concretion_code },
//     });

//     if (!existingConcretion || existingConcretion.length === 0) {
//       return res.status(404).json({ error: 'Concretion not found' });
//     }

//     // Delete existing province associations for this concretion_code
//     await prisma.concretion_defination_mst.deleteMany({
//       where: { concretion_code: concretion_code },
//     });

//     // Prepare creation promises for unique provinces
//     const updates = uniqueProvinceCodes.map((provinceCode) => {
//       console.log('Creating record:', {
//         concretion_code,
//         province_code: provinceCode,
//         concretion_name: concretionName.trim(),
//         contact_name: contactName.trim(),
//       });
//       return prisma.concretion_defination_mst.create({
//         data: {
//           concretion_code: concretion_code.trim(),
//           province_code: provinceCode.trim(),
//           concretion_name: concretionName.trim(),
//           contact_name: contactName.trim(),
//           mobile_isd: mobileIsd,
//           mobile_no: mobileNo ? mobileNo.toString() : null,
//           phone_isd: phoneIsd,
//           phone_no: phoneNo ? phoneNo.toString() : null,
//           email: email,
//           status: status,
//           updated_by: 'admin', // Marking as 'System' or 'Unknown' if no token is provided
//           updated_date: new Date(), // Set updated_date to current date
//         },
//       });
//     });

//     // Wait for all updates to complete
//     const updatedConcretions = await Promise.all(updates);

//     // Respond with the updated concretion entries
//     res.status(200).json(updatedConcretions);
//   } catch (error) {
//     console.error('Error updating concretion:', error); // Log the full error object for debugging
//     res.status(500).json({ error: error.message || 'Internal server error' });
//   }
// };

export const updateConcretion = async (req, res) => {
  const { concretion_code } = req.params; // Get the concretion code from the request parameters
  console.log(concretion_code)
  const {
    concretion_name,
    contact_name,
    mobile_isd,
    mobile_no,
    email,
    status,
  } = req.body;

  console.log(`Updating congregation with code: ${concretion_code}`);
  console.log('Request body:', req.body);

  // // Validation of required fields
  // if (!concretion_name || !email) {
  //   console.log('Validation Error: Missing fields');
  //   return res.status(400).json({ error: 'All mandatory fields must be provided' });
  // }

  try {
    // Get current user role from authentication middleware
    const updatedBy = res.locals.user?.role_name || 'Unknown';

    // Retrieve existing congregation record
    const existingConcretion = await prisma.concretion_defination_mst.findFirst({
      where: { concretion_code },
    });

    if (!existingConcretion) {
      return res.status(404).json({ error: 'Congregation not found' });
    }

    // Check if the email needs to be updated
    const isEmailChanged = existingConcretion.email !== email;

    if (isEmailChanged) {
      // Check if the email already exists in `concretion_defination_mst`
      const emailExistsInConcretion = await prisma.concretion_defination_mst.findFirst({
        where: {
          email,
          concretion_code: { not: concretion_code }, // Exclude the current record
        },
      });

      if (emailExistsInConcretion) {
        return res.status(400).json({ error: 'Email already exists in another congregation' });
      }

      // Check if the email already exists in `users_mst`
      const emailExistsInUsers = await prisma.users_mst.findFirst({
        where: { user_id: email },
      });

      if (emailExistsInUsers) {
        return res.status(400).json({ error: 'Email already exists in user records' });
      }
    }

    // Update congregation details in concretion_defination_mst
    const updatedConcretion = await prisma.concretion_defination_mst.update({
      where: { concretion_code },
      data: {
        concretion_name,
        contact_name,
        mobile_isd,
        mobile_no: mobile_no ? mobile_no.toString() : null,
        email,
        status,
        updated_by: updatedBy,
        updated_date: new Date(),
      },
    });

    // Check if email changed and update users_mst if needed
    if (isEmailChanged) {
      const existingUser = await prisma.users_mst.findFirst({
        where: { prov_concre_code: concretion_code },
      });

      if (existingUser) {
        const defaultPassword = 'pass123';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        await prisma.users_mst.update({
          where: {
            user_type_code_prov_concre_code_user_id: {
              user_type_code: existingUser.user_type_code,
              prov_concre_code: concretion_code,
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
        const emailBody = `Hello,\n\nYour congregation admin account has been updated.\n\nUsername: ${email}\nPassword: ${defaultPassword}\nPlease change your password upon first login.`;

        try {
          await sendEmail(email, emailSubject, emailBody);
          console.log(`User updated with role_name: '${existingUser.role_name}' and new email: '${email}'`);
        } catch (emailError) {
          console.error(`Error sending email to ${email}:`, emailError.message);
        }
      }
    }

    res.status(200).json(updatedConcretion);
  } catch (error) {
    console.error('Error updating congregation:', error.message);
    console.error('Error details:', error); // Log full error for debugging
    res.status(500).json({ error: 'Internal server error' });
  }
};



export const deleteConcretion = async (req, res) => {
  const { concretion_code } = req.params; // Extract the concretion code from request parameters

  try {
    // Validate input
    if (!concretion_code) {
      return res.status(400).json({ error: 'Concretion code is required.' });
    }

    // Check if the concretion exists
    const existingConcretion = await prisma.concretion_defination_mst.findUnique({
      where: {
        concretion_code,
      },
    });

    if (!existingConcretion) {
      return res.status(404).json({ error: 'Concretion not found.' });
    }

    // Delete associated users in the `users_mst` table
    await prisma.users_mst.deleteMany({
      where: {
        prov_concre_code: concretion_code, // Assuming `prov_concre_code` references the concretion_code in the users table
      },
    });

    // Delete the concretion in `concretion_defination_mst`
    await prisma.concretion_defination_mst.delete({
      where: {
        concretion_code,
      },
    });

    res.status(200).json({ message: 'Concretion and associated users deleted successfully.' });
  } catch (error) {
    console.error('Error deleting concretion and associated users:', error.message);
    res.status(500).json({ error: 'An error occurred while deleting the concretion and associated users.' });
  }
};









