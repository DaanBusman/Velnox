-- 0.7.39: approval notifications through the browser's Web Push (ADR-062).
ALTER TYPE "credential_kind" ADD VALUE 'PUSH_VAPID_KEY';
ALTER TYPE "credential_kind" ADD VALUE 'PUSH_SUBSCRIPTION';

ALTER TABLE "system_settings"
  ADD COLUMN "push_vapid_public_key" TEXT,
  ADD COLUMN "push_vapid_credential_id" UUID;

CREATE TABLE "push_subscriptions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "credential_id" UUID NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_delivered_at" TIMESTAMPTZ(3),

  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE UNIQUE INDEX "push_subscriptions_credential_id_key" ON "push_subscriptions"("credential_id");
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Removing the credential removes the device: there is one way to forget it.
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
