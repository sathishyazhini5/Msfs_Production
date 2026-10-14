import {PrismaClient} from '@prisma/client';
import {resolveDataScope,sendScopeError} from '../../utils/dataScope.js';
const wishDb=new PrismaClient();
import express from 'express';
import { sendAnniversaryEmails,getTodayAnniversaries, sendAnniversaryEmail  } from '../../controllers/Msfs/anniversarynotification.js';

const router = express.Router();

// Route to send anniversary emails
router.post('/sendAnniversaryEmails', async (req, res) => {
    try {
        console.log('Received body:', req.body); // Debugging input

        // Confirm req.body is an array
        const data = Array.isArray(req.body) ? req.body : JSON.parse(JSON.stringify(req.body));

        if (!Array.isArray(data)) {
            throw new Error('Input data must be an array.');
        }

        const scope=await resolveDataScope(req,wishDb);
        const results=await sendAnniversaryEmails(data,scope.provinceCodes);

        res.status(200).json({ message: 'Annual wishes processed.',...results });
    } catch (error) {
        console.error('Error processing request:', error.message);
        res.status(400).json({ message: error.message || 'Failed to send emails.' });
    }
});
router.get('/getTodayAnniversaries', getTodayAnniversaries);
// router.post('/sendAnniversaryEmails', sendTodayAnniversaries);

router.post('/send-anniversary-email', sendAnniversaryEmail);

export const anniversaryRouter = router;
