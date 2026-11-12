-- CreateEnum
CREATE TYPE "reasoning_effort" AS ENUM ('off', 'low', 'medium', 'high', 'max');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "provider_kind" ADD VALUE 'openai';
ALTER TYPE "provider_kind" ADD VALUE 'deepseek';
ALTER TYPE "provider_kind" ADD VALUE 'gemini';

-- AlterEnum
ALTER TYPE "step_type" ADD VALUE 'reason';

-- AlterTable
ALTER TABLE "model_configs" ADD COLUMN     "reasoning_effort" "reasoning_effort";
