import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
path.join(__dirname, '../../middlewares/MSFSLOGO/MSFS.png')
const logoPath = path.join(__dirname, 'MSFSLOGO/MSFS.png');
// Load environment variables from .env file
dotenv.config();

// Create a transporter object using Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use Gmail service
  auth: {
    user: process.env.GMAIL_USER, // Your Gmail address
    pass: process.env.GMAIL_PASS, // Your Gmail password or app password
  },
});

// Existing function (unchanged)
export const sendEmail = async (to, subject, text,firstName = 'Member') => {
  try {
    const name = subject.includes(',') ? subject.split(',')[1].trim() : 'Member';

    const logoUrl = 'http://localhost:5000/assets/MSFS.png'; // ✅ Public URL served by your server


    const html = `
    <div style="max-width:600px;margin:auto;border:1px solid #ddd;border-radius:10px;font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
      <table width="100%" style="background-color:#008B94;border-top-left-radius:10px;border-top-right-radius:10px;">
        <tr>
          <td style="padding:15px 20px;color:#fff;font-size:22px;font-weight:bold;">
             HAPPY ANNIVERSARY
          </td>
          <td style="padding:10px;background-color:#f2f2f2;border-top-right-radius:10px;text-align:center;">
            <img src="${logoUrl}" alt="MSFS Logo" style="height:50px;" />
          </td>
        </tr>
      </table>

      <div style="padding:25px 30px; font-size:16px; color:#333; line-height:1.6;"
       <p style="margin:0 0 15px;">
            Dear <strong style="color:#008B94;">${firstName}</strong>,
          </p>
          
       <p style="margin-bottom:25px;">
          ${text.replace(/\n/g, "<br/>")}🎉
        </p>
      </div>
    </div>
  `;

    const info = await transporter.sendMail({
      from: `"Admin" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text,
      html,
      // attachments: [
      //   {
      //     filename: 'MSFS.png',
      //     path: logoPath,
      //     cid: 'msfsLogo',
      //     contentDisposition: 'inline',
      //     contentType: 'image/png',
      //   },
      // ],
    });

    console.log('Styled email sent: ' + info.response);
  } catch (error) {
    console.error('Error sending styled email:', error);
    throw new Error('Failed to send styled email');
  }
};


// New function to send rich HTML emails
export const sendRichEmail = async ({ to, subject, text, html  }) => {
  try {
    // Ensure 'to' is properly formatted and not empty
    if (!to || to.length === 0) {
      throw new Error('No recipients defined');
    }

    // Ensure 'to' is a properly joined string if it's an array
    const recipientEmails = Array.isArray(to) ? to.join(',') : to;

    // Validate email formatting
    if (!recipientEmails) {
      throw new Error('Invalid recipient email(s)');
    }

    // Send the email using the transporter
    const info = await transporter.sendMail({
      from: `"Admin" <${process.env.GMAIL_USER}>`, // Sender address
      to: recipientEmails, // List of recipients
      subject, // Subject line
      text, // Plain text body
      html,
        // HTML body
    });

    console.log('Rich email sent successfully: ' + info.response);
  } catch (error) {
    console.error('Error sending rich email:', error);
    throw new Error('Failed to send rich email');
  }
};

// Reuse the existing account configuration with bounded circular-only timeouts.
const circularTransport = nodemailer.createTransport({...transporter.options, connectionTimeout:30000, greetingTimeout:30000, socketTimeout:60000});
// One envelope per recipient; never add CC/BCC or log recipient addresses.
export const circularMailConfigured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_PASS);
export const sendCircularEmail = async ({to, subject, text, html, logo, attachment, messageId}) => {
  if (!circularMailConfigured()) throw Object.assign(new Error('Circular email credentials are not configured.'), {code:'ECONFIG', command:'CONN'});
  return circularTransport.sendMail({from: `"MSFS eStatus" <${process.env.GMAIL_USER}>`, to, subject, text, html, messageId,
    attachments: [{filename: attachment.filename, content: attachment.buffer, contentType: attachment.mime_type},...(logo?[{filename:'congregation-logo.png',content:logo.buffer,contentType:logo.mime_type,cid:'congregation-logo',contentDisposition:'inline'}]:[])]});
};

// Private single-recipient account/wish transport using the existing server credentials.
export const sendAccountEmail = options => circularTransport.sendMail({from:process.env.GMAIL_USER,...options});
