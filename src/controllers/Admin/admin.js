import { withExploreMore } from '../../services/emailFooter.js';
import {MemberAccessService,MEMBER_ROLE,normalizeEmail} from '../../services/memberAccessService.js';
import {sendAccountEmail} from '../../middlewares/emailService.js';
import { PrismaClient } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import bcrypt from 'bcrypt';
import { compare } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { HttpException } from '../../exceptions/HttpException.js';
import { JWT_SECRET, EXPIRY_TIME } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import nodemailer from 'nodemailer';
const prisma = new PrismaClient();

export const registerSuperUser = async (req, res, next) => {
    const { username, password } = req.body;
    try {
      // Check if a SuperUser already exists with the same username
      const existingUser = await prisma.superUser.findUnique({
        where: { username },
      });
  
      if (existingUser) {
        return res.status(StatusCodes.CONFLICT).json({ message: 'Username already taken' });
      }
  
      // Hash the password before saving
      const hashedPassword = await bcrypt.hash(password, 10);
  
      // Create a new SuperUser
      const newSuperUser = await prisma.superUser.create({
        data: {
          username,
          password: hashedPassword,
          userType: 'Super User', // Default value, can be changed if needed
          firstLogin: true, // User will need to change password on first login
        },
      });
  
      logger.info(`Super User ${username} registered successfully`);
  
      return res.status(StatusCodes.CREATED).json({
        message: 'Super User registered successfully',
        superUser: newSuperUser,
      });
    } catch (error) {
      logger.error(`Error registering Super User: ${error.message}`);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message });
    }
  };

  export const loginSuperUser = async (req, res, next) => {
    const { email, password } = req.body;  // Ensure you are extracting the correct field
  
    if (!email || !password) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Email and password are required.' });
    }
  
    try {
      // Fetch the user using email or username
      const superUser = await prisma.superUser.findUnique({
        where: { username: email }, // Ensure you're using the right field here
      });
  
      if (!superUser) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'User not found' });
      }
  
      // Compare the entered password with the stored hashed password
      const isMatch = await compare(password, superUser.password);
      if (!isMatch) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Invalid password' });
      }
  
      // Generate a JWT token
      const token = jwt.sign({ userId: superUser.id, userType: superUser.userType }, JWT_SECRET, {
        expiresIn: EXPIRY_TIME,
      });
  
      return res.status(StatusCodes.OK).json({
        token,
        message: 'Login successful',
      });
    } catch (error) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message });
    }
  };
  

