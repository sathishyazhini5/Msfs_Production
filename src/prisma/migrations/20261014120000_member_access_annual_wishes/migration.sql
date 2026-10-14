CREATE TABLE "MemberAccess" (
 "user_id" VARCHAR(100) PRIMARY KEY REFERENCES "users_mst"("user_id") ON DELETE CASCADE ON UPDATE CASCADE,
 "person_kind" VARCHAR(20) NOT NULL,"person_code" VARCHAR(50) NOT NULL,"province_code" VARCHAR(10) NOT NULL,
 "concretion_code" VARCHAR(10) NOT NULL,"enabled" BOOLEAN NOT NULL DEFAULT true,"created_by" VARCHAR(100) NOT NULL,
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MemberAccess_person_kind_person_code_province_code_key" UNIQUE("person_kind","person_code","province_code")
);
CREATE TABLE "MemberPasswordToken" (
 "user_id" VARCHAR(100) PRIMARY KEY,"token_hash" VARCHAR(64) NOT NULL,"expires_at" TIMESTAMPTZ(6) NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 0,"created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AnnualWish" (
 "person_identity" VARCHAR(100) NOT NULL, "id" UUID PRIMARY KEY,"concretion_code" VARCHAR(10) NOT NULL,"person_kind" VARCHAR(20) NOT NULL,
 "person_code" VARCHAR(50) NOT NULL,"province_code" VARCHAR(10) NOT NULL,"event" VARCHAR(20) NOT NULL,
 "year" INTEGER NOT NULL,"status" VARCHAR(20) NOT NULL DEFAULT 'Processing',"attempts" INTEGER NOT NULL DEFAULT 1,"smtp_started_at" TIMESTAMPTZ(6),
 "sent_at" TIMESTAMPTZ(6),"last_error" TEXT,"created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AnnualWish_concretion_code_person_kind_person_code_province_c_key" UNIQUE("concretion_code","person_kind","person_code","province_code","event","year")
);

CREATE UNIQUE INDEX "AnnualWish_person_identity_event_year_key" ON "AnnualWish"("person_identity","event","year");
