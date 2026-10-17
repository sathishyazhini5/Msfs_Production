import { upcomingAnniversaries } from '../../services/upcomingAnniversaries.js';
import {resolveDataScope,provinceScopeWhere} from '../../utils/dataScope.js';
import {AnnualWishService} from '../../services/annualWishService.js';
import {sendAccountEmail} from '../../middlewares/emailService.js';
import {downloadCircularBlob} from '../../middlewares/azureBlob.js';
import { sendEmail } from '../../middlewares/emailService.js';
import { PrismaClient } from '@prisma/client';
import { HttpException } from '../../exceptions/HttpException.js';
import { StatusCodes } from 'http-status-codes';
import { logger } from '../../utils/logger.js';
const prisma = new PrismaClient();

// export const sendAnniversaryEmails = async (req, res, next) => {
//     try {
//         // Fetch pending notifications
//         const notifications = await prisma.anniversary_notify_dtl.findMany({
//             where: { notify_sent_date: null },
//         });

//         if (!notifications.length) {
//             return res.status(200).json({ message: 'No pending notifications found.' });
//         }

//         const results = [];

//         for (const notification of notifications) {
//             try {
//                 // Check if email exists
//                 if (!notification.emailid) {
//                     results.push({
//                         notify_id: notification.notify_id,
//                         status: 'Failed',
//                         error: 'Missing email ID',
//                     });
//                     continue;
//                 }

//                 // Prepare email content
//                 const subject = 'Happy Anniversary!';
//                 const text = `Dear Member,\n\nWishing you a very happy ${notification.anniversary_type_code} on ${notification.anniversary_date.toDateString()}!`;

//                 // Send email
//                 const emailResult = await sendEmail(notification.emailid, subject, text);

//                 if (emailResult.success) {
//                     // Update notify_sent_date in the database
//                     await prisma.anniversary_notify_dtl.update({
//                         where: { notify_id: notification.notify_id },
//                         data: { notify_sent_date: new Date() },
//                     });

//                     results.push({
//                         notify_id: notification.notify_id,
//                         status: 'Sent',
//                     });
//                 } else {
//                     results.push({
//                         notify_id: notification.notify_id,
//                         status: 'Failed',
//                         error: emailResult.error,
//                     });
//                 }
//             } catch (error) {
//                 results.push({
//                     notify_id: notification.notify_id,
//                     status: 'Failed',
//                     error: error.message,
//                 });
//             }
//         }

//         res.status(200).json({
//             message: 'Anniversary notifications processed.',
//             results,
//         });
//     } catch (error) {
//         console.error('Error processing anniversary emails:', error.message);
//         next(new Error('Failed to process anniversary notifications.'));
//     }
// };




import { Prisma } from '@prisma/client';

export const getTodayAnniversaries = async (req, res, next) => {
  try {
    const { date, type, fullDate } = req.query;
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code);

    const inputDate = fullDate ? new Date(fullDate) : (date ? new Date(date) : new Date());

    const matchFullDate = !!fullDate;
    const formattedFullDate = inputDate.toISOString().split('T')[0]; // 'YYYY-MM-DD'
    const formattedMonthDay = `${String(inputDate.getMonth() + 1).padStart(2, '0')}-${String(inputDate.getDate()).padStart(2, '0')}`; // 'MM-DD'

    console.log('Query Type:', matchFullDate ? 'FULL DATE' : 'MM-DD');
    console.log('Looking for:', matchFullDate ? formattedFullDate : formattedMonthDay);

    // Removed type filtering from SQL — will handle it in JS
    const typeCondition = Prisma.empty;

    const buildQuery = (tableName, codeField) => Prisma.sql`
      SELECT 
        ${codeField} AS id,
        '${tableName}' AS type,
        first_name,
        last_name,
        personal_mailid1 AS emailid,
        personal1_contact_no AS contact_no,
        CASE
          WHEN ${matchFullDate ? Prisma.sql`TO_CHAR(birth_date, 'YYYY-MM-DD') = ${formattedFullDate}` : Prisma.sql`TO_CHAR(birth_date, 'MM-DD') = ${formattedMonthDay}`} THEN 'Birthday'

          WHEN ${matchFullDate ? Prisma.sql`TO_CHAR(ordination_date, 'YYYY-MM-DD') = ${formattedFullDate}` : Prisma.sql`TO_CHAR(ordination_date, 'MM-DD') = ${formattedMonthDay}`} THEN 'Ordination'
        END AS anniversary_type,
        CASE
          WHEN ${matchFullDate ? Prisma.sql`TO_CHAR(birth_date, 'YYYY-MM-DD') = ${formattedFullDate}` : Prisma.sql`TO_CHAR(birth_date, 'MM-DD') = ${formattedMonthDay}`} THEN birth_date
  
          WHEN ${matchFullDate ? Prisma.sql`TO_CHAR(ordination_date, 'YYYY-MM-DD') = ${formattedFullDate}` : Prisma.sql`TO_CHAR(ordination_date, 'MM-DD') = ${formattedMonthDay}`} THEN ordination_date
        END AS anniversary_date
      FROM ${Prisma.raw(tableName)}
      WHERE (
        ${matchFullDate
        ? Prisma.sql`
            TO_CHAR(birth_date, 'YYYY-MM-DD') = ${formattedFullDate} OR
        
            TO_CHAR(ordination_date, 'YYYY-MM-DD') = ${formattedFullDate}`
        : Prisma.sql`
            TO_CHAR(birth_date, 'MM-DD') = ${formattedMonthDay} OR
            TO_CHAR(ordination_date, 'MM-DD') = ${formattedMonthDay}`
      }
      )
      AND is_active = TRUE
      ${provinceCodes === null ? Prisma.empty : provinceCodes.length ? Prisma.sql`AND province_code IN (${Prisma.join(provinceCodes)})` : Prisma.sql`AND FALSE`}
      ${typeCondition}
    `;

    const [confreres, scholastics] = await Promise.all([
      prisma.$queryRaw(buildQuery('confreres_dtl', Prisma.sql`confrer_code`)),
      prisma.$queryRaw(buildQuery('scholastics_dtl', Prisma.sql`scholastic_code`)),
    ]);

    const anniversaries = [
      ...confreres,
      ...scholastics,
    ].map((record) => ({
      ...record,
      full_name: `${record.first_name || ''} ${record.last_name || ''}`.trim(),
      anniversary_date: new Date(record.anniversary_date).toLocaleDateString('en-GB'),
      contact_no: record.contact_no?.toString() || null,
    }));

    // ✅ NEW: Apply anniversary_type filter after query
    const filteredAnniversaries = type
      ? anniversaries.filter((a) => a.anniversary_type === type)
      : anniversaries;

    if (filteredAnniversaries.length === 0) {
      return res.status(404).json({ message: 'No anniversaries found for the selected date and type.' });
    }

    res.status(200).json(filteredAnniversaries);
  } catch (error) {
    console.error('Error fetching anniversaries:', error.message);
    next(new Error('Failed to fetch anniversary data.'));
  }
};