export const changeSuperUserPassword = async (req, res, next) => {
  const { userId, newPassword } = req.body;
  try {
    // Update password and set firstLogin to false after the first password change
    await prisma.superUser.update({
      where: { id: userId },
      data: {
        password: await bcrypt.hash(newPassword, 10), // Hash the new password
        firstLogin: false,
      },
    });

    logger.info(`Super User ${userId} changed password successfully`);

    return res.status(StatusCodes.OK).json({
      message: 'Password changed successfully',
    });
  } catch (error) {
    logger.error(`Error changing Super User password: ${error.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message });
  }
};
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER, // Your Gmail email
      pass: process.env.GMAIL_PASS, // Your Gmail password or app-specific password
    },
  });
  
  // OTP Generation Function
const generateOtp = () => {
  const otp = Math.floor(100000 + Math.random() * 900000); // Generate a 6-digit OTP
  return otp.toString();
};

const sendOtpEmail = async (userEmail, otp) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <table cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
        <tr>
          <!-- Teal Header -->
         <td style="background-color: #00838f; color: white; font-size: 18px; font-weight: bold; padding: 20px; width: 80%; border-top-left-radius: 8px;">
             Welcome to MSFS WEBSITE
          </td>
          <td style="background-color: #f5f5f5; text-align: center; padding: 10px; width: 20%; border-top-right-radius: 8px;">
            <img src="https://myexceluploads.blob.core.windows.net/uploads/MSFS.png" alt="MSFS Logo" style="height: 45px;" />
          </td>
        </tr>

        <!-- Main Content -->
        <tr>
          <td colspan="3" style="padding: 20px;">
            <p>Dear Rev. Father,</p>
            <p>Welcome to <strong>MSFS WEBSITE</strong>, the dedicated website for MSFS Confreres!</p>

            <p>Your registered email for this account is:</p>
            <p style="font-weight: bold; color: #1d4ed8;">${userEmail}</p>

            <p>To access your account securely, please use the One-Time Password (OTP) below:</p>

            <div style="text-align: center; margin: 20px 0;">
              <span style="display: inline-block; background-color: #e0f2fe; color: #0c4a6e; padding: 10px 20px; border-radius: 6px; font-size: 20px;">
                🔑 <strong style="letter-spacing: 4px;">${otp}</strong>
              </span>
            </div>

            <p>This OTP is valid for <strong>10 minutes</strong> and should not be shared with anyone.</p>

            <p>If you did not request this OTP, please ignore this email.</p>

            <p>For any assistance, feel free to contact our support team at:<br />
              <a href="mailto:estatusmsfs@gmail.com" style="color: #1d4ed8;">estatusmsfs@gmail.com</a>
            </p>

            <p>Enjoy using MSFS WEBSITE!</p>

            <p>Fraternally,<br />
            <strong>Admin Team</strong><br />
            DeSales Technologies</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td colspan="3" style="background-color: #e5f1ff; text-align: center; padding: 10px; border-top: 1px solid #cbd5e1;">
            <small>© 2025 <a href="https://www.desalestech.com" style="color: #1d4ed8; text-decoration: none;">www.desalestech.com</a>. All rights reserved.</small>
          </td>
        </tr>
      </table>
    </div>
  `;

  await transporter.sendMail(withExploreMore({
    from: process.env.GMAIL_USER,
    to: userEmail,
    subject: 'Your MSFS WEBSITE OTP Verification',
    html: emailHtml,
  }));
};




const memberPasswords=new MemberAccessService({db:prisma,send:sendAccountEmail});

// Forgot Password (Send OTP)
export const forgotPassword = async (req, res) => {
  const user_id=normalizeEmail(req.body.user_id);

  if (!user_id) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Username is required' });
  }

    try {
 const user = await prisma.users_mst.findFirst({
  where: { user_id:{equals:user_id,mode:'insensitive'} },
});

if (!user) {
  return res.status(200).json({message:'If an eligible account exists, password recovery instructions have been sent.'});
}

    if(user.role_name===MEMBER_ROLE || user.role_code==='MEMBER') {
      try{await memberPasswords.requestResetLink(user.user_id);}catch{/* Keep membership, status and mail outcomes private. */}
      return res.status(200).json({message:'If an eligible account exists, password recovery instructions have been sent.'});
    }
    const role = await prisma.quickcode_mst.findFirst({
  where: {
    quick_code: user.role_code,
    quick_code_type: 'rolnam',
  },
});


    // Only allow if role is in allowed admin types
    const allowedRoles = ['Province Admin', 'Super Admin', 'Congregation Admin'];
    if (!role || !allowedRoles.includes(role.quickcode_name)) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: 'You are not authorized to reset the password.Please contact Admin',
      });
    }

    // Generate OTP
    const otp = generateOtp();

    // Store OTP in database for verification (You may want to save it in the database with an expiry time)
    await prisma.otpstore.create({
      data: {
        user_id: user.user_id,
        otp,
        expiry: new Date(Date.now() + 10 * 60000), // OTP expires in 10 minutes
      },
    });

    // Send OTP to user's email
    await sendOtpEmail(user.user_id, otp);

    return res.status(StatusCodes.OK).json({ message: 'OTP sent to your email' });
  } catch (error) {
    logger.error(`Error in forgotPassword: ${error.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message });
  }
};

export const resetPassword = async (req, res) => {
  const { otp, newPassword } = req.body;

  try {
    if(req.body.user_id) {
      const memberUser=await prisma.users_mst.findFirst({where:{user_id:{equals:normalizeEmail(req.body.user_id),mode:'insensitive'}}});
      if(memberUser?.role_name===MEMBER_ROLE || memberUser?.role_code==='MEMBER') {
        await memberPasswords.resetPassword(memberUser.user_id,req.body.token || otp,newPassword);
        return res.status(200).json({message:'Password reset successful'});
      }
    }
    if(req.body.token)return res.status(400).json({message:'Reset link is invalid or expired.'});
    if(typeof otp !== 'string' || !/^\d{6}$/.test(otp))return res.status(400).json({message:'Invalid OTP'});
    // Check if the OTP is valid
    const otpRecord = await prisma.otpstore.findFirst({
      where: { otp },
    });

    if (!otpRecord) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'Invalid OTP' });
    }

    // Check if OTP is expired
    const isExpired = new Date(otpRecord.expiry) < new Date();
    if (isExpired) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'OTP has expired' });
    }

    // Find user based on OTP record
    const user = await prisma.users_mst.findFirst({
      where: { user_id: otpRecord.user_id }, // Using user_id to find user
    });

    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'User not found' });
    }

    // Hash the new password and update the user
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Ensure to include all parts of the compound key in the `where` clause
    await prisma.users_mst.update({
      where: {
        user_type_code_prov_concre_code_user_id: {
          user_type_code: user.user_type_code, // Include user_type_code
          prov_concre_code: user.prov_concre_code, // Include prov_concre_code
          user_id: user.user_id, // Include user_id
        },
      },
      data: {
        password: hashedPassword,
      },
    });

    // Remove OTP record using the id field
    await prisma.otpstore.delete({
      where: { id: otpRecord.id },  // Use the unique `id` field
    });

    return res.status(StatusCodes.OK).json({
      message: 'Password reset successful',
    });
  } catch (error) {
    logger.error(`Error in resetPassword: ${error.message}`);
    return res.status(error.status || StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message });
  }
};
