import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
import { sendRichEmail } from '../../middlewares/emailService.js';
import path from 'path';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
path.join(__dirname, '../../middlewares/MSFSLOGO/MSFS.png')
const logoPath = path.join(__dirname, 'MSFSLOGO/MSFS.png');


import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/index.js";
import { eventDateFilter } from '../../services/dashboardOccasionsService.js';
import { provinceScopeWhere, resolveDataScope, sendScopeError } from '../../utils/dataScope.js';
// Function to generate the next event_id as a formatted string
const generateNextEventId = async () => {
    const lastEvent = await prisma.event_dtl.findFirst({
        orderBy: {
            event_id: 'desc',
        },
        select: {
            event_id: true,
        },
    }); 

    let nextEventId = 1;
    if (lastEvent) {
        const lastEventIdNumeric = parseInt(lastEvent.event_id.replace('eve', ''), 10);
        nextEventId = lastEventIdNumeric + 1;
    }

    // Format the event_id as 'eve001', 'eve002', etc.
    return `eve${String(nextEventId).padStart(3, '0')}`;
};


export const getAllEvents = async (req, res) => {
    try {
        const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code || null);

        const dateWhere=eventDateFilter(req.query.date);
        // Fetch events based on the province_code
        const events = await prisma.event_dtl.findMany({
          where: {
            ...provinceScopeWhere(provinceCodes), ...dateWhere,
          },
        });

        const formattedEvents = await Promise.all(events.map(async (event) => {
          const [province, language] = await Promise.all([
              prisma.province_mst.findFirst({
                  where: { province_code: event.province_code },
                  select: { province_name: true },
              }),
              prisma.languagemetadata.findFirst({
                  where: { language_code: event.language_code },
                  select: { language_name: true },
              })
          ]);

            return {
                ...event,
                province_name: province ? province.province_name : 'Unknown Province', // Add province_name to event
                language_name: language ? language.language_name : 'Unknown Language',
                from_time: event.from_time ? event.from_time.toISOString().substr(11, 8) : null, // Format from_time
                to_time: event.to_time ? event.to_time.toISOString().substr(11, 8) : null,     // Format to_time
            };
        }));

        return res.status(200).json(formattedEvents);
    } catch (error) {
        console.error('Error fetching events:', error.message);
        return sendScopeError(res, error, 'Internal Server Error');
    }
};


// getEventById

export const getEventById = async (req, res) => {
  const event_id = req.query.event_id || req.body?.event_id;
  if (!event_id) return res.status(400).json({ error: 'event_id is required.' });
  try {
    const { provinceCodes } = await resolveDataScope(req, prisma, req.query.province_code);
    const event = await prisma.event_dtl.findFirst({ where: { event_id, ...provinceScopeWhere(provinceCodes) } });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    return res.json({ ...event, from_time: event.from_time ? event.from_time.toISOString().slice(11, 19) : null, to_time: event.to_time ? event.to_time.toISOString().slice(11, 19) : null });
  } catch (error) { return sendScopeError(res, error, 'Failed to fetch event'); }
};


