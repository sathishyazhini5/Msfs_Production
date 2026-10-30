import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const sameIdentity = (a,b) => ['kind','code','province_code','concretion_code','confrer_code','division_type_code','division_code'].every(key=>a[key]===b[key]);
const denied = () => Object.assign(new Error('Code is invalid or expired.'), {status: 400});
export class MemberOtpService {
  constructor(db, send) { this.db = db; this.send = send; }
  async identities(email) {
    const result = [];
    for (const [kind, model, key] of [['Confrere','confreres_dtl','confrer_code'],['Scholastic','scholastics_dtl','scholastic_code'],['Curia','curia_advisors_dtl','curia_code']]) {
      const rows = await this.db[model].findMany({where: {personal_mailid1: {equals: email, mode:'insensitive'}, ...(kind === 'Curia' ? {} : {is_active:true})}});
      for (const row of rows) {
        if (kind === 'Curia' && !await this.db.confreres_dtl.findFirst({where:{confrer_code:row.confrer_code,is_active:true}})) continue;
        const province = await this.db.province_mst.findUnique({where:{province_code:row.province_code}});
        const congregation = province && await this.db.concretion_defination_mst.findFirst({where:{concretion_code:province.concretion_code}});
        if (!congregation || String(congregation.status).trim().toLowerCase() !== 'active') continue;
        result.push({kind, code:row[key], province_code:row.province_code, concretion_code:province.concretion_code,...(kind==='Curia'?{confrer_code:row.confrer_code,division_type_code:row.division_type_code,division_code:row.division_code}:{})});
      }
    }
    return result;
  }
  async request(email) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return;
    const identities = await this.identities(email);
    if (!identities.length) return;
    const otp = String(randomInt(100000, 1000000));
    const data = {digest:hash(email + ':' + otp), attempts:0, expires_at:new Date(Date.now()+600000), created_at:new Date(), identities};
    const reserved = await this.db.$transaction(async tx => {
      const prior = await tx.memberOtpChallenge.findUnique({where:{email}});
      if (prior && Date.now() - prior.created_at.getTime() < 60000) return false;
      await tx.memberOtpChallenge.upsert({where:{email}, create:{email,...data}, update:data});
      return true;
    },{isolationLevel:'Serializable'});
    if (!reserved) return;
    try { await this.send({to:email, subject:'E-Status login verification', text:`Your login code is ${otp}. It expires in 10 minutes. Do not share it.`}); }
    catch(error) {
      await this.db.memberOtpChallenge.deleteMany({where:{email,digest:data.digest}});
      throw error;
    }
  }
  async verify(email, otp, selection, device) {
    email = String(email || '').trim().toLowerCase();
    const challenge = await this.db.memberOtpChallenge.findUnique({where:{email}});
    if (!challenge || challenge.expires_at <= new Date() || challenge.attempts >= 5) throw denied();
    const attempt = await this.db.memberOtpChallenge.updateMany({where:{email,digest:challenge.digest,attempts:{lt:5},expires_at:{gt:new Date()}},data:{attempts:{increment:1}}});
    if (!attempt.count || !timingSafeEqual(Buffer.from(challenge.digest),Buffer.from(hash(email+':'+String(otp))))) throw denied();
    const identities = (await this.identities(email)).filter(identity => challenge.identities.some(old => sameIdentity(old,identity)));
    if (!identities.length) throw denied();
    // Identity choices are disclosed only after possession of the mailbox is proven.
    if (identities.length > 1 && !selection) return {choices:identities};
    const identity = selection ? identities.find(row => sameIdentity(row,selection)) : identities[0];
    if (!identity) throw denied();
    const revokeToken = randomBytes(32).toString('hex');
    const session = await this.db.$transaction(async tx => {
      const consumed = await tx.memberOtpChallenge.deleteMany({where:{email,digest:challenge.digest,expires_at:{gt:new Date()}}});
      if (consumed.count !== 1) throw denied();
      return tx.memberOtpSession.create({data:{id:randomBytes(32).toString('hex'),email,identity,expires_at:new Date(Date.now()+8*3600000),revoke_digest:hash(revokeToken)}});
    });
    const url = new URL('/api/auth/member-otp/revoke', process.env.PUBLIC_API_URL || 'http://localhost:5000');
    url.searchParams.set('session',session.id); url.searchParams.set('token',revokeToken);
    try {
      await this.send({to:email,subject:'E-Status sign-in: Was this you?',text:`Was this you?\nTime: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} (Asia/Kolkata)\nDevice/browser: ${String(device || 'Unavailable').slice(0,300)}\nNot me / revoke this session: ${url}`});
    } catch (error) {
      await this.db.memberOtpSession.update({where:{id:session.id},data:{revoked_at:new Date()}});
      throw Object.assign(new Error('Security notification could not be sent. Please try again.'),{status:503});
    }
    return {session};
  }
  async active(id) {
    const session = await this.db.memberOtpSession.findUnique({where:{id}});
    if (!session || session.revoked_at || session.expires_at <= new Date()) throw Object.assign(new Error('Session expired or revoked.'),{status:401});
    if (!(await this.identities(session.email)).some(identity => sameIdentity(identity,session.identity))) throw Object.assign(new Error('Member is no longer active.'),{status:403});
    return session;
  }
  async revoke(id, token, confirm = false) {
    const session = await this.db.memberOtpSession.findUnique({where:{id}});
    if (!session || session.expires_at <= new Date() || !timingSafeEqual(Buffer.from(session.revoke_digest),Buffer.from(hash(String(token || ''))))) throw denied();
    if (confirm) await this.db.memberOtpSession.update({where:{id},data:{revoked_at:new Date()}});
  }
}
