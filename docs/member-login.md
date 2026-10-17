# Member login

Credentials remain in `users_mst.password` as bcrypt hashes. `MemberAccess` records the person kind, person key, province and congregation. Curia appointments referencing a Confrere reuse that person's account, with the valid Confrere email preferred as the canonical login. A Curia email is used when the linked Confrere lacks a valid email. Separate people sharing an email and existing administrator accounts are reported, never converted.

Members sign in with their recorded canonical email and the initialized password, then open `/estatus` directly. There is no mandatory initial-password screen. Forgot Password emails a random 256-bit, hashed, expiring, single-use reset link; the new bcrypt hash replaces the login credential and revokes older member sessions. Existing administrator OTP recovery remains supported.

Creation and the supported Confrere/Scholastic imports already call the post-commit provisioning hook. Provisioning records a private welcome outbox entry once. Ordinary edits do not initialize or email credentials. The welcome worker sends only while the account still uses its initialized password. Safe transport failures can retry; uncertain SMTP outcomes require reconciliation.

## Commands

Run from `Backend`, after verifying `DATABASE_URL` identifies an authorized development database:

```powershell
.\node_modules\.bin\prisma.cmd migrate status
.\node_modules\.bin\prisma.cmd migrate deploy
.\node_modules\.bin\prisma.cmd generate
node scripts/provisionMembers.js --dry-run --environment development --report ../qa-artifacts/member-backfill-preview.json
node scripts/provisionMembers.js --dry-run --email person@example.org --environment development
node scripts/provisionMembers.js --execute --email person@example.org --environment development --confirm-database msfs
node scripts/provisionMembers.js --execute --environment development --confirm-database msfs --report ../qa-artifacts/member-backfill-executed.json
```

Replace `msfs` with the exact database name from the reviewed connection. Execute mode rejects a production environment or an unconfirmed database name. There are at most four simultaneous per-person transactions. Repeated runs preserve initialized/reset passwords. Unknown legacy hashes are left unchanged unless an operator provides a separately reviewed `--legacy-uninitialized-file` JSON email allowlist. Never certify a changed password as unused.

Backfill sends no emails and does not queue bulk invitations. Reports contain person identifiers/status/reasons, never passwords, hashes, reset tokens, or SMTP credentials. Review conflicts and missing/invalid addresses before correcting records.

For **new** member welcome mail, explicitly set `MEMBER_WELCOME_WORKER_ENABLED=true` in the deployed backend, configure the existing SMTP/Azure services, and restart it. Keep this false during verification. Run only one delivery mode: the embedded worker, or the existing standalone `node scripts/memberWelcomeWorker.js --execute --watch`. The standalone command without `--execute` is read-only. Do not run live credential mail during tests.

Member API access is limited to E-Status list/filter/detail GETs and password operations. Scope is recomputed from the linked congregation, never the submitted record ID or stored browser role. Member profile responses use a whitelist excluding credentials, evaluations, medical/emergency details and unknown fields. Administrator visibility is unchanged.

## Verification

```powershell
node --test tests/memberInitialization.test.js tests/memberLoginFlow.test.js tests/estatus.test.js
node --test --test-skip-pattern="the existing single anniversary schedule" tests/memberAnnual.test.js
```

The existing anniversary scheduling test expects midnight while this workspace's scheduler is set to 10:50. Member-login work leaves that unrelated schedule unchanged.

## This implementation run

The user confirmed the configured remote PostgreSQL `msfs` database, schema `estatus`, is authorized development. Both pending member migrations were applied. Dry-run and bulk initialization created 1,093 bcrypt member accounts; 10 missing/invalid emails and 3 conflicts were reported. Execute-mode rerun created/reset no accounts. No live credential emails were sent. Reports are in `qa-artifacts/member-backfill-*.json`.

Read-only HTTP verification used persisted Confrere, Scholastic and Curia-overlap identities through the real login and E-Status routers. All three passed login, list, filters, details, administrative denial and cross-congregation denial.

`prisma generate` was attempted but the existing Windows query-engine DLL was locked by running processes. The existing generated client already supports the unchanged schema and performed all successful database writes/read checks. Regenerate after stopping the owning development backend if needed. Production code has not been published/restarted by this task.
