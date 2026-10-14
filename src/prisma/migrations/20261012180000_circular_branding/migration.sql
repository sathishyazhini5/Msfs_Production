ALTER TABLE "Circular" ADD COLUMN "circular_type" VARCHAR(20) NOT NULL DEFAULT 'Circular';
ALTER TABLE "Circular" ADD COLUMN "signature" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Circular" ADD COLUMN "content_snapshot" JSONB;
ALTER TABLE "Circular" ADD CONSTRAINT "Circular_type_check" CHECK ("circular_type" IN ('Circular', 'Newsletter', 'Others'));
CREATE TABLE "CongregationBranding" (
  "concretion_code" VARCHAR(10) PRIMARY KEY,
  "logo_key" TEXT,
  "mime_type" TEXT,
  "sha256" TEXT,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CongregationBranding_congregation_fkey" FOREIGN KEY ("concretion_code") REFERENCES "concretion_defination_mst"("concretion_code") ON DELETE CASCADE
);
