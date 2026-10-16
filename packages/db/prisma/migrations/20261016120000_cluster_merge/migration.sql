-- Merging clusters (ADR-055). Two servers added to Velnox one by one and
-- joined into one Proxmox cluster afterwards are two registrations of the
-- same cluster: the name Proxmox gives it, read at every discovery, is what
-- says so.

ALTER TABLE "clusters" ADD COLUMN "pve_cluster_name" TEXT;
