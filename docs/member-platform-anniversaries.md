# Super Admin, member access, and annual wishes

## Deploy

Stop the backend before generating Prisma on Windows (the API may hold the engine DLL).
Run in Backend:

```powershell
npx prisma migrate deploy
npx prisma generate
npm start
```

No database reset or seed is required. The additive migration creates MemberAccess, MemberPasswordToken and AnnualWish. It preserves business tables and admin accounts. Existing branding migrations must also be applied by migrate deploy.

For PM2, restart the existing backend process with --update-env. Keep the Circular worker embedded; do not also run its standalone command.

Frontend:

```powershell
npm run build
```

Deploy Frontend/build through the existing hosting setup.

## Configuration

APP_TIMEZONE defaults to Asia/Kolkata. Set it to the application's IANA timezone if different. Existing GMAIL_USER, GMAIL_PASS and private Azure storage configuration are reused. No new mail account is required. Configure each congregation's actual name in congregation management and upload its own PNG in the existing Logo settings. Missing/unavailable logos use that congregation's text name, never another tenant's logo.

There is one daily midnight scheduler, with the explicit application timezone. It defaults off outside production to prevent development wishes. Set ANNIVERSARY_EMAILS_ENABLED=true in the deployed backend environment (production defaults on when the variable is absent); false disables it explicitly. PM2 instances use the same annual unique event identity. A stable identity derived from the actual person key also prevents repeat wishes after a province transfer. A wish is Sent only after SMTP acceptance. Ambiguous SMTP outcomes stay Unknown/Processing and must be reconciled with the provider before any manual retry. Safe transient failures can be retried up to three attempts by rerunning the same-day annual job; no automatic resend is attempted after an uncertain SMTP submission.

## Member setup

Authorized Super, Congregation and Province admins use Users ? Provision E-Status member access. Records are scoped to the administrator. Accounts use the actual record email. Existing accounts and shared addresses belonging to different people are rejected without modifying roles. Multiple matching Curia appointment records require correction/identity clarification rather than a silent link.

Provisioning sends no invitation and creates no usable default password. The member uses the existing Forgot Password flow to request a six-digit code and set a password (12?128 characters). Codes are email-scoped, hashed, expire after ten minutes, limited to five attempts, single-use, and throttled to one request per minute. No existing administrator password is changed by provisioning.

Members land in E-Status. Every authenticated API request verifies the active linked identity. Only GET directory/filter/detail endpoints are allowed, within the member's congregation. Exports, mutations, report/circular/admin/setup APIs are blocked. Directory profile print/share controls are hidden. Admin dashboards and route permissions retain existing behavior.

Super Admin alone gets the platform overview and five-item navigation. Metrics and activity come from stored congregation, province and user records. Recent activity reflects recorded creation/update timestamps; it does not fabricate an audit trail or login history where none is stored.

## Validation

```powershell
node --test tests/memberAnnual.test.js tests/memberWishMigration.test.js tests/enhancements.test.js tests/estatus.test.js
```

Set CIRCULAR_TEST_DATABASE_URL for the migration/atomic-claim test. It creates and removes a uniquely named member_wish_test_* schema only. Pure member/annual tests inject a mocked mail transport. Never start the backend or production mail worker to run these tests.
