/**
 * The storage half of the fixture Proxmox, for Phase 5A.
 *
 * Loaded by fake-pve.mjs only when it is given `--storage-dir`, so the Phase 4
 * harness sees exactly the cluster it always saw. What it adds is what the ISO
 * library talks to:
 *
 *   - storage listings, status and content, backed by real files on disk;
 *   - the multipart upload, parsed as it streams, with the checksum checked
 *     the way Proxmox checks it — in the task that moves the file into place;
 *   - volume attributes and delete;
 *   - tasks, which those return;
 *   - optionally, an SFTP server that serves the same files.
 *
 * What it gets deliberately *awkward* is the same idea as the rest of the
 * fixture: an upload can be slowed (`--upload-bytes-per-sec`) so cancelling
 * one halfway is a thing a test can do; an aborted upload leaves its temporary
 * file only until the socket closes, like pveproxy; and every byte an upload
 * delivers is counted and logged, so a harness can prove that a node which
 * failed the certificate pin received none.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const FORMAT_FOR = {
  '.iso': 'iso',
  '.qcow2': 'qcow2',
  '.raw': 'raw',
  '.vmdk': 'vmdk',
  '.ova': 'ova',
};
const EXTENSIONS = { iso: ['.iso'], import: ['.qcow2', '.raw', '.vmdk', '.ova'] };

export function installStorage({ dir, nodes, uploadBytesPerSec, log }) {
  const STORAGES = {
    local: { type: 'dir', shared: 0, content: 'iso,vztmpl,backup,import', total: 107_374_182_400 },
    'nfs-iso': { type: 'nfs', shared: 1, content: 'iso,import', total: 2_199_023_255_552 },
    // Takes images only: pushing an ISO here must be refused before a byte moves.
    'ceph-vm': { type: 'rbd', shared: 1, content: 'images,rootdir', total: 10_995_116_277_760 },
  };

  const root = (node, storage) =>
    STORAGES[storage].shared ? join(dir, 'shared', storage) : join(dir, `node-${node}`, storage);
  for (const node of Object.keys(nodes)) {
    for (const storage of Object.keys(STORAGES)) {
      for (const content of ['iso', 'import'])
        mkdirSync(join(root(node, storage), content), { recursive: true });
    }
  }
  mkdirSync(join(dir, 'tmp'), { recursive: true });

  /** Where Proxmox would say the file lives on the node. SFTP maps these back. */
  const nodePath = (storage, content, filename) =>
    STORAGES[storage].shared
      ? `/mnt/pve/${storage}/${content === 'iso' ? 'template/iso' : 'import'}/${filename}`
      : `/var/lib/vz/${content === 'iso' ? 'template/iso' : 'import'}/${filename}`;

  const used = (node, storage) => {
    let bytes = 0;
    for (const content of ['iso', 'import']) {
      for (const name of readdirSync(join(root(node, storage), content))) {
        bytes += statSync(join(root(node, storage), content, name)).size;
      }
    }
    return bytes;
  };

  const listing = (node, storage) => ({
    storage,
    type: STORAGES[storage].type,
    active: 1,
    enabled: 1,
    shared: STORAGES[storage].shared,
    content: STORAGES[storage].content,
    total: STORAGES[storage].total,
    used: used(node, storage),
    avail: STORAGES[storage].total - used(node, storage),
  });

  const contentOf = (node, storage, only) => {
    const entries = [];
    for (const content of ['iso', 'import']) {
      if (only && only !== content) continue;
      if (!STORAGES[storage].content.split(',').includes(content)) continue;
      for (const name of readdirSync(join(root(node, storage), content))) {
        const info = statSync(join(root(node, storage), content, name));
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
        entries.push({
          volid: `${storage}:${content}/${name}`,
          content,
          format: FORMAT_FOR[ext] ?? 'raw',
          size: info.size,
          ctime: Math.floor(info.mtimeMs / 1000),
        });
      }
    }
    return entries;
  };

  // --- tasks -----------------------------------------------------------------

  const tasks = new Map();
  let pid = 0x1000;
  const newTask = (node, type, exitstatus, lines) => {
    pid += 1;
    const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
    const upid = `UPID:${node}:${hex(pid)}:${hex(0xabc)}:${hex(Math.floor(Date.now() / 1000))}:${type}::root@pam!velnox:`;
    tasks.set(upid, { node, exitstatus, lines });
    return upid;
  };

  // --- the upload ------------------------------------------------------------

  let uploadBytesTotal = 0;

  /**
   * Parse a multipart upload as it streams: fields first, then the file, then
   * the closing boundary — the order pveproxy requires. The file is written to
   * a temporary path, and only a successful task moves it into the storage.
   */
  function handleUpload(request, response, node, storage, send) {
    const boundaryMatch = /boundary=(.+)$/.exec(request.headers['content-type'] ?? '');
    if (!boundaryMatch) return send(response, 400, { data: null, message: 'not multipart' });
    const boundary = Buffer.from(`--${boundaryMatch[1]}`);
    const closing = Buffer.from(`\r\n--${boundaryMatch[1]}--`);

    const temp = join(dir, 'tmp', `upload-${randomBytes(6).toString('hex')}`);
    const fields = {};
    let head = Buffer.alloc(0);
    let inFile = false;
    let filename = null;
    let out = null;
    let tail = Buffer.alloc(0);
    let received = 0;
    let fileBytes = 0;
    const hash = createHash('sha256');
    let finished = false;
    /**
     * Why the upload will be refused, decided as soon as the parameters are in
     * and answered only once the body has all arrived — which is what pveproxy
     * does: it spools the whole upload before the API handler sees a parameter.
     * Answering early and closing a socket with unread data makes TCP reset it,
     * and the reset can take the answer with it.
     */
    let refusal = null;

    const abort = (why) => {
      if (finished) return;
      finished = true;
      out?.destroy();
      rmSync(temp, { force: true });
      log(`upload aborted after ${received} bytes (${why}); temporary file removed`);
    };

    const writeFile = (chunk) => {
      if (chunk.length === 0 || finished) return;
      fileBytes += chunk.length;
      hash.update(chunk);
      out.write(chunk);
    };

    const onData = (chunk) => {
      // A chunk already in flight when the client went away. Its bytes are
      // counted, because they arrived; they go nowhere, because the file is gone.
      received += chunk.length;
      uploadBytesTotal += chunk.length;
      if (finished) return;
      if (!inFile) {
        head = Buffer.concat([head, chunk]);
        // Fields come before the file part.
        const fileHeader = head.indexOf('name="filename"');
        if (fileHeader === -1) return;
        const headerEnd = head.indexOf('\r\n\r\n', fileHeader);
        if (headerEnd === -1) return;
        const text = head.subarray(0, fileHeader).toString('utf8');
        for (const part of text.split(boundary.toString())) {
          const m = /name="([^"]+)"\r\n\r\n([^\r]*)\r\n/.exec(part);
          if (m) fields[m[1]] = m[2];
        }
        filename =
          /filename="([^"]+)"/.exec(head.subarray(fileHeader, headerEnd).toString())?.[1] ?? null;
        const content = fields.content;
        const ext = filename ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
        if (!filename || !EXTENSIONS[content]?.includes(ext)) {
          refusal = `wrong file extension for ${content}`;
        } else if (!STORAGES[storage].content.split(',').includes(content)) {
          refusal = `storage '${storage}' does not support content-type '${content}'`;
        }
        inFile = true;
        out = createWriteStream(temp);
        // A write racing an abort must not take the fixture down with it.
        out.on('error', () => undefined);
        tail = head.subarray(headerEnd + 4);
        head = Buffer.alloc(0);
      } else {
        tail = Buffer.concat([tail, chunk]);
      }
      // Hold back enough to find the closing boundary when the body ends.
      if (tail.length > closing.length + 8) {
        writeFile(tail.subarray(0, tail.length - closing.length - 8));
        tail = tail.subarray(tail.length - closing.length - 8);
      }
    };

    // Optionally slow, so a harness can cancel an upload halfway.
    if (uploadBytesPerSec > 0) {
      request.on('data', (chunk) => {
        onData(chunk);
        request.pause();
        setTimeout(() => request.resume(), Math.ceil((chunk.length / uploadBytesPerSec) * 1000));
      });
    } else {
      request.on('data', onData);
    }

    request.on('aborted', () => abort('client went away'));
    request.on('close', () => {
      if (!request.complete) abort('connection closed');
    });

    request.on('end', () => {
      if (finished) return;
      const end = tail.indexOf(closing);
      writeFile(end === -1 ? tail : tail.subarray(0, end));
      finished = true;
      out.end(() => {
        log(
          `upload received ${received} bytes (${fileBytes} of file) for ${storage}:${fields.content}/${filename}`,
        );
        if (refusal) {
          rmSync(temp, { force: true });
          return send(response, 400, { data: null, message: refusal });
        }
        const digest = hash.digest('hex');
        const target = join(root(node, storage), fields.content, filename);
        let upid;
        if (
          fields.checksum &&
          fields['checksum-algorithm'] === 'sha256' &&
          fields.checksum !== digest
        ) {
          rmSync(temp, { force: true });
          upid = newTask(node, 'imgcopy', 'checksum verification failed', [
            `expected ${fields.checksum}`,
            `got ${digest}`,
            'TASK ERROR: checksum verification failed',
          ]);
        } else if (existsSync(target)) {
          rmSync(temp, { force: true });
          upid = newTask(node, 'imgcopy', 'refusing to override existing file', [
            'TASK ERROR: file exists',
          ]);
        } else {
          renameSync(temp, target);
          upid = newTask(node, 'imgcopy', 'OK', [
            `target file: ${target}`,
            `file size is: ${fileBytes}`,
            'TASK OK',
          ]);
        }
        send(response, 200, { data: upid });
      });
    });
  }

  // --- routes ------------------------------------------------------------------

  /** Returns true when it answered. */
  return {
    uploadBytesTotal: () => uploadBytesTotal,
    storageList: (node) => Object.keys(STORAGES).map((storage) => listing(node, storage)),
    root,
    nodePath,
    handle(request, response, node, rest, query, send) {
      const method = request.method ?? 'GET';

      const task = /^tasks\/([^/]+)(?:\/(status|log))?$/.exec(rest);
      if (task) {
        const upid = decodeURIComponent(task[1]);
        const found = tasks.get(upid);
        if (!found) {
          send(response, 404, { data: null, message: 'no such task' });
          return true;
        }
        if (method === 'DELETE') {
          send(response, 200, { data: null });
          return true;
        }
        if (task[2] === 'log') {
          send(response, 200, { data: found.lines.map((t, n) => ({ n: n + 1, t })) });
          return true;
        }
        send(response, 200, {
          data: { upid, node, status: 'stopped', exitstatus: found.exitstatus, type: 'imgcopy' },
        });
        return true;
      }

      const storageMatch = /^storage\/([^/]+)(?:\/(status|upload|content)(?:\/(.+))?)?$/.exec(rest);
      if (!storageMatch) return false;
      const [, storage, action, volumeRaw] = storageMatch;
      if (!STORAGES[storage]) {
        send(response, 500, { data: null, message: `storage '${storage}' does not exist` });
        return true;
      }

      if (action === 'status') {
        send(response, 200, { data: listing(node, storage) });
        return true;
      }
      if (action === 'upload' && method === 'POST') {
        handleUpload(request, response, node, storage, send);
        return true;
      }
      if (action === 'content' && !volumeRaw && method === 'GET') {
        send(response, 200, { data: contentOf(node, storage, query.get('content')) });
        return true;
      }
      if (action === 'content' && volumeRaw) {
        const volid = decodeURIComponent(volumeRaw);
        const m = /^([^:]+):(iso|import)\/(.+)$/.exec(volid);
        const file = m && m[1] === storage ? join(root(node, storage), m[2], m[3]) : null;
        if (!file || !existsSync(file)) {
          send(response, 500, { data: null, message: `volume '${volid}' does not exist` });
          return true;
        }
        if (method === 'DELETE') {
          rmSync(file);
          log(`deleted ${volid} on ${node}`);
          send(response, 200, { data: newTask(node, 'imgdel', 'OK', ['TASK OK']) });
          return true;
        }
        const ext = m[3].slice(m[3].lastIndexOf('.')).toLowerCase();
        send(response, 200, {
          data: {
            path: nodePath(storage, m[2], m[3]),
            size: statSync(file).size,
            format: FORMAT_FOR[ext] ?? 'raw',
            used: statSync(file).size,
          },
        });
        return true;
      }
      return false;
    },
  };
}

