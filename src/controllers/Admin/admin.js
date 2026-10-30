import {requestAdminReset,completeAdminReset} from '../../services/adminResetService.js';
import {accountAudit} from '../../services/accountAudit.js';
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
const memberPasswords=new MemberAccessService({db:prisma,send:sendAccountEmail});

// Forgot Password (Send OTP)
export const forgotPassword = async (req,res) => {
  const user_id=normalizeEmail(req.body.user_id);
  const message='If an eligible account exists, password recovery instructions have been sent.';
  try {
    const user=await prisma.users_mst.findFirst({where:{user_id:{equals:user_id,mode:'insensitive'}}});
    if(user) {
      if(user.role_name===MEMBER_ROLE || user.role_code==='MEMBER') {
        await memberPasswords.requestResetLink(user.user_id);
        try{await accountAudit(prisma,user,'reset requested');}catch{logger.warn('Password reset audit delivery failed.');}
      } else await requestAdminReset(prisma,user);
    }
  } catch { logger.warn('Password recovery could not be delivered. Retry after the cooldown.'); }
  res.status(200).json({message});
};
export const resetPassword = async (req,res) => {
  try {
    const user_id=normalizeEmail(req.body.user_id);
    const user=await prisma.users_mst.findFirst({where:{user_id:{equals:user_id,mode:'insensitive'}}});
    if(!user) return res.status(400).json({message:'Reset link is invalid or expired.'});
    let delivery;
    if(user.role_name===MEMBER_ROLE || user.role_code==='MEMBER') {
      await memberPasswords.resetPassword(user.user_id,req.body.token || req.body.otp,req.body.newPassword);
      try {await accountAudit(prisma,user,'reset completed');delivery={audit:'sent'};}catch{delivery={audit:'failed'};}
    } else delivery=await completeAdminReset(prisma,user,req.body.token,req.body.newPassword);
    res.json({message:'Password reset successful',emailStatus:delivery});
  }catch(error){res.status(error.status || 500).json({message:error.status?error.message:'Unable to reset password.'});}
};
