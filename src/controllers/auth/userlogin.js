import { assertCongregationAccess } from '../../services/congregationAccess.js';
import {MemberAccessService,MEMBER_ROLE} from '../../services/memberAccessService.js';
import { PrismaClient } from "@prisma/client";
import { HttpException } from "../../exceptions/HttpException.js";
import { StatusCodes } from "http-status-codes";
import jwt from "jsonwebtoken";
import crypto from "crypto"; 
import { EXPIRY_TIME, JWT_SECRET } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import bcrypt from "bcrypt";
const prisma = new PrismaClient();
const { sign } = jwt;

export const login = async (req, res, next) => {
  try {
    const { password } = req.body;
    const user_id=String(req.body.user_id || '').trim();

    if (!user_id || !password) {
      throw new HttpException(StatusCodes.BAD_REQUEST, 'User ID and password are required');
    }

    // 🔍 Find user and include activities
    const candidates = await prisma.users_mst.findMany({
      where: { OR:[{user_id},{user_id:{equals:user_id.toLowerCase(),mode:'insensitive'},role_code:'MEMBER'}] },
      include: {
        user_role_com_activity_mst: {
          include: {
            componentActivity: true,
          },
        },
      },
    });

    if(candidates.length>1)throw new HttpException(StatusCodes.UNAUTHORIZED,'Account identity is ambiguous. Contact your administrator.');
    const user=candidates[0];
    if (!user) {
      logger.warn(`Login attempt with invalid user_id: ${user_id}`);
      throw new HttpException(StatusCodes.UNAUTHORIZED, 'Incorrect user ID');
    }

   
let isPasswordValid = false;

// Ensure password field is not empty/null
if (!user.password) {
  logger.warn(`User ${user_id} has no password set`);
  throw new HttpException(StatusCodes.UNAUTHORIZED, 'Invalid password');
}

// Check if stored password is bcrypt hashed
const isBcryptHash = user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$');

if((user.role_name===MEMBER_ROLE || user.role_code==='MEMBER') && !isBcryptHash)throw new HttpException(StatusCodes.UNAUTHORIZED,'Member password setup is required.');

if (isBcryptHash) {
  isPasswordValid = await bcrypt.compare(password, user.password);
} else {
  isPasswordValid = password === user.password;
}

if (!isPasswordValid) {
  logger.warn(`Invalid password attempt for user: ${user_id}`);
  throw new HttpException(StatusCodes.UNAUTHORIZED, 'Incorrect password');
}
    // 🔎 Get role name from quickcode
    await assertCongregationAccess(prisma, user);
    if(user.role_name===MEMBER_ROLE || user.role_code==='MEMBER') {
      const access=await new MemberAccessService({db:prisma}).active(user.user_id);
      const congregation=await prisma.concretion_defination_mst.findUnique({where:{concretion_code:access.concretion_code}});
      const tokenData={user_id:user.user_id,role_name:MEMBER_ROLE,role_code:'MEMBER',user_type_code:'MEMBER',concretion_code:access.concretion_code,concretion_name:congregation?.concretion_name,province_code:access.province_code,person_kind:access.person_kind,person_code:access.person_code,password_version:access.password_changed_at?new Date(access.password_changed_at).getTime():0,password_change_required:false};
      return res.status(200).json({accessToken:sign(tokenData,JWT_SECRET,{expiresIn:EXPIRY_TIME}),data:{...tokenData,user_role_com_activity_mst:[]},redirect:'/estatus',message:'Login successful'});
    }
    const quickcode = await prisma.quickcode_mst.findFirst({
      where: {
        quick_code: user.role_code.trim(),
        quick_code_type: {
          in: ['rolnam', 'rolnames'], // ✅ allows both types
        },
      },
      select: {
        quickcode_name: true,
      },
    });
    

    if (!quickcode) {
      logger.warn(`Role not found for role_code: ${user.role_code}`);
      throw new HttpException(StatusCodes.UNAUTHORIZED, 'Role not found');
    }

    // 🔎 Province or Concretion details
    let concretionDetails = null;
    let provinceDetails = null;

    if (user.prov_concre_code === 'ALL') {
      provinceDetails = {
        province_code: 'ALL',
        province_name: 'All',
      };
    } else if (user.prov_concre_code.startsWith('conc')) {
      concretionDetails = await prisma.concretion_defination_mst.findFirst({
        where: { concretion_code: user.prov_concre_code },
        select: {
          concretion_code: true,
          concretion_name: true,
        },
      });

      if (!concretionDetails) {
        logger.warn(`Concretion not found for: ${user.prov_concre_code}`);
        throw new HttpException(StatusCodes.UNAUTHORIZED, 'Concretion not found');
      }
    } else {
      provinceDetails = await prisma.province_mst.findFirst({
        where: { province_code: user.prov_concre_code },
        select: {
          province_name: true,
          province_code: true,
        },
      });

      if (!provinceDetails) {
        logger.warn(`Province not found for: ${user.prov_concre_code}`);
        throw new HttpException(StatusCodes.UNAUTHORIZED, 'Province not found');
      }
    }

    // 🔄 Map role_code to user_type_code
    let user_type_code = null;

    if (user.role_code === 'RN001') {
      user_type_code = 'U001'; // Super Admin
    } else if (['RN003', 'RN004', 'RN006', 'RN013'].includes(user.role_code)) {
      user_type_code = 'U002'; // Province Admin
    } else if (
      ['RN002', 'RN005', 'RN007', 'RN008', 'RN009', 'RN010', 'RN011', 'RN012'].includes(user.role_code)
    ) {
      user_type_code = 'U003'; // Congregation Admin
    } else {
      user_type_code = 'U001'; // Fallback
    }

    // 🪪 JWT Payload
    const tokenData = {
      user_id: user.user_id,
      role_code: user.role_code,
      user_type_code,
      role_name: quickcode.quickcode_name,
      province_name: provinceDetails?.province_name || null,
      province_code: provinceDetails?.province_code || null,
      concretion_name: concretionDetails?.concretion_name || null,
      concretion_code: concretionDetails?.concretion_code || null,
    };

    logger.info("Login Details:", tokenData);

    const accessToken = sign(tokenData, JWT_SECRET, { expiresIn: EXPIRY_TIME });
    const refreshToken = sign({ user_id: user.user_id, token_use: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });

    // Clean response
    const { password: dbPassword, ...responseData } = user;
    responseData.role_name = quickcode.quickcode_name;
    responseData.province_name = tokenData.province_name;
    responseData.province_code = tokenData.province_code;
    responseData.concretion_name = tokenData.concretion_name;
    responseData.concretion_code = tokenData.concretion_code;
    responseData.user_type_code = user_type_code;

    res.status(StatusCodes.OK).json({
      data: responseData,
      accessToken,
      refreshToken,
      message: 'Login successful',
    });
  } catch (error) {
    logger.error(`Error during login: ${error.message}`);
    const statusCode = error.status || StatusCodes.INTERNAL_SERVER_ERROR;
    next(new HttpException(statusCode, error.message || 'Failed to login'));
  } finally {
    await prisma.$disconnect();
  }
};