/**
 * An SFTP server over the same files, if ssh2 can be found.
 *
 * Read only. Every session request is logged, and an exec or shell request is
 * refused *and* logged as `EXEC ATTEMPTED`, so a harness can assert Velnox never
 * asks for one.
 */
export function startSftp({ port, hostKey, authorizedKey, storage, log, bytesPerSec = 0 }) {
  let ssh2;
  try {
    ssh2 = createRequire('/app/apps/worker/package.json')('ssh2');
  } catch {
    log('ssh2 not available; SFTP disabled');
    return;
  }
  const { Server, utils } = ssh2;
  const allowed = utils.parseKey(authorizedKey);
  const { STATUS_CODE } = utils.sftp;

  /** Map a node path back to a file on disk. Anything else does not exist. */
  const resolve = (path) => {
    if (path.includes('..')) return null;
    let m = /^\/var\/lib\/vz\/(template\/iso|import)\/([^/]+)$/.exec(path);
    if (m) return join(storage.root('pve1', 'local'), m[1] === 'import' ? 'import' : 'iso', m[2]);
    m = /^\/mnt\/pve\/([^/]+)\/(template\/iso|import)\/([^/]+)$/.exec(path);
    if (m) return join(storage.root('pve1', m[1]), m[2] === 'import' ? 'import' : 'iso', m[3]);
    return null;
  };

  new Server({ hostKeys: [hostKey] }, (connection) => {
    connection.on('authentication', (ctx) => {
      if (
        ctx.method === 'publickey' &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.equals(allowed.getPublicSSH())
      ) {
        log(`ssh: accepted key for ${ctx.username}`);
        return ctx.accept();
      }
      log(`ssh: refused ${ctx.method} for ${ctx.username}`);
      ctx.reject(['publickey']);
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (reject, _accept, info) => {
          log(`EXEC ATTEMPTED: ${info.command}`);
          reject();
        });
        session.on('shell', (reject) => {
          log('EXEC ATTEMPTED: shell');
          reject();
        });
        session.on('sftp', (acceptSftp) => {
          log('ssh: sftp session opened');
          const sftp = acceptSftp();
          const open = new Map();
          let next = 1;
          sftp.on('REALPATH', (reqid) =>
            sftp.name(reqid, [{ filename: '/', longname: '/', attrs: {} }]),
          );
          sftp.on('OPEN', (reqid, filename) => {
            const file = resolve(filename);
            if (!file || !fs.existsSync(file)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(next, 0);
            open.set(next, fs.openSync(file, 'r'));
            next += 1;
            log(`ssh: read ${filename}`);
            sftp.handle(reqid, handle);
          });
          const fdOf = (handle) => open.get(handle.readUInt32BE(0));
          sftp.on('READ', (reqid, handle, offset, length) => {
            const fd = fdOf(handle);
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, offset);
            if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            // Optionally slow, so a copy off a node can be cancelled halfway.
            const delay = bytesPerSec > 0 ? Math.ceil((read / bytesPerSec) * 1000) : 0;
            setTimeout(() => sftp.data(reqid, buffer.subarray(0, read)), delay);
          });
          const attrs = (size) => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: 0, mtime: 0 });
          sftp.on('FSTAT', (reqid, handle) =>
            sftp.attrs(reqid, attrs(fs.fstatSync(fdOf(handle)).size)),
          );
          sftp.on('STAT', (reqid, path) => {
            const file = resolve(path);
            if (!file || !fs.existsSync(file)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            sftp.attrs(reqid, attrs(fs.statSync(file).size));
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            if (open.has(id)) fs.closeSync(open.get(id));
            open.delete(id);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
    connection.on('error', () => undefined);
  }).listen(port, '0.0.0.0', () => log(`sftp listening on ${port}`));
}
