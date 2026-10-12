-- Additive only: existing MSFS tables and records are unchanged.
CREATE TABLE "CircularAttachment" (
 "id" UUID PRIMARY KEY, "owner_id" TEXT NOT NULL, "province_codes" TEXT[] NOT NULL,
 "blob_key" TEXT NOT NULL UNIQUE, "filename" TEXT NOT NULL, "mime_type" TEXT NOT NULL,
 "size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Circular" (
 "id" UUID PRIMARY KEY, "sender_id" TEXT NOT NULL, "sender_role" TEXT NOT NULL, "province_codes" TEXT[] NOT NULL,
 "subject" VARCHAR(200) NOT NULL DEFAULT '', "message" TEXT NOT NULL DEFAULT '', "selection" JSONB NOT NULL,
 "selection_summary" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'Draft', "version" INTEGER NOT NULL DEFAULT 1,
 "submission_key" TEXT UNIQUE, "attachment_id" UUID UNIQUE REFERENCES "CircularAttachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "recipient_count" INTEGER NOT NULL DEFAULT 0, "sent_count" INTEGER NOT NULL DEFAULT 0, "failed_count" INTEGER NOT NULL DEFAULT 0,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL,
 "queued_at" TIMESTAMPTZ, "finished_at" TIMESTAMPTZ
);
CREATE TABLE "CircularRecipient" (
 "id" UUID PRIMARY KEY, "circular_id" UUID NOT NULL REFERENCES "Circular"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "email" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'Queued', "attempts" INTEGER NOT NULL DEFAULT 0,
 "retryable" BOOLEAN NOT NULL DEFAULT TRUE, "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_token" UUID, "lease_until" TIMESTAMPTZ, "smtp_started_at" TIMESTAMPTZ,
 "provider_message_id" TEXT, "sent_at" TIMESTAMPTZ, "delivered_at" TIMESTAMPTZ, "last_error" TEXT,
 CONSTRAINT "CircularRecipient_circular_id_email_key" UNIQUE ("circular_id", "email")
);
CREATE INDEX "Circular_status_created_at_idx" ON "Circular"("status", "created_at");
CREATE INDEX "Circular_sender_id_status_idx" ON "Circular"("sender_id", "status");
CREATE INDEX "Circular_province_codes_idx" ON "Circular" USING GIN ("province_codes");
CREATE INDEX "CircularRecipient_status_next_attempt_at_idx" ON "CircularRecipient"("status", "next_attempt_at");
CREATE INDEX "CircularRecipient_status_lease_until_idx" ON "CircularRecipient"("status", "lease_until");
