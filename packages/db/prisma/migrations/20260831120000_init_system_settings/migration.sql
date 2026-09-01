-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "mfa_policy" AS ENUM ('OPTIONAL', 'REQUIRED_FOR_PRIVILEGED', 'REQUIRED');

-- CreateTable
CREATE TABLE "system_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "initialized_at" TIMESTAMPTZ(3),
    "instance_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL DEFAULT 'Velnox',
    "base_url" TEXT,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "default_timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "mfa_policy" "mfa_policy" NOT NULL DEFAULT 'OPTIONAL',
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "source_url" TEXT,
    "feature_flags" JSONB NOT NULL DEFAULT '{}',
    "retention" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);


-- Enforce the settings singleton.
-- docs/database-schema.md: exactly one row, id = 1. Prisma's schema language
-- cannot express a CHECK constraint, so it is added here. It is part of the
-- migration, so a shadow-database replay reproduces it and drift detection stays
-- accurate.
ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_singleton" CHECK ("id" = 1);