export const updateEvent = async (req, res) => {
    const {
        event_id,
        event_name,
        event_date,
        venue,
        event_detail,
        language_code,
        concurrency_val,
        updated_by,
        updated_date,
        from_time,
        to_time
    } = req.body;

    try {
        console.log('Received data:', req.body);

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

        // Fetch the province_code for the authenticated user
        const provinceName = decoded.province_name;
        const province = await prisma.province_mst.findFirst({
            where: { province_name: provinceName },
            select: { province_code: true },
        });

        if (!province) {
            console.error(`Province not found for province_name: ${provinceName}`);
            return res.status(404).json({ error: "Province not found for the logged-in user" });
        }

        const province_code = province.province_code;
        const updatedBy = decoded.role_name || decoded.username || 'Unknown';

        // Fetch the event to ensure it exists
        const event = await prisma.event_dtl.findUnique({
            where: {
                event_id_province_code: {
                    event_id: event_id,
                    province_code: province_code,  // Use province_code in the composite unique key
                }
            },
        });

        if (!event) {
            console.error(`Event ID ${event_id} not found in province ${province_code}`);
            return res.status(404).json({ error: `Event ID ${event_id} not found for province ${province_code}` });
        }

        // Determine updated_date; if not provided, use current date
        const effectiveUpdatedDate = updated_date ? new Date(updated_date) : new Date();

        const parsedFromTime = from_time ? new Date(`1970-01-01T${from_time}Z`) : null;
        const parsedToTime = to_time ? new Date(`1970-01-01T${to_time}Z`) : null;

        // Update the event details
        const result = await prisma.event_dtl.update({
            where: {
                event_id_province_code: {
                    event_id: event_id,
                    province_code: province_code,  // Composite unique key
                },
            },
            data: {
                event_name: event_name || event.event_name,
                event_date: event_date ? new Date(event_date) : event.event_date,
                venue: venue || event.venue,
                event_detail: event_detail || event.event_detail,
                language_code: language_code || 'en',  // Default to existing value
                concurrency_val: concurrency_val || 1,  // Default to existing value
                updated_by: res.locals.user?.user_id || updatedBy,
                updated_date: effectiveUpdatedDate,
                from_time: parsedFromTime,  // Store parsed from_time
                to_time: parsedToTime,  // Store parsed to_time
                mail_sent: false,
            },
        });

        const formattedFromTime = parsedFromTime ? parsedFromTime.toISOString().substr(11, 8) : null; // Extract time
        const formattedToTime = parsedToTime ? parsedToTime.toISOString().substr(11, 8) : null; // Extract time

        console.log('Event updated successfully:', result);
        return res.status(200).json({ message: 'Event updated successfully', data: {
            ...result,
            from_time: formattedFromTime,  // Return only the time
            to_time: formattedToTime,
        } });
    } catch (error) {
        console.error('Error updating event:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

// deleteEventById

export const deleteEventById = async (req, res) => {
    const { event_id } = req.body;

    try {
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

        // Fetch the province_code based on the authenticated user's province_name
        const provinceName = decoded.province_name;
        const province = await prisma.province_mst.findFirst({
            where: { province_name: provinceName },
            select: { province_code: true },
        });

        if (!province) {
            console.error(`Province not found for province_name: ${provinceName}`);
            return res.status(404).json({ error: "Province not found for the logged-in user" });
        }

        const province_code = province.province_code;

        // Delete the event using both event_id and province_code (composite unique key)
        const result = await prisma.event_dtl.delete({
            where: {
                event_id_province_code: {
                    event_id: event_id,
                    province_code: province_code,
                },
            },
        });

        return res.status(200).json({ message: 'Event deleted successfully' });
    } catch (error) {
        console.error('Error deleting event:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};


export const saveEvent = async (req, res) => {
  const {
    event_name,
    event_date,
    venue,
    event_detail,
    from_time,
    to_time,
    sendMail,
  } = req.body;

  try {
    console.log('Received data:', req.body);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      const errorMessage = error.name === "TokenExpiredError"
        ? "Token has expired"
        : "Invalid token";
      return res.status(401).json({ error: errorMessage });
    }

    const createdBy = decoded.role_name || decoded.username || 'Unknown';
    const { provinceCodes } = await resolveDataScope(req, prisma);
    const requested = req.body.province_code || decoded.province_code;
    if (!requested || (provinceCodes !== null && !provinceCodes.includes(requested))) return res.status(403).json({error:'Select a province within your authorized scope.'});
    const province = await prisma.province_mst.findFirst({where:{province_code:requested}});
    if (!province) return res.status(404).json({error:'Province not found.'});
    const province_code = province.province_code;

    // Generate the new event_id
    const newEventId = await generateNextEventId();

    // Parse and validate the date and time inputs
    const parsedEventDate = event_date ? new Date(event_date.split('/').reverse().join('-')) : null; // Convert DD/MM/YYYY to YYYY-MM-DD
    if (isNaN(parsedEventDate)) {
      return res.status(400).json({ error: "Invalid event_date format. Use DD/MM/YYYY." });
    }

    const parsedFromTime = from_time ? new Date(`1970-01-01T${from_time.replace('.', ':')}:00Z`) : null;
    const parsedToTime = to_time ? new Date(`1970-01-01T${to_time.replace('.', ':')}:00Z`) : null;

    if ((from_time && isNaN(parsedFromTime)) || (to_time && isNaN(parsedToTime))) {
      return res.status(400).json({ error: "Invalid time format. Use HH.mm (e.g., 12.00)." });
    }

    // Save the event
    const event = await prisma.event_dtl.create({
      data: {
        event_id: newEventId,
        province_code,
        event_name: event_name || null,
        event_date: parsedEventDate,
        venue: venue || null,
        event_detail: event_detail || null,
        language_code: 'en',
        concurrency_val: 1,
        created_by: res.locals.user?.user_id || createdBy,
        created_date: new Date(),
        updated_by: null,
        updated_date: null,
        from_time: parsedFromTime,
        to_time: parsedToTime,
        mail_sent: sendMail,
      },
    });

    // Fetch email IDs from the related tables for the specific province
    if (sendMail) {
    const emailRecipients = await prisma.$queryRaw`
      SELECT DISTINCT personal_mailid1 AS email FROM confreres_dtl WHERE province_code = ${province_code}
      UNION
      SELECT DISTINCT office_mailid1 AS email FROM curia_advisors_dtl WHERE province_code = ${province_code}
      UNION
      SELECT DISTINCT office_mailid1 AS email FROM centre_dtl WHERE province_code = ${province_code}
    `;

    const recipientEmails = emailRecipients.map((row) => row.email).filter(Boolean);

    if (recipientEmails.length > 0) {
      console.log('Sending emails to the following recipients:', recipientEmails);
      const logoUrl = 'http://localhost:5000/assets/MSFS.png'; 
      const emailContent = `
      <div style="max-width:600px;margin:auto;border:1px solid #ddd;border-radius:10px;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#008B94;border-top-left-radius:10px;border-top-right-radius:10px;">
          <tr>
            <!-- Centered Title -->
            <td style="padding:15px;text-align:center;color:white;font-size:22px;font-weight:bold;">
              UPCOMING EVENT
            </td>
    
            <!-- Logo inside grey box -->
            <td style="padding:10px;width:100px;text-align:center;background-color:#f2f2f2;border-top-right-radius:10px;">
               <img src="${logoUrl}" alt="MSFS Logo" style="height:50px;" />
            </td>
          </tr>
        </table>
    
        <div style="padding:25px;">
          <p style="margin:12px 0;"><strong style="color:#006666;">EVENT NAME</strong><br/>${event_name || 'N/A'}</p>
          <p style="margin:12px 0;"><strong style="color:#006666;">DATE</strong><br/>${event_date || 'N/A'}</p>
          <p style="margin:12px 0;"><strong style="color:#006666;">VENUE</strong><br/>${venue || 'N/A'}</p>
          <p style="margin:12px 0;"><strong style="color:#006666;">EVENT DETAILS</strong><br/>${event_detail || 'N/A'}</p>
          <p style="margin:12px 0;"><strong style="color:#006666;">TIME</strong><br/>
            ${from_time ? `From: ${from_time}` : ''} ${to_time ? `To: ${to_time}` : ''}</p>
          <br/>
          <p style="margin-top:25px;">Regards,<br/>${createdBy}</p>
        </div>
      </div>
    `;
    
          // Send the email
          await sendRichEmail({
            to: recipientEmails,
            subject: `Event Saved: ${event_name}`,
            text: `An event has been saved successfully.`,
            html: emailContent,
            
          });
          console.log('Emails sent successfully to:', recipientEmails);
        }
      }
        
    

  
    return res.status(201).json({ message: 'Event saved successfully', data: event });
  } catch (error) {
    console.error('Error saving event:', error.message);
    console.log('No recipients found to send emails.');
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};


export const sendEventMail = async (req, res) => {
  const { event_id } = req.body;

  try {
    console.log('Received request to send mail for event:', event_id);

    // Verify the token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token is missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      const errorMessage = error.name === "TokenExpiredError"
        ? "Token has expired"
        : "Invalid token";
      return res.status(401).json({ error: errorMessage });
    }

    // Extract province_code from token
    const provinceCodeFromToken = decoded.province_code;

    if (!provinceCodeFromToken) {
      return res.status(400).json({ error: "Province information is missing in token" });
    }

    // Fetch the event details using composite key: event_id + province_code
    const event = await prisma.event_dtl.findFirst({
      where: {
        event_id: event_id, 
        province_code: provinceCodeFromToken, // ✅ Use separate fields
      }
      }
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found or you do not have access.' });
    }

    // Fetch email recipients from the relevant province
    const emailRecipients = await prisma.$queryRaw`
      SELECT DISTINCT personal_mailid1 AS email FROM confreres_dtl WHERE province_code = ${event.province_code}
      UNION
      SELECT DISTINCT office_mailid1 AS email FROM curia_advisors_dtl WHERE province_code = ${event.province_code}
      UNION
      SELECT DISTINCT office_mailid1 AS email FROM centre_dtl WHERE province_code = ${event.province_code}
    `;

    const recipientEmails = emailRecipients.map((row) => row.email).filter((email) => email && email.includes('@'));

    if (recipientEmails.length === 0) {
      console.error('No valid recipients found for province:', event.province_code);
      return res.status(400).json({ error: 'No valid recipients found to send emails.' });
    }

     const logoUrl = 'http://localhost:5000/assets/MSFS.png'; 
  const emailContent = `
     <div style="max-width:600px;margin:auto;border:1px solid #ddd;border-radius:10px;font-family:Arial,sans-serif;">
       <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#008B94;border-top-left-radius:10px;border-top-right-radius:10px;">
         <tr>
           <!-- Centered Title -->
           <td style="padding:15px;text-align:center;color:white;font-size:22px;font-weight:bold;">
             UPCOMING EVENT
           </td>
   
           <!-- Logo inside grey box -->
           <td style="padding:10px;width:100px;text-align:center;background-color:#f2f2f2;border-top-right-radius:10px;">
              <img src="${logoUrl}" alt="MSFS Logo" style="height:50px;" />
           </td>
         </tr>
       </table>
   
       <div style="padding:25px;">
         <p style="margin:12px 0;"><strong style="color:#006666;">EVENT NAME</strong><br/>${event.event_name || 'N/A'}</p>
         <p style="margin:12px 0;"><strong style="color:#006666;">DATE</strong><br/>${event.event_date ? new Date(event.event_date).toLocaleDateString('en-GB') : 'N/A'}</p>
         <p style="margin:12px 0;"><strong style="color:#006666;">VENUE</strong><br/>${event.venue || 'N/A'}</p>
         <p style="margin:12px 0;"><strong style="color:#006666;">EVENT DETAILS</strong><br/>${event.event_detail || 'N/A'}</p>
         <p style="margin:12px 0;"><strong style="color:#006666;">TIME</strong><br/>
           ${event.from_time ? `From: ${new Date(event.from_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''} 
           ${event.to_time ? `To: ${new Date(event.to_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
         <br/>
         <p style="margin-top:25px;">Regards,<br/>Province Admin</p>
       </div>
     </div>
   `;
   
 
     // Send the email
     try {
       await sendRichEmail({
         to: recipientEmails,
         subject: `Event Saved: ${event.event_name}`,
         text: `An event has been saved successfully.`,
         html: emailContent,
        
       });
      console.log('Emails sent successfully to:', recipientEmails);
      await prisma.event_dtl.update({
        where: {
          event_id_province_code: { // ✅ Correct way to update using composite key
            event_id,
            province_code: event.province_code, 
          }
        },
        data: {
          mail_sent: true, // ✅ Set `mail_sent` to true
        },
      });

      return res.status(200).json({ message: 'Emails sent successfully' });
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      return res.status(500).json({ error: 'Failed to send emails.' });
    }
  } catch (error) {
    console.error('Error in sendEventMail:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};


