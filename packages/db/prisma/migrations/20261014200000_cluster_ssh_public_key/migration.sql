-- The public half of a cluster's SSH key, in authorized_keys form, so the
-- interface can show it again: where to put it is the first thing an operator
-- setting SSH up needs. Read from the private key by the worker; public by
-- nature. Null for a key stored before this, until it is read once.

ALTER TABLE "clusters" ADD COLUMN "ssh_public_key" TEXT;
