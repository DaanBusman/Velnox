-- Which version of the Windows image reader last looked at an ISO (0.7.20).
--
-- The editions and languages in a Windows ISO were read once, when the ISO
-- entered the library. An ISO that entered before the reader existed, or that a
-- later reader understands better, kept whatever it had — often nothing — and
-- the template form fell back to a typed edition and a fixed language list.
-- The worker now re-reads every READY ISO whose version is older than its own,
-- at start-up and with each library sweep. Null means never read: every ISO
-- already in the library, which is the point.
ALTER TABLE "library_items" ADD COLUMN "windows_images_version" INTEGER;
