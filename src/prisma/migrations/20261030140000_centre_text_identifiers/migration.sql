-- Existing numeric values cannot recover leading zeros already lost.
ALTER TABLE "centre_dtl"
  ALTER COLUMN "pin_zipcode" TYPE VARCHAR(32) USING "pin_zipcode"::text,
  ALTER COLUMN "phone1_no" TYPE VARCHAR(40) USING "phone1_no"::text,
  ALTER COLUMN "phone2_no" TYPE VARCHAR(40) USING "phone2_no"::text,
  ALTER COLUMN "phone3_no" TYPE VARCHAR(40) USING "phone3_no"::text,
  ALTER COLUMN "mobile1_no" TYPE VARCHAR(40) USING "mobile1_no"::text,
  ALTER COLUMN "mobile2_no" TYPE VARCHAR(40) USING "mobile2_no"::text,
  ALTER COLUMN "mobile3_no" TYPE VARCHAR(40) USING "mobile3_no"::text,
  ALTER COLUMN "watsup_no" TYPE VARCHAR(40) USING "watsup_no"::text,
  ALTER COLUMN "fax_no" TYPE VARCHAR(40) USING "fax_no"::text;
ALTER TABLE "centre_dtl" ALTER COLUMN "phone1_isd" TYPE VARCHAR(5);
