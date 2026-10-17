-- Remove first-login gating without touching any member or administrator password.
UPDATE "MemberAccess" SET "password_change_required" = false
WHERE "password_change_required" = true;
