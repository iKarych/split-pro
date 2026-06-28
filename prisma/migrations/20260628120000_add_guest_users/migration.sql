ALTER TABLE "public"."User"
ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "guestCreatedById" INTEGER;

CREATE INDEX "User_isGuest_idx" ON "public"."User"("isGuest");