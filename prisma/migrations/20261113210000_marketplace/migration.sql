-- Marketplace — 테넌트 간 공유 목록 (RLS 없음: 모든 테넌트가 읽고, 게시 테넌트만 바꾼다는 규칙은 서비스가 지킨다)
CREATE TABLE "marketplace_listings" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "publisher_tenant_id" UUID NOT NULL,
    "publisher_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    "latest_version" TEXT NOT NULL,
    "install_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "marketplace_listings_kind_check" CHECK ("kind" IN ('skill', 'mcp')),
    CONSTRAINT "marketplace_listings_status_check" CHECK ("status" IN ('published', 'withdrawn'))
);
CREATE UNIQUE INDEX "marketplace_listings_kind_name_key" ON "marketplace_listings"("kind", "name");
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_publisher_tenant_id_fkey" FOREIGN KEY ("publisher_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "marketplace_versions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marketplace_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "marketplace_versions_listing_id_version_key" ON "marketplace_versions"("listing_id", "version");
ALTER TABLE "marketplace_versions" ADD CONSTRAINT "marketplace_versions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "marketplace_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "skills" ADD COLUMN "marketplace_listing_id" UUID;
ALTER TABLE "skills" ADD CONSTRAINT "skills_marketplace_listing_id_fkey" FOREIGN KEY ("marketplace_listing_id") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "marketplace_listings", "marketplace_versions" TO app_rw, app_maintenance;
