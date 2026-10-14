import {PrismaClient} from '@prisma/client';
import {createMemberGuard} from '../middlewares/memberGuard.js';
import {memberAccessRouter} from './memberAccess.js';
import express from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { authRouter } from './auth.js';
import { depaturerouter } from './quickcoderoutes/depatureroutes.js';
import { metarouter } from './quickcoderoutes/metadata.js';
import { scholasticRouter } from './quickcoderoutes/scholasticsRoute.js';
import { usertypeRouter } from './quickcoderoutes/usertypeRouter.js';
import { designationRouter } from './quickcoderoutes/designation.js';
import { centreRouter } from './quickcoderoutes/centretype.js';
import { membertypeRouter } from './quickcoderoutes/membertype.js';
import { MandateRouter } from './quickcoderoutes/mandate.js';
import { FormationRouter } from './quickcoderoutes/formation.js';
import { pcicoffRouter } from './quickcoderoutes/pcicoff.js';
import { PromotionRouter } from './quickcoderoutes/promotion.js';
import { yearofformationRouter } from './quickcoderoutes/yearoffromation.js';
import { AnniversarytypeRouter } from './quickcoderoutes/anniversarytype.js';
import { ApostlRouter } from './quickcoderoutes/apostolateRouter.js';
import { apostolateRouter } from './mastertableroutes/apostolates.js';
import { divisiontypeRouter } from './quickcoderoutes/divisiontyp.js';
import { BloodgroupRouter } from './bloodgroupRouter.js';
import { LanguageRouter } from './quickcoderoutes/Language.js';
import { provinceRouter } from './mastertableroutes/province.js';
import { CountrydataRouter } from './mastertableroutes/country.js';
import { StateRouter } from './mastertableroutes/state.js';
import { UserRouter } from './mastertableroutes/user.js';
import { NationalityRouter } from './quickcoderoutes/nationality.js';
import { DivisionRouter } from './mastertableroutes/division.js';
import { DateRouter } from './quickcoderoutes/dateformat.js';
import { ConfrereRouter } from './Msfs/Confreres.js';
import { headquartersRouter } from './Msfs/headquarters.js';
import { ScholasticsRouter } from './Msfs/scholasticsRouter.js';
import  { ScholasticsFeedbackRouter } from './Msfs/scholasticsfeedback.js';
import { CuriaRouter } from './Msfs/curia.js';
import { Scholastics_admisnRouter } from './Msfs/scholastics_admisn copy.js';
import { CentreRouter2 } from './Msfs/centre.js';
import { saveAppointmentTransferRouter } from './Msfs/admissionandtransfer.js';
import { CommunityRouter } from './Msfs/communityhouse.js';
import { ObituaryRouter } from './Msfs/obituary.js';
import { DioceseRouter } from './quickcoderoutes/Diocese.js';
import { DepartureRouter } from './Msfs/departures.js';
import { AnnouncementRouter } from './Msfs/NewAnnouncements.js';
import { eventRouter } from './Msfs/Event.js';
import {confrereFeedbackRouter } from './Msfs/confrereFeedbackRouter.js'
import {FedtypeRouter} from './quickcoderoutes/fedtypeRouter.js'
import { concertionRouter } from './admin/Concretion.js';
import { userroleactivityRouter } from './admin/useractivitymapping.js';
import { getDivisionCountsRouter } from './Dashboard/dashboard.js';
import { ProvinceCountryMapRouter } from './mastertableroutes/province_country_map.js';
import { anniversaryRouter } from './Msfs/anniverasrynotification.js'
import { confrerEnquiryRouter } from './Msfs/confrereEnquiry.js';
import { superUserRouter } from './admin/admin.js';
import {DashboardRouter} from './Dashboard_for_concregation/Dashboard_con.js';
import { Rolenamerouter } from './quickcoderoutes/rolename.js';
import { globalSearchRouter } from './globalSearch.js';
import { notificationRouter } from './notifications.js';
import { activityRouter } from './activities.js';
import { reportsRouter } from './reports.js';
import { circularsRouter } from './circulars.js';



import { estatusRouter } from './estatus.js';
import {brandingRouter} from './branding.js';
import {platformRouter} from './platform.js';
const router = express.Router();

router.use(authRouter);

// Login and password recovery are public; all application data requires a session.
const publicAuthPaths = new Set(['/loginsuperuser', '/forgotpassword', '/resetpassword']);
router.use((req, res, next) => {
  if (req.method === 'POST' && publicAuthPaths.has(req.path.toLowerCase())) return next();
  return authenticate(req, res, next);
});

router.use(createMemberGuard(new PrismaClient()));
router.use(memberAccessRouter);

router.use(depaturerouter);
router.use(metarouter);
router.use(scholasticRouter);
router.use(usertypeRouter);
router.use(designationRouter);
router.use(centreRouter);
router.use(membertypeRouter);
router.use(MandateRouter);
router.use(FormationRouter);
router.use(pcicoffRouter);
router.use(PromotionRouter);
router.use(yearofformationRouter);
router.use(AnniversarytypeRouter);
router.use(ApostlRouter);
router.use(apostolateRouter);
router.use(divisiontypeRouter);
router.use(BloodgroupRouter);
router.use(LanguageRouter);
router.use(provinceRouter); // Use the router
router.use(CountrydataRouter);
router.use(StateRouter);
router.use(UserRouter)
router.use(NationalityRouter);
router.use(DivisionRouter);
router.use(DateRouter);
router.use(ConfrereRouter);
router.use(headquartersRouter)
router.use(ScholasticsRouter)
router.use(ScholasticsFeedbackRouter)
router.use(CuriaRouter)
router.use(Scholastics_admisnRouter)
router.use(CentreRouter2)
router.use(saveAppointmentTransferRouter)
router.use(CommunityRouter)
router.use(DioceseRouter)
router.use(DepartureRouter)
router.use(AnnouncementRouter)
router.use(eventRouter)
router.use(confrereFeedbackRouter)
router.use(FedtypeRouter)
router.use(ObituaryRouter)
router.use(concertionRouter)
router.use(userroleactivityRouter)
router.use(getDivisionCountsRouter)
router.use(ProvinceCountryMapRouter)
router.use(anniversaryRouter)
router.use(confrerEnquiryRouter)
router.use(superUserRouter)
router.use(DashboardRouter)
router.use(Rolenamerouter)
router.use(estatusRouter)
router.use(globalSearchRouter)
router.use(notificationRouter)
router.use(activityRouter)
router.use(reportsRouter)
router.use(circularsRouter)
router.use(brandingRouter)
router.use(platformRouter)

export const indexRouter = router;
