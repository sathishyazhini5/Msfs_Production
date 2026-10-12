# Circular Management

Changed areas: additive Prisma models/migration, `services/circularService.js`, `services/circularQueue.js`, `routes/circulars.js`, `workers/circularWorker.js`, shared mail/private Azure helpers, frontend Circulars components, sidebar and protected route.

## Setup

Run from `Backend`, using the existing database and authentication configuration. Stop the API before generating on Windows, because its loaded Prisma DLL may be locked:

```sh
npx prisma migrate deploy
npx prisma generate
```

Restart the API after generation. Set the existing `GMAIL_USER`, `GMAIL_PASS` (Gmail app password), and `AZURE_STORAGE_CONNECTION_STRING`. Set `CIRCULAR_CONTAINER_NAME` to a dedicated **private** Azure container (default `msfs-circulars`). The service creates it if permitted and refuses public access. Existing uploads and containers are unchanged. Do not use a public container for circulars.

Keep `CIRCULAR_WORKER_ENABLED=false` in development. For production, set it to `true` in the API and worker environment, then restart the backend. `src/app.js` starts the worker automatically after its database connection succeeds, without blocking API requests. For this deployment, **do not also run the standalone worker command**. Each PM2 API instance can run a worker safely: PostgreSQL atomic claims with `FOR UPDATE SKIP LOCKED` prevent two instances from claiming the same job. Concurrency remains bounded per instance.

The standalone command remains available for deployments that intentionally separate the worker from the API:

```sh
npm run circulars:worker
```

`CIRCULAR_WORKER_CONCURRENCY` defaults to 3 and is bounded at 5. Allow at least 180 seconds (`kill_timeout: 180000` in PM2) for in-flight work on shutdown. A shared PostgreSQL queue supports multiple workers with row locks and `SKIP LOCKED`.

## Permission and selection rules

The existing super/province/congregation admin scope utility protects all routes. Drafts are sender-private; history and attachment access require the entire recipient province scope. Categories read active Confreres, active Scholastics, and Curia rows linked to active Confreres. Curia's own province and email are used; a missing Curia email falls back to the linked Confrere's email. No category codes or inferred province relationships are invented.

Selection is resolved server-side. All-matching selection carries filters and exclusions, not a page-sized list. Filter changes clear selection in the UI. Addresses are trimmed and case-normalized, invalid/missing addresses excluded, and duplicates merged with their original category/province snapshots. Limit: 10,000 selected records per circular.

Attachments: genuine PDF, DOCX, PNG and JPEG, up to 10 MB. DOCX directory validation is bounded and rejects macro-bearing documents. Files remain in private Azure storage; only authorized API downloads return bytes. Removing a saved draft attachment first persists the unlink, then deletes the private upload. Unused uploaded files can be removed via the protected attachment endpoint; retained circular attachments are never deleted by that endpoint.

## Delivery semantics and recovery

Each recipient receives a separate envelope with an attachment; no CC/BCC. Review hashes include draft version, content, attachment checksum and the resolved recipient snapshot. Draft version checks and a submission key make repeated submissions idempotent. Recipient email has a unique constraint within its circular.

`Sent` means **SMTP accepted**, not verified delivery. No verified provider-delivery webhook exists in the current Gmail transport, so the module never invents `Delivered`. A stable Message-ID assists provider reconciliation but is not an SMTP exactly-once guarantee.

Workers use five-minute leases renewed every 30 seconds, bounded SMTP timeouts, and a maximum of three attempts per recipient (including manual retries). Explicit temporary SMTP rejections and failures before SMTP DATA can retry. Expired pre-SMTP reservations return to the queue. An expired or failed in-flight SMTP operation with unknown acceptance is marked Failed with `UNKNOWN_OUTCOME` and cannot be retried automatically or through Retry Failed Only. Reconcile such cases with the mail provider before any manual resend; this avoids duplicate mail after crashes. Successful recipients are never retried. Changes to credentials/storage cannot produce fake successful sends.

Drafts and history are durable in PostgreSQL, including sender, scope, timestamps, attachment metadata/checksum, selection summary and per-recipient snapshots/statuses. Recipient discovery and scoped history currently resolve their authorized datasets on the server before pagination; very large directories may need query-level optimization.

## Tests without real mail

```sh
npm run test:circulars
```

Pure tests use fixture business tables and mocked storage. Queue integration tests require `CIRCULAR_TEST_DATABASE_URL` pointing to a dedicated test database with permission to create a temporary schema. They create and remove a uniquely named `circular_test_*` schema and use an injected **mock mail transport**; existing application tables are untouched. Without that variable queue integrations are skipped. Never start the production worker for tests.

From `Frontend`:

```sh
npm test -- --watchAll=false --watchman=false --runInBand --forceExit --testTimeout=60000 --runTestsByPath src/components/Circulars/Circulars.test.js src/components/Circulars/circularSelection.test.js src/pages/SideBar.estatus.test.js
npm run build
```
