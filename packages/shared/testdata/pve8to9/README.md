# pve8to9 golden files

What `pve8to9` prints, for the parser's tests (`src/pve8to9.spec.ts`).

Assembled line by line from `PVE/CLI/pve8to9.pm` on pve-manager's `stable-8` branch — its
`log_*` prefixes, its unprefixed progress lines (including its own spelling, *Analzying*), its
section headers and its summary block — and from findings users have posted on the Proxmox
forum. They are not captured from a running node. When real output is captured, add it here
beside these, named by the pve-manager version that printed it, and keep the tests passing on
both.

- `8.4.1-problems.txt` — pending updates, running guests, the systemd-boot meta-package, local
  LVM autoactivation, settings in `/etc/sysctl.conf`, no Intel microcode.
- `8.4.14-clean-ceph.txt` — Ceph Squid, everything passing, and one line no parser version
  knows, which must come out as `UNKNOWN`.
- `9.0.10-after.txt` — a node after its upgrade.
