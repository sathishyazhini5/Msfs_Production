# E-Status enhancements

The existing UI components/palette, domain routes, mail transport, private Azure storage, report exporter, and Circulars worker are reused. Only Super Admin's `/dashboard` renders the new platform dashboard; other roles retain the domain dashboard.

Implemented areas:

- **Circular compose:** required Circular/Newsletter/Others type (default Circular), editable Regards signature, draft round trips, escaped table-based HTML email and plain-text alternative, matching review preview, immutable queued content/branding, original private attachment, and one envelope per deduplicated email. Retry/recovery logic remains in the existing worker.
- **Recipients:** Congregation Admin can choose multiple provinces from its database-owned scope. Active Confreres/Scholastics and Curia-linked active Confreres retain their original membership rules. Category/search filtering, page-independent selections/exclusions, and email deduplication remain intact. Province Admin stays within its own province; foreign IDs and multi-province requests from other roles are rejected server-side.
- **History:** circular type, province, centre type, dates, status, and stable campaign sorting. PDF/Excel/CSV campaign and recipient-status exports fetch all filtered records on the server. Matching email-recipient counts are separate from total campaign counts. Centre links use complete province/division/centre keys through current appointments and admissions. Queue snapshots retain names, provinces, centre/type affiliations and snapshot version. Legacy missing affiliations remain unknown and are excluded from centre-type matches rather than reconstructed from current data. Detailed exports label all-source affiliations explicitly.
- **Obituary:** From Date/To Date, single bounds, invalid-range handling, inclusive dates in Asia/Kolkata, and identical count/page/export predicates on `obituary_dtl.death_date`. Timestamp range is `[From 00:00 IST, day after To 00:00 IST)`. Unset dates preserve the existing Today/All/date behavior.
- **Logo:** Congregation-only Setup Profile → Logo; upload, preview, replace and delete. PNG/JPEG uploads are decoded/re-encoded to PNG in the browser, then validated server-side for MIME/signature/chunks/CRC/decoded size, maximum 2 MB and 2000 × 2000 pixels. Logos live in the existing private circular container. Email embeds the frozen logo as a CID attachment, so no public attachment URL or additional email-logo host is needed. Replacing/deleting the current logo keeps private immutable versions referenced by queued/sent campaigns. Report helpers receive branding explicitly; PDF and Excel include the raster logo, while CSV carries textual branding/metadata. Reports, circular reports, obituary exports and dashboard reports use the shared exporter.
- **Platform dashboard/hierarchy:** real congregation/province/user counts, actual active/inactive/other status counts, dated onboarding records, search/pagination/status filtering and existing congregation create/edit/details actions. No billing/subscription/activity values are invented. Super Admin manages congregations; Congregation Admin manages only its own provinces. Navigation, direct routes and backend mutations enforce that hierarchy. The legacy `concretion admin` alias is normalized to the existing congregation role.

New additive migration: `20261012180000_circular_branding` adds Circular type/signature/content snapshot and `CongregationBranding`, with a foreign key to `concretion_defination_mst`. Existing Circular rows default to Circular, blank signature, and null content snapshot. It does not reset, delete, rewrite business data, or mark earlier migrations applied.

## Verification

- Backend: 71 passed, 8 skipped in the relevant service/controller/worker suites. Nine new focused tests additionally pass after final changes, covering tenant scope, centre composite keys, all-page selection/deduplication, genuine/invalid logos, branding isolation, review invalidation, frozen retry branding, legacy snapshots, mocked private SMTP envelopes, real execution of obituary boundary predicates, counts/pages/exports, and actual platform roles/metrics.
- Frontend: all **19 suites / 91 tests passed**, including draft fields, recipient selector role behavior, history counts/full exports, obituary validation/exports, branding settings, PDF/Excel branding isolation, dashboard export branding, navigation and existing workflows.
- Application ESLint: no findings. Existing test-library/router/React warnings remain in test logs.
- Prisma schema validates. Client generation succeeded in an isolated output folder with the final schema; generation into the shared default client encountered a Windows lock on `query_engine-windows.dll.node`. The existing API/worker was not stopped to release it.
- Production build: compiled successfully, run once after final frontend changes. Main bundle is 1.13 MB gzipped (+5.57 kB). The existing large-bundle, outdated Browserslist, and CRA Babel dependency warnings remain; no lint checks were disabled.

Logs are under `qa-artifacts`: `enhancements-backend-final.log`, `enhancements-backend-focused-final.log`, `enhancements-frontend-final.log`/`.json`, `enhancements-lint.json`, `enhancements-prisma-validation.log`, `enhancements-prisma-generation.log`, and `enhancements-production-build.log`.

Eight PostgreSQL queue integration tests were intentionally skipped: no dedicated `CIRCULAR_TEST_DATABASE_URL` was supplied. Unit tests use fixture databases/private storage and injected mock email transport; no real SMTP or production-data writes were performed. The isolated-database test setup includes both circular migrations when a dedicated test database is provided.

## Apply and restart

No database migration, deployment, commit or push was performed during this task. In the deployment environment, stop/drain the existing API and worker first (including every API instance with the embedded worker) to release the Windows Prisma DLL. Preserve the existing worker shutdown allowance.

From `E:\E_status_deploy\Backend`, run the installed CLI:

```powershell
node .\node_modules\prisma\build\index.js migrate status --schema=.\src\prisma\schema.prisma
node .\node_modules\prisma\build\index.js migrate deploy --schema=.\src\prisma\schema.prisma
node .\node_modules\prisma\build\index.js generate --schema=.\src\prisma\schema.prisma
```

Review migration status before deployment. The existing `20261012120000_circular_management` migration must precede the new branding migration. If status shows failed/divergent migration history or a missing legacy baseline, reconcile it first; do not reset the database or blindly use `migrate resolve --applied`.

No new environment variables are required. Retain `DATABASE_URL`, `JWT_SECRET`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_CONTAINER_NAME`, and the existing **private** `CIRCULAR_CONTAINER_NAME` (default `msfs-circulars`). The storage identity needs read/write and, if the container does not exist, create permission. Keep `GMAIL_USER` and `GMAIL_PASS` configured for real sending. Keep `CIRCULAR_WORKER_ENABLED=false` for development/verification; enable it only in the intended sending deployment. `CIRCULAR_WORKER_CONCURRENCY` is unchanged (default 3, capped at 5).

Restart the existing API after successful generation (local command: `npm.cmd start`). The API's embedded worker starts automatically under the existing enabled/configured rules. Do not add a second standalone worker to an embedded-worker deployment. Only an existing separate-worker deployment should also restart its established `npm.cmd run circulars:worker` process. Release the final `Frontend/build` through the normal hosting process; this task did not publish it.

After migration/restart, verify with authorized test accounts: two congregations cannot share logos/provinces; select multiple own provinces and review recipient counts; save/reopen a Newsletter/signature; inspect the email preview; test history centre filters and both export scopes; test obituary midnight boundaries; and confirm Super Admin vs congregation/province navigation. Check PDF/Excel appearance and CID rendering in intended email clients with a test mailbox/transport. Never use a production recipient list to verify sending.
