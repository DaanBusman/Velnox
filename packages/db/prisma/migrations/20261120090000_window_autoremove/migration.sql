-- 0.7.27: a maintenance window can end every update in it with apt-get autoremove.
ALTER TABLE "maintenance_windows" ADD COLUMN "autoremove" BOOLEAN NOT NULL DEFAULT false;
