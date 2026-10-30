import {MemberOtpService} from '../services/memberOtpService.js';
import prisma from '../utils/prisma.js';
import { assertCongregationAccess } from '../services/congregationAccess.js';
import { StatusCodes } from 'http-status-codes';
import jwt from 'jsonwebtoken';
import { HttpException } from '../exceptions/HttpException.js';
import { JWT_SECRET } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const createAuthenticate = (db = prisma) => async (req, res, next) => {
    try {
        const tokenString = req.cookies.auth ||
            (req.header('Authorization') ? req.header('Authorization').split('Bearer ')[1] : null);

        if (!tokenString) {
            logger.warn("Token not provided in request headers.");
            return res.status(StatusCodes.UNAUTHORIZED).json({
                code: 'AUTH_REQUIRED',
                message: 'Authentication is required.',
            });
        }

        try {
            const tokenData = jwt.verify(tokenString, JWT_SECRET);
            if (tokenData.token_use === 'refresh' || (tokenData.user_id && !tokenData.role_name && !tokenData.userType)) return res.status(401).json({code:'INVALID_TOKEN',message:'A valid access token is required.'});
            if (tokenData.member_session) {
                const session = await new MemberOtpService(db).active(tokenData.member_session);
                tokenData.role_name = 'estatus member';
                tokenData.province_code = session.identity.province_code;
                tokenData.concretion_code = session.identity.concretion_code;
            } else await assertCongregationAccess(db, tokenData);
            if (tokenData.user_id) {
                const account=await db.users_mst.findFirst({where:{user_id:tokenData.user_id}});
                if ((account?.must_change_password || tokenData.password_change_required) && req.path !== '/auth/change-password') return res.status(403).json({code:'PASSWORD_CHANGE_REQUIRED',message:'Change your temporary password before continuing.'});
            }
            res.locals.user = tokenData;
            next();
        } catch (err) {
            if (err.status) return res.status(err.status).json({ code: err.code || 'ACCOUNT_UNAVAILABLE', message: err.message });
            if (err.name === 'TokenExpiredError') {
                logger.error('Token expired at:', err.expiredAt);
                return res.status(StatusCodes.UNAUTHORIZED).json({
                    code: 'TOKEN_EXPIRED',
                    message: 'Your session has expired. Please login again.',
                });
            }

            logger.error('Token verification error:', err.message);
            return res.status(StatusCodes.UNAUTHORIZED).json({
                code: 'INVALID_TOKEN',
                message: 'Invalid authentication token.',
            });
        }
    } catch (error) {
        logger.error('Unexpected error during authentication:', error.message);
        next(new HttpException(StatusCodes.INTERNAL_SERVER_ERROR, 'Authentication failed.'));
    }
};

export const authenticate = createAuthenticate();