const annualWishes=new AnnualWishService({db:prisma,send:sendAccountEmail,download:downloadCircularBlob,log:logger});
export const sendTodayAnniversaries=async(req,res,next)=>{
 try {const results=await annualWishes.run();if(res)return res.json({message:'Annual wishes processed.',...results});return results;}
 catch(error){logger.error(`Annual wish job failed: ${error.code || error.name}`);if(next)return next(error);throw error;}
};
// Existing callers use the same durable annual identity checks and actual dates.
export const sendAnniversaryEmails=async(data,provinceCodes=null)=>annualWishes.run(provinceCodes);

export const sendAnniversaryEmail = async (req, res, next) => {
  try {
    console.log("REQ BODY DEBUG:", req.body);

    const {
      language,
      emailsubject,
      emailmessage,
      confrer_code,
      scholastic_code,
    } = req.body;

    if (!language || !emailsubject || !emailmessage) {
      throw new HttpException(StatusCodes.BAD_REQUEST, 'Required fields are missing');
    }

    const scope=await resolveDataScope(req,prisma);
    let confrereRecipients = [], scholasticRecipients = [];

    if (Array.isArray(confrer_code) && confrer_code.length > 0) {
      confrereRecipients = await prisma.confreres_dtl.findMany({
        where: { confrer_code: { in: confrer_code },...provinceScopeWhere(scope.provinceCodes) },
        select: { personal_mailid1: true, first_name: true },
      });
    }

    if (Array.isArray(scholastic_code) && scholastic_code.length > 0) {
      scholasticRecipients = await prisma.scholastics_dtl.findMany({
        where: { scholastic_code: { in: scholastic_code },...provinceScopeWhere(scope.provinceCodes) },
        select: { personal_mailid1: true, first_name: true },
      });
    }

    const recipients = [...confrereRecipients, ...scholasticRecipients];

    if (!recipients.length) {
      throw new HttpException(StatusCodes.NOT_FOUND, 'No matching records found');
    }

    const results = [];

    for (const person of recipients) {
      if (!person.personal_mailid1) continue;

      try {
        await sendEmail(
          person.personal_mailid1,
          emailsubject,
          emailmessage,
          person.first_name || 'Member'
        );
        results.push({ email: person.personal_mailid1, status: 'Sent' });
      } catch (err) {
        results.push({
          email: person.personal_mailid1,
          status: 'Failed',
          error: err.message,
        });
      }
    }

    if (results.length === 0) {
      throw new HttpException(StatusCodes.NOT_FOUND, 'No valid email addresses found');
    }

    res.status(StatusCodes.OK).json({
      message: 'Emails processed',
      results,
    });
  } catch (error) {
    console.error('Unhandled Error:', error);
    next(new HttpException(StatusCodes.INTERNAL_SERVER_ERROR, error.message));
  }
};




export const getUpcomingAnniversaries = async (req, res, next) => {
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code);
    const where = { is_active: true, ...provinceScopeWhere(provinceCodes) };
    const select = { first_name:true, middle_name:true, last_name:true, province_code:true, birth_date:true, ordination_date:true };
    const [confreres, scholastics] = await Promise.all([
      prisma.confreres_dtl.findMany({where, select:{...select,confrer_code:true}}),
      prisma.scholastics_dtl.findMany({where, select:{...select,scholastic_code:true}}),
    ]);
    res.json(upcomingAnniversaries([...confreres,...scholastics]));
  } catch (error) { next(error); }
};
