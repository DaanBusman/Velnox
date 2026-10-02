# Building VMs from templates

**A template says what a VM should be; Velnox builds it and sees the install through.** Windows
installs itself from its ISO with an answer file Velnox writes; Linux starts from a cloud image and
configures itself on first boot. Nobody presses a key, and the person who asked gets a mail when it
is ready.

For who may do what, see [Roles and permissions](permissions.md). For why it works the way it does,
see ADR-039 in [Technology decisions](tech-decisions.md). The installers and cloud images come from
[the ISO library](managing-the-library.md).

---

## What it needs first

- **The files in the library.** A Windows ISO, and the VirtIO drivers ISO (`virtio-win.iso`, from
  the Fedora project) if the template uses VirtIO or the guest agent. For Linux, a cloud image:
  Ubuntu's `*-server-cloudimg-amd64.img` or Debian's `*-genericcloud-amd64.qcow2`.
- **Storage on the node** that takes `images` for the VM's disks, and one that takes `iso` — and, for
  Linux, `import` — for the installer, the cloud image and the answer CD. The `local` storage takes
  `iso`; `import` has to be switched on for it under *Datacenter → Storage* (Proxmox VE 8.2 or later).
- **More than reading from the Proxmox token.** Building a VM writes to the cluster. The token needs,
  as we understand Proxmox's privileges — check them against your version:

  | Role, on | For |
  |---|---|
  | `PVEAuditor` on `/` | the inventory, as before |
  | `PVEDatastoreUser` on `/storage` (or the storages used) | putting installers and answer CDs on storage, and deleting them |
  | `PVEVMAdmin` on `/vms` (or a pool) | creating, starting, configuring and destroying the VM, and its guest agent |
  | `PVESDNUser` on `/sdn/zones/localnetwork` | connecting the VM to a bridge |

