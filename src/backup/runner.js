// ===========================================================================
// runner.js - menjalankan backup (vzdump) lewat API Proxmox
//
// "Rencana" (plan) = daftar pekerjaan: { srv, node, vmids, guests }
//   vmids = null      -> backup SEMUA VM & LXC di node itu
//   vmids = [101,102] -> backup VM tertentu saja
//
// Alur: runBackupJob -> backupNode (per node) -> cek storage -> kirim vzdump
//       -> tunggu task selesai -> baca log -> kirim laporan ke Telegram
//
// Opsi per server (servers.json): backupStorage, backupMode, backupCompress,
// backupExclude, backupKeepLast (lihat README.md)
// ===========================================================================
const { servers, backup } = require('../config');
const { pve, pvePost } = require('../proxmox/api');
const { send } = require('../telegram/bot');
const { serverStates } = require('../monitor/state');
const { esc, now, fmtDate, formatDuration } = require('../utils/format');
const { state, save } = require('./state');
const { scheduleSlot } = require('./schedule');
const { guestLabel } = require('./guests');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storageOf = (srv) => srv.backupStorage || 'local';
const keepLastOf = (srv) =>
  srv.backupKeepLast !== undefined ? Number(srv.backupKeepLast) : backup.keepLast;

// Pastikan storage tujuan ada & aktif (mis. HDD sudah ter-mount) sebelum backup.
// Return teks error, atau null kalau aman.
async function checkStorage(srv, node, storage) {
  try {
    const list = await pve(srv, `/nodes/${node}/storage?content=backup`);
    const found = list.find((s) => s.storage === storage);
    if (!found) {
      const avail = list.map((s) => s.storage).join(', ') || '-';
      return `Storage "${storage}" tidak ditemukan / tidak untuk backup di node ${node} (tersedia: ${avail})`;
    }
    if (found.active === 0 || found.enabled === 0) {
      return `Storage "${storage}" tidak aktif (belum ter-mount / dinonaktifkan)`;
    }
    return null;
  } catch (_) {
    return null; // pengecekan gagal -> jangan blokir, biarkan vzdump yang menentukan
  }
}

// Tunggu task Proxmox selesai (cek tiap 15 detik)
async function waitForTask(srv, node, upid) {
  const deadline = Date.now() + backup.timeoutHours * 3600 * 1000;
  const path = `/nodes/${node}/tasks/${encodeURIComponent(upid)}`;
  let errors = 0;
  while (Date.now() < deadline) {
    await sleep(15000);
    try {
      const st = await pve(srv, `${path}/status`);
      errors = 0;
      if (st.status === 'stopped') return { done: true, exitstatus: st.exitstatus };
    } catch (_) {
      if (++errors >= 40) {
        return { done: false, exitstatus: 'API tidak bisa dihubungi saat menunggu backup' };
      }
    }
  }
  return { done: false, exitstatus: `Timeout (> ${backup.timeoutHours} jam)` };
}

// Baca log task: VM mana yang berhasil / gagal, dan berapa backup lama yang dihapus
async function parseBackupLog(srv, node, upid) {
  const res = { okVms: [], failVms: [], removed: 0, tail: [] };
  try {
    const log = await pve(srv, `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log?limit=5000`);
    const lines = log.map((l) => l.t);
    for (const t of lines) {
      let m = /Finished Backup of VM (\d+) \(([^)]+)\)/.exec(t);
      if (m) res.okVms.push(`${m[1]} (${m[2]})`);
      m = /Backup of VM (\d+) failed/.exec(t);
      if (m) res.failVms.push(m[1]);
      if (/removing backup/i.test(t)) res.removed++;
    }
    res.tail = lines.filter((t) => /ERROR|WARN|failed/i.test(t)).slice(-5);
  } catch (_) {}
  return res;
}

// Kerjakan satu item rencana. prune=true -> hapus backup lama setelah backup baru sukses
async function backupNode({ srv, node, vmids }, prune) {
  const started = Date.now();
  const storage = storageOf(srv);
  const base = { srv, node, storage };

  const storageError = await checkStorage(srv, node, storage);
  if (storageError) return { ...base, ok: false, error: storageError, durationMs: 0 };

  const params = {
    storage,
    mode: srv.backupMode || backup.mode,
    compress: srv.backupCompress || backup.compress,
    'notes-template': '{{guestname}} - bot-backup'
  };
  if (vmids) {
    params.vmid = vmids.join(',');
  } else {
    params.all = '1';
    if (Array.isArray(srv.backupExclude) && srv.backupExclude.length) {
      params.exclude = srv.backupExclude.join(',');
    }
  }
  // Hapus backup lama: Proxmox menghapusnya HANYA setelah backup baru VM itu sukses,
  // jadi kalau backup baru gagal, backup lama tetap aman.
  const keepLast = keepLastOf(srv);
  if (prune && keepLast > 0) params['prune-backups'] = `keep-last=${keepLast}`;

  let upid;
  try {
    upid = await pvePost(srv, `/nodes/${node}/vzdump`, params);
  } catch (e) {
    const detail =
      (e.response && e.response.data && JSON.stringify(e.response.data.errors || e.response.data.message)) ||
      e.message;
    return { ...base, ok: false, error: `Gagal memulai backup: ${detail}`, durationMs: Date.now() - started };
  }

  const task = await waitForTask(srv, node, upid);
  const log = await parseBackupLog(srv, node, upid);
  const ok = task.done && task.exitstatus === 'OK' && !log.failVms.length;
  return { ...base, ok, exitstatus: task.exitstatus, ...log, durationMs: Date.now() - started };
}

