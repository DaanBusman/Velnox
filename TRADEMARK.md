# Velnox Trademark Policy

Velnox is free software licensed under the **GNU Affero General Public License, version 3**
(see [LICENSE](LICENSE)). That licence grants broad rights to use, modify and redistribute the
*software*. It grants **no rights to the trademarks**. This document explains the difference.

---

## Marks

**Velnox™**, the Velnox name, and the Velnox logo are trademarks of **The Velnox Foundation**.

---

## What you may do without asking

- Use the software for any purpose, including commercially — for example, an MSP running Velnox to
  manage its customers' Proxmox environments.
- Modify the source and run your modified version.
- Redistribute the software, modified or unmodified, under the terms of the AGPLv3.
- State accurately that your product, service or fork **is based on**, **is compatible with**, or
  **is derived from** Velnox. Nominative use — naming the project to refer to it truthfully — is
  always permitted.
- Publish articles, tutorials, reviews, screenshots and training material about Velnox.

## What requires permission from The Velnox Foundation

- Using "Velnox" (or a confusingly similar name) as the **name of your own product or service**, or
  in a domain name, company name or app-store listing.
- Using the Velnox **logo** as the logo of your fork or distribution.
- Any use suggesting that The Velnox Foundation **endorses, sponsors, certifies or supports** your
  product, fork, service or organisation.
- Offering "Velnox" as a hosted or managed service under that name.

## Forks and modified versions

The AGPLv3 gives you the right to fork. Please give your fork **its own name**. You may — and
should — say "a fork of Velnox" in your description; just do not present it *as* Velnox, because
users would attribute your changes, and any defects in them, to this project.

If you distribute a modified version under a different name, remove the Velnox name and logo from
the user interface and from your marketing. Velnox is built to make this easy: the product name is
read at runtime from `system_settings.product_name` rather than hardcoded, and all branding assets
are isolated so they can be replaced without touching application code.

**One thing stays.** The AGPLv3 permits requiring that certain notices be preserved, and Velnox
exercises that (section 7(b) — the terms are in [NOTICE](NOTICE)). Whatever you call your version,
the Appropriate Legal Notices must keep showing:

> Powered by Velnox — Copyright (C) The Velnox Foundation.
> Free software under the GNU Affero General Public License, version 3 or later.

Velnox displays it on **Settings → About** and returns it from `GET /api/v1/system/source`. It comes
from a constant in the source rather than from any setting, precisely so that the party it binds
cannot configure it away.

This is not a trademark restriction and it does not conflict with anything above — it is nominative
use, which this policy already permits without asking. Renaming the product is your right; erasing
where it came from is not.

## Commercial licensing

The AGPLv3 is not the only way to have Velnox. If you want to distribute it, embed it, or offer it
as a service **without** the AGPLv3's obligation to publish your modifications and offer source to
your users, that is available under a separate commercial licence — including under your own name
and branding.

The Velnox Foundation is the sole copyright holder, which is what makes that possible. See
[CLA.md](CLA.md) for how contributions keep it possible.

## Contact

Trademark questions, permission requests and commercial licensing: The Velnox Foundation.

---

## Third-party marks referenced by this project

Velnox integrates with products owned by others. Their marks belong to them, and Velnox is not
affiliated with, endorsed by, or sponsored by any of them:

- Proxmox®, Proxmox VE® and Proxmox Backup Server® — Proxmox Server Solutions GmbH
- Ceph® — the Ceph Foundation / Linux Foundation
- VMware®, ESXi™ and vSphere® — Broadcom Inc.
- Microsoft®, Hyper-V®, Azure®, Entra ID™ and Windows® — Microsoft Corporation
- Debian® — Software in the Public Interest, Inc.
- Docker® — Docker, Inc.
- PostgreSQL® — the PostgreSQL Community Association
- HashiCorp® and Vault® — HashiCorp, Inc.

These names are used nominatively, to describe what Velnox interoperates with.
