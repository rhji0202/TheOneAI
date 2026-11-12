-- Context Compression: 최근 대화 창 밖으로 밀려난 메시지의 누적 요약
ALTER TABLE "conversations" ADD COLUMN "summary" TEXT;
ALTER TABLE "conversations" ADD COLUMN "summary_through_id" UUID;
ALTER TABLE "conversations" ADD COLUMN "summary_updated_at" TIMESTAMPTZ(3);