// Susun rencana backup SEMUA VM & LXC di semua server
async function planAll() {
  const plan = [];
  const skipped = [];
  await Promise.all(
    servers.map(async (srv) => {
      if (serverStates.get(srv.name).isDown) {
        return skipped.push({ srv, reason: 'Server sedang DOWN' });
      }
      try {
        const nodes = (await pve(srv, '/nodes')).filter((n) => n.status === 'online');
        if (!nodes.length) return skipped.push({ srv, reason: 'Tidak ada node online' });
        nodes.forEach((n) => plan.push({ srv, node: n.node, vmids: null, guests: [] }));
      } catch (e) {
        skipped.push({ srv, reason: `API error: ${e.code || e.message}` });
      }
    })
  );
  return { plan, skipped };
}

// Teks ringkas "apa yang akan di-backup" untuk pesan awal
function describePlanItem(item, prune) {
  const what = item.vmids ? item.guests.map(guestLabel).join(', ') : 'semua VM & LXC';
  return `🖥 <b>${esc(item.srv.name)}</b> / ${esc(item.node)}: ${esc(what)} → <code>${esc(storageOf(item.srv))}</code>`;
}

// Laporan hasil, dikelompokkan per server
function renderResults(results, skipped) {
  const blocks = [];
  for (const srv of servers) {
    const rs = results.filter((r) => r.srv === srv);
    const sk = skipped.find((s) => s.srv === srv);
    if (!rs.length && !sk) continue;
    const out = [`🖥 <b>${esc(srv.name)}</b>`];
    if (sk) out.push(`⏭ Dilewati: ${esc(sk.reason)}`);
    for (const n of rs) {
      if (n.error) {
        out.push(`🔴 Node ${esc(n.node)}: ${esc(n.error)}`);
        continue;
      }
      out.push(`${n.ok ? '🟢' : '🔴'} Node ${esc(n.node)} → <code>${esc(n.storage)}</code> · ⏱ ${formatDuration(n.durationMs)}`);
      if (n.okVms.length) out.push(`   ✅ Berhasil (${n.okVms.length}): ${esc(n.okVms.join(', '))}`);
      if (n.failVms.length) out.push(`   ❌ Gagal: ${esc(n.failVms.join(', '))}`);
      if (n.removed > 0) out.push(`   🗑 ${n.removed} backup lama dihapus`);
      if (!n.ok) {
        out.push(`   Status: ${esc(n.exitstatus || '-')}`);
        if (n.tail.length) out.push(`<pre>${esc(n.tail.join('\n').slice(0, 600))}</pre>`);
      }
    }
    blocks.push(out.join('\n'));
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Titik masuk
// ---------------------------------------------------------------------------

// Jalankan satu rencana backup.
//   trigger: 'manual' | 'scheduled'  (hapus backup lama HANYA untuk 'scheduled')
// Return false jika backup lain sedang berjalan.
async function runBackupJob({ trigger, plan, skipped = [] }) {
  if (state.running) return false;
  state.running = true;
  const scheduled = trigger === 'scheduled';
  if (scheduled) {
    state.lastRun = Date.now(); // hanya jadwal otomatis yang menandai "minggu ini sudah"
    save();
  }
  try {
    const willPrune = scheduled && plan.some((p) => keepLastOf(p.srv) > 0);
    await send(
      [
        `💾 <b>BACKUP DIMULAI</b> (${scheduled ? 'jadwal mingguan' : 'manual'})`,
        ``,
        ...plan.map((p) => describePlanItem(p)),
        willPrune ? `\n🗑 Backup lama dihapus otomatis setelah backup baru sukses` : ``,
        `🕒 ${now()}`,
        `<i>Hasil akan dikirim setelah selesai.</i>`
      ].join('\n')
    );

    const t0 = Date.now();
    const results = await Promise.all(
      plan.map((item) =>
        backupNode(item, scheduled).catch((e) => ({
          srv: item.srv, node: item.node, storage: storageOf(item.srv),
          ok: false, error: e.message, durationMs: Date.now() - t0
        }))
      )
    );
    const allOk = results.every((r) => r.ok) && !skipped.length;
    await send(
      [
        allOk ? `✅ <b>BACKUP SELESAI</b>` : `⚠️ <b>BACKUP SELESAI DENGAN MASALAH</b>`,
        ``,
        renderResults(results, skipped),
        ``,
        `⏱ Total: ${formatDuration(Date.now() - t0)}`,
        `📅 Backup mingguan berikutnya: ${fmtDate(scheduleSlot(1))}`
      ].join('\n')
    );
  } catch (e) {
    console.error('[backup]', e.message);
    await send(`❌ <b>Backup error:</b> ${esc(e.message)}`);
  } finally {
    state.running = false;
  }
  return true;
}

// Backup SEMUA VM & LXC (dipakai scheduler mingguan dan "/backup all")
async function runFullBackup(trigger) {
  const { plan, skipped } = await planAll();
  if (!plan.length) {
    await send(`⚠️ <b>Backup dibatalkan</b>: tidak ada server yang bisa dijangkau.`);
    return false;
  }
  return runBackupJob({ trigger, plan, skipped });
}

module.exports = { runBackupJob, runFullBackup };