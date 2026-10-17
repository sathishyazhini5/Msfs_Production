ALTER TABLE "MemberAccess"
 ADD COLUMN "password_initialized_at" TIMESTAMPTZ(6),
 ADD COLUMN "password_change_required" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "password_changed_at" TIMESTAMPTZ(6),
 ADD COLUMN "welcome_status" VARCHAR(24) NOT NULL DEFAULT 'NotRequested',
 ADD COLUMN "welcome_attempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "welcome_started_at" TIMESTAMPTZ(6),
 ADD COLUMN "welcome_sent_at" TIMESTAMPTZ(6),
 ADD COLUMN "welcome_error" TEXT;
