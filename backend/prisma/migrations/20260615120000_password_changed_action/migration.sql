-- Add PASSWORD_CHANGED to the AuditAction enum for the authenticated
-- change-password flow. ALTER TYPE ... ADD VALUE can't run inside a
-- transaction block, but Prisma runs each migration statement separately so
-- this is fine. IF NOT EXISTS makes it idempotent.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_CHANGED';