- **Outgoing mail**, if anyone is to be told — see [Outgoing mail](#outgoing-mail).

---

## Templates

**Administration → Autoconfig.** A template belongs to the MSP or to one customer:

- An **MSP template** marked *every customer* is offered to every tenant; marked *its owner only*, it
  is for MSP staff, who can still build from it for any customer.
- A **customer's template** is theirs alone. No other customer sees it.

Seeing a template is not changing it. A customer can build from an MSP template, and **Clone** it to
make one of their own that they can change; the copy does not follow the original afterwards.

Changing templates needs `autoconfig.manage` — on the MSP for MSP templates, on the tenant for a
customer's own.

### Passwords and keys

Each account's password is one of:

- **Generated for each VM** — the default and the recommendation. Every VM gets its own, so one
  leaked record opens one machine.
- **Fixed on this template** — typed once, stored encrypted, used for every VM. At least twelve
  characters, with three of upper case, lower case, digits and symbols, because Windows applies that
  rule during Setup where nobody would see it fail.
- **None** (Linux) — a key-only account.

A stored password or product key is never shown again. The template says *Stored*, and you can
replace or remove it. **A clone does not take the original's stored passwords** — they could not be
copied without being read, and an MSP's should not reach a customer that way. The clone lists them as
missing until they are set, and cannot build until then.

### Windows

- **Installer and edition.** Choose the ISO; the editions listed are read from the ISO itself, and
  Setup installs the one with exactly that name. If the list could not be read, the name is typed —
  and must match the ISO exactly, or Setup installs the first edition instead.
- **VirtIO drivers and the guest agent.** On by default. They install from the VirtIO ISO, and Velnox
  needs the agent to see that the install has finished.
- **GPT** is recommended and Windows 11 requires it: the VM gets UEFI, Secure Boot keys and a TPM.
- **Product key.** Without one, Setup does not stop to ask; Windows asks at activation when the
  edition needs a key.
- **Region and language** are four settings, not one: display language (it must be a language the ISO
  has), system locale, formats, keyboard. Dutch input on US-International is a choice of its own. The
  time zone is separate again.
- **Accounts.** The built-in Administrator always gets a password — Windows Server requires one. On a
  desktop edition it is switched off after the first logon, so at least one account here must be an
  administrator.
- **System.** Workgroup, Remote Desktop with its firewall rule, the power plan, hibernation, and
  whether Windows Update runs during Setup (an hour) or afterwards (minutes).

### Linux

- **Cloud image** and **distribution**.
- **Package mirror.** Recommended is Debian's CDN (`deb.debian.org`) or Ubuntu's geo-selecting list —
  never one fixed server by default, because a fixed mirror is a single point of failure. A national
  mirror is offered as a choice; an APT proxy can be set.
- **Accounts** are sudo users; extra accounts are users, not more roots. **SSH public keys** go one per
  line. Root login stays off unless you turn it on, and then root logs in with a key only, unless
  password logins are allowed as well.
- **The SSH switch**, on by default: the server installed and running, the keys placed, password
  logins off unless allowed, and port 22 opened where the image runs a firewall.
- Locale, keyboard and time zone, extra packages, a swap file, unattended security upgrades.

### How the passwords reach the requester

- **Only in Velnox** — the default. The mail links to the VM; the passwords are shown in Velnox.
- **In an encrypted PDF** — the mail carries the installation record with the passwords, encrypted
  with AES-256. Its password is **never in the same mail**: either it is shown once, to whoever asks
  for the VM, right after they ask; or it is set on the template by an administrator, and passed on
  some other way.

---

## Building a VM

**Infrastructure → New VMs → Build a VM** (or **Build a VM** on a template). Needs
`workloads.provision` on the cluster. Choose the cluster, a template offered to its tenant, the
node, the storage for the disks and for the installer, the bridge and an optional VLAN, a hostname
— without a domain; at most 15 characters for Windows, whose network name is cut off there — and
DHCP or a fixed address.

Velnox refuses before anything starts when something cannot work: a template with secrets missing, a
name a VM on the cluster already has, storage that does not take the right content, a bridge the
node does not have, an edition the ISO does not have, a notification with mail not set up.

Then it runs as a job you can follow and cancel:

1. **Check** the node is online and the storage and bridge are what the form said.
2. **Media** — the installer or cloud image is copied from the library to the node if it is not
   there yet. It stays for the next VM.
3. **Create** the VM, with the template's hardware.
4. **Answers** — the passwords are decided, the answer file is written for this VM's network card,
   put on a small CD and attached.
5. **Start** — for Windows on UEFI, Enter is pressed at the boot prompt.
6. **Install** — Velnox waits until the guest agent reports the marker the answer file writes last.
   Up to three hours for Windows, forty-five minutes for Linux.
7. **Finish** — the addresses are read, every CD is ejected, and the answer CD is deleted from the
   storage. It held the passwords.
8. **Notify** — once, to whoever asked.

**If it fails or is cancelled, the VM is destroyed** with its disks, the answer CD is deleted, and the
passwords are dropped. If Velnox could not destroy the VM, the record says so with its VM ID — remove
it in Proxmox.

---

## The record, and the passwords

**New VMs** lists what was built. A record shows the template, cluster and node, the VM ID, the
addresses the guest reported, who asked, how long it took, and why it failed if it did.

**Show the passwords**, for whoever may manage that cluster (`clusters.manage`): each time is
written to the audit log — attempts that are refused too — and the passwords disappear from the
page after five minutes. They are kept for **thirty days** after the VM is ready, then deleted;
after that the record says they are no longer kept. Change them on the VM before then.

---

## Outgoing mail

**Administration → Outgoing mail**, for `system.manage`. In this order:

1. **Save** the server: host, port, encryption, sender, and a username and password if the server
   needs them. STARTTLS is required when chosen — a server that does not offer it is refused, not
   used in plain text. *None* is for a relay on the same host or a lab only.
2. **Send a test.** The worker sends it, with the stored settings, as it will send every mail.
3. **Switch mail on.** Not possible before a test has gone out with these settings; changing the
   server switches mail off again until the next test.

The password is never shown again.

---

## Where it goes wrong

| What you see | What it means |
|---|---|
| *Secrets missing* on a template | Fixed passwords or a key the settings call for are not stored — typical for a clone. Open it and set them. |
| *… has no edition called …* | The template names an edition the ISO does not have. Choose one from the list. |
| *Storage … does not take … content* | Enable the content type on the storage in Proxmox, or choose another. |
| *Node … has no bridge called …* | Choose a bridge that exists on that node. |
| *A VM on this cluster is already called …* | Choose another hostname. |
| *Outgoing mail is not set up* | Untick the mail, or have an administrator set it up. |
| The job waits at **Install** for a long time | Open the VM's console in Proxmox. Setup stopped at a question means the answer file did not cover it — most often a display language the ISO does not have. |
| *The installation did not report back within … minutes* | The guest agent never answered: the VirtIO ISO or the agent switch was off, or Setup stopped. The VM was removed. |
| *… could not be removed* | Remove the VM in Proxmox by the VM ID on the record. |
| *The passwords of this VM are no longer kept* | Thirty days have passed, or the build failed. |
