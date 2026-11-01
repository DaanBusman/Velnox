# Installing Velnox as an app

**Velnox in a window of its own, with its own icon in the Start menu and the taskbar — installed
from the browser, with nothing to download.** The app is the same interface as in a browser tab,
signed in the same way; it only leaves the browser's address bar and tabs behind.

For why it is built this way rather than as a separate program, see ADR-058 in
[Technology decisions](tech-decisions.md).

---

## Installing

1. Open Velnox in **Microsoft Edge** or **Google Chrome** and sign in.
2. Open the user menu — your name, top right — and choose **Install as app**. The browser asks
   whether to install; confirm. The browser's own install icon in the address bar does the same.
3. Velnox opens in its own window, and is in the Start menu. Right-click its taskbar icon to pin
   it.

The app shares the browser profile it was installed from: signed in there is signed in here, and
signing out in one signs out the other. To remove it, open the **⋯** menu in the app's title bar
and choose **Uninstall**, or remove it under **Settings → Apps** in Windows.

Other browsers: Safari on macOS adds any page to the Dock with **File → Add to Dock**; Firefox keeps
Velnox in a tab.

## When there is no "Install as app"

The menu shows the item only when the browser offers to install. It does not offer when:

- Velnox is already installed — the menu item is gone in the app itself;
- the window is a private one;
- the browser is not Edge or Chrome;
- the browser does not trust the server's certificate. The menu then says so: *Installing as an
  app needs a certificate this browser trusts.*

**A trusted certificate.** Browsers install an app only from HTTPS they trust. With a Let's Encrypt
certificate or one of your own (see [Certificates](deployment.md#certificates)) that is already the
case. With the self-signed certificate — the installer's default — each workstation has to trust
the certificate authority Caddy made for this installation. Export its root certificate on the
Velnox host:

```bash
cd /opt/velnox && sudo docker compose -f deploy/compose/docker-compose.yml --env-file .env exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > velnox-root.crt
```

and import `velnox-root.crt` on the workstation into **Trusted Root Certification Authorities**
(Windows: open it, **Install Certificate → Local Machine**); for many workstations, through Group
Policy. Then restart the browser.

Trusting a root is a decision, not a formality: the workstation then trusts any certificate that
authority signs, and its key is on the Velnox host. When that is more than you want, use Let's
Encrypt or your own certificate instead.

## What is kept on the computer

Only the interface's own program files — its JavaScript, styles and icons, the same for every user
and named by their content. Never an answer from the API, a page, or anything of a customer or
tenant: Velnox is used on shared workstations, and nothing of a session may stay behind on one.

- **Signing out** clears what was kept. The sign-in page that follows keeps its own program files
  again, and nothing else.
- **A new version of Velnox** replaces them: the old version's files are removed.
- **Without a connection to the server**, the app shows a page that says Velnox cannot be reached —
  nothing from before.

## After the server is updated

An open window notices the new version when it is next brought to the front, and offers
**Reload**. Until then it goes on working with the version it was opened with.

## Does it take load off the server?

Hardly. The app reads the same data from the same server as a browser tab; only its program files
come from the disk instead of the network, which a browser's own cache mostly did already. What
costs the server is each open screen reading its data again on an interval; replacing that with
updates only when something changed is the next piece of work.

## Troubleshooting

| What you see | What it means |
|---|---|
| *Installing as an app needs a certificate this browser trusts.* | The browser refused the app's background script, as it does on a certificate it does not trust. See [a trusted certificate](#when-there-is-no-install-as-app). |
| No **Install as app** in the menu, and no message | The browser does not offer it: not Edge or Chrome, a private window, or already installed. |
| *Velnox cannot be reached* | The computer has no connection to the Velnox server. **Try again** once it has. |
| *Velnox has been updated. Reload to use the new version.* | The server runs a newer version than the open window. **Reload**. |
