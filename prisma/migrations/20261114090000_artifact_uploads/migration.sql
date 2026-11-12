-- 업로드 완료 시각 (null = 업로드 대기 — 메시지에 첨부할 수 없다)
ALTER TABLE "artifacts" ADD COLUMN "uploaded_at" TIMESTAMPTZ(3);
