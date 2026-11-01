-- CreateTable
CREATE TABLE IF NOT EXISTS "UsageCounter" (
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("userId","feature","period")
);


-- CreateTable
CREATE TABLE IF NOT EXISTS "UsageOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageOperation_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE IF NOT EXISTS "MediaAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "legacyUrl" TEXT,
    "bytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex

-- CreateIndex

-- CreateIndex

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UsageOperation_state_expiresAt_idx" ON "UsageOperation"("state", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UsageOperation_userId_feature_period_idx" ON "UsageOperation"("userId", "feature", "period");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_storagePath_key" ON "MediaAsset"("storagePath");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaAsset_userId_idx" ON "MediaAsset"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MediaAsset_legacyUrl_idx" ON "MediaAsset"("legacyUrl");


-- Only the trusted API database role accesses application records. Firebase clients use the API.
ALTER TABLE "UsageCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClothingItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Outfit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutfitItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Trip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhitelistedEmail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "UsageCounter", "UsageOperation", "MediaAsset", "User", "ClothingItem", "Outfit", "OutfitItem", "Trip", "WhitelistedEmail", "EmailTemplate" FROM anon, authenticated;

-- A restrictive policy also protects private buckets if an older permissive policy exists.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='clad_private_api_only') THEN
    CREATE POLICY clad_private_api_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
      USING (bucket_id NOT IN ('clad-private','wardrobe-images'))
      WITH CHECK (bucket_id NOT IN ('clad-private','wardrobe-images'));
  END IF;
END $$;
