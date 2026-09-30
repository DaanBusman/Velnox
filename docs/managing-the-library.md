# The ISO library

**One place for the installers and disk images your clusters are built from.** The library lives on
the Velnox host and holds ISOs and cloud images for every customer at once. From it, a file is copied
onto any cluster's storage in one step, and a file already on a cluster can be copied back into it.

For who may do what, see [Roles and permissions](permissions.md). For why the library works the way
it does, see ADR-037 and ADR-038 in [Technology decisions](tech-decisions.md). For its disk, see
[The ISO library's disk](deployment.md#the-iso-librarys-disk).

---

## What it holds

| Kind | File names | Used for |
|---|---|---|
| **ISO** | `.iso` | Installers — Windows above all, which has no cloud image. |
| **Disk image** | `.qcow2`, `.raw`, `.img` | Cloud images for Linux — Ubuntu's `.img` files are qcow2 inside. |

Filenames keep to the characters Proxmox keeps: letters, digits, dots, dashes and underscores. Two
files whose names differ only in capitals cannot both be in the library, because some of the
storages Proxmox runs on would make them one file.

**The file is checked, not trusted.** A file named `.iso` has to be an ISO image and a `.qcow2` has to
be a qcow2 disk; an error page saved under an ISO's name fails its check and says so. Every file's
SHA-256 is computed on the way in, and every copy to a cluster is checked against it.

---

## Adding a file

**ISO library** in the sidebar, then **Add a file**. Adding needs `library.manage`, which MSP
administrators and engineers hold: the library is one disk for every customer, so a customer
filling it fills it for everyone.

### From a URL

Paste an `http` or `https` address and choose **Fetch**. The worker downloads it as a job, which you
can follow and cancel. Velnox refuses to fetch from:

- loopback, link-local and multicast addresses, including the cloud metadata address
  `169.254.169.254`;
- the networks Velnox itself runs on, which is where its database and queue are;
- a URL with a username or password in it;
- a redirect from `https` to plain `http`, or a chain of more than five redirects.

Internal file servers on private addresses are allowed — that is where most MSPs keep their ISOs.
The address is shown and logged **without its query string**, because that is where download links
keep their signature.

### From this computer

Choose the file under **From this computer**. It goes up in 32 MiB pieces, and a piece that fails for
a network reason is sent again on its own.

**If the upload is interrupted** — the tab closed, the laptop went to sleep, the connection dropped —
the entry stays in the list as *Arriving*. Choose **Continue upload** on it and pick the same file
again: Velnox asks the server how far it got and carries on from there. It has to be the same name
and the same size, or it is refused as a different file. **Pause** stops sending without losing what
arrived.

An upload nobody continues for a day is removed, bytes and entry, so abandoned halves do not fill
the library.

### When the library is full

Two limits apply, and the refusal names which one and the numbers:

- **The library's own size** (`VELNOX_LIBRARY_MAX_GB`), counting transfers still in progress.
- **Free disk that must remain** (`VELNOX_LIBRARY_MIN_FREE_GB`), because the library shares its disk
  with the database unless it has been given one of its own.

The **Space** panel at the top of the screen shows both. Remove files you no longer need, or ask
whoever runs the server to change the limits — see [The ISO library's disk](deployment.md#the-iso-librarys-disk).

---

## Friendly names

Each file is shown under a name read from its filename: `Windows11_25H2_Dutch.iso` becomes
*Windows 11 Version 25H2* with the language *Dutch* — *Nederlands* for someone using Velnox in Dutch,
because the language is stored as a code and named in the reader's language. The real filename
is always shown underneath, and it is the name every log line and every cluster uses.

Reading a name from a filename is guesswork. If the guess is wrong, **Rename** corrects the title, the
language, or both; the file keeps its name. Leave a field empty to go back to what was read from the
filename.

---

## Copying a file onto a cluster

**Copy to cluster** on a file that is *Ready*. Choose the cluster and a storage; only active storage
that takes that kind of file is offered — `iso` content for ISOs, `import` content for disk images.
A storage marked *(shared)* is the same storage on every node, so one copy serves the cluster.

Copying needs `clusters.manage` **on that cluster**, not a library permission: it writes to the
customer's infrastructure.

The copy is a job with three steps:

1. **Check** — the storage is active, takes that content, has room, and does **not** already have a
   file of that name. An existing file is never overwritten; delete it on the cluster first.
2. **Upload** — sent through Proxmox's own API, over the pinned connection, with the checksum.
   Proxmox checks the file as it arrives and refuses one that does not match.
3. **Confirm** — the file is looked up in Proxmox's own list of the storage and its size compared.

**Cancelled or failed, nothing is left on the node.** Because the check proved the name was free, a
half-written file there afterwards can only be this job's own, and it is deleted.

Disk images go up under a `.qcow2` or `.raw` name, because Proxmox decides how to read an import from
its extension. An Ubuntu `jammy-server-cloudimg-amd64.img` arrives as
`jammy-server-cloudimg-amd64.qcow2`.

---

## Files on a cluster

A cluster's page has an **ISOs & images** tab: every ISO and importable disk image on its storage, as
the last discovery run saw them, with **In library** saying whether the library has the same file. A
copy or deletion made through Velnox updates the list when it finishes; a change made in Proxmox
itself shows at the next discovery run.

**Delete** removes the file from the cluster's storage, as a job. The library's copy is left alone.
Deleting needs `clusters.manage` on that cluster.

**Removing a file from the library** does the opposite: the library copy goes, and copies already on
clusters stay where they are.

---

## Copying a file from a cluster into the library

Proxmox's API can put a file on a storage and delete one, but has no way to hand one back. So **Copy
to library** on the **ISOs & images** tab needs **SSH** on that cluster, set up once, under the
cluster's **Connection** tab. Everything else in Velnox works without it.

### What Velnox does over SSH

It opens SFTP and reads one file. It never runs a command and never opens a shell. The account can
therefore be one that may do nothing else, and should be — on each node:

```
Match User velnox-sftp
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
```

in `/etc/ssh/sshd_config`, with read access to the storage directories — `/var/lib/vz/template/iso`
and `/var/lib/vz/import` for the `local` storage.

### Setting it up

1. **Read host keys.** Velnox connects to every online node and records the key it presents, **without
   logging in**: no account and no key are offered to a node nobody has confirmed.
2. **Compare** each fingerprint with the node itself before confirming it:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

3. Enter the **username** and the **private key** whose public half is in that account's
   `authorized_keys`, and a passphrase if the key has one.
4. **Save and trust the confirmed nodes.** Velnox stores the key encrypted and proves it opens SFTP on
   every confirmed node. If any node refuses, nothing is saved and the previous set-up, if there was
   one, stays as it was.

The private key is never shown again, by any screen or any API call. **Replace key** starts the same
steps with a new one; **Remove SSH** deletes the key and the pinned host keys.

**A node whose host key changes is refused**, the same way a changed TLS certificate is. After
reinstalling a node, set SSH up again and confirm its new key deliberately. A node added to the
cluster later has no confirmed key and is not connected to until you do the same.

### The copy

A job: it asks Proxmox where the file is, copies it over SFTP into the library, and runs the same
check as any other file coming in. Cancelled or failed, nothing is left in the library.

---

## Where it goes wrong

| What you see | What it means |
|---|---|
| *The library would grow past its limit* | The library's own size limit. Remove files, or raise `VELNOX_LIBRARY_MAX_GB`. |
| *That would leave … below the minimum that must stay free* | The disk is nearly full. Free space on the host, or lower `VELNOX_LIBRARY_MIN_FREE_GB`. |
| *… is not what its name says* | The bytes do not match the extension. Usually an error page saved under an ISO's name — open the URL in a browser. |
| *Velnox will not fetch from that address* | One of the refusals under [From a URL](#from-a-url). |
| *… is already on that storage* | Delete it on the cluster first; Velnox does not overwrite. |
| *Storage … does not take … content* | Enable `ISO image` or `Import` content on the storage in Proxmox, or pick another. |
| *Proxmox received … with a different checksum* | The file changed in transit. Copy it again; if it repeats, suspect the network path. |
| *The file has gone from the library's disk* | Something removed it on the host. Remove the entry and add the file again. |
| *This upload was never finished* | It sat unfinished for a day and was removed. |
| *Copying a file into the library needs SSH* | Set SSH up under the cluster's **Connection** tab. |
