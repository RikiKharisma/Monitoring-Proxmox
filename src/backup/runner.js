// ===========================================================================
// runner.js - menjalankan backup (vzdump) lewat API Proxmox
//
// Alur: runBackupAll -> backupServer (per server) -> backupNode (per node)
//       -> kirim perintah vzdump -> tunggu task selesai -> baca log -> laporan
//
// Opsi per server (di servers.json): backupStorage, backupMode,
// backupCompress, backupExclude (lihat README.md)
// ===========================================================================
const { servers, backup } = require('../config');
const { pve, pvePost } = require('../proxmox/api');
const { send } = require('../telegram/bot');
const { serverStates } = require('../monitor/state');
const { esc, now, fmtDate, formatDuration } = require('../utils/format');
const { state, save } = require('./state');
const { scheduleSlot } = require('./schedule');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Baca log task: VM mana yang berhasil / gagal
async function parseBackupLog(srv, node, upid) {
  const res = { okVms: [], failVms: [], tail: [] };
  try {
    const log = await pve(srv, `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log?limit=5000`);
    const lines = log.map((l) => l.t);
    for (const t of lines) {
      let m = /Finished Backup of VM (\d+) \(([^)]+)\)/.exec(t);
      if (m) res.okVms.push(`${m[1]} (${m[2]})`);
      m = /Backup of VM (\d+) failed/.exec(t);
      if (m) res.failVms.push(m[1]);
    }
    res.tail = lines.filter((t) => /ERROR|WARN|failed/i.test(t)).slice(-5);
  } catch (_) {}
  return res;
}

// Backup semua VM/LXC di satu node
async function backupNode(srv, node) {
  const started = Date.now();
  const params = {
    all: '1', // semua VM & LXC di node ini
    storage: srv.backupStorage || 'local',
    mode: srv.backupMode || backup.mode,
    compress: srv.backupCompress || backup.compress,
    'notes-template': '{{guestname}} - bot-backup'
  };
  if (Array.isArray(srv.backupExclude) && srv.backupExclude.length) {
    params.exclude = srv.backupExclude.join(',');
  }

  let upid;
  try {
    upid = await pvePost(srv, `/nodes/${node}/vzdump`, params);
  } catch (e) {
    const detail =
      (e.response && e.response.data && JSON.stringify(e.response.data.errors || e.response.data.message)) ||
      e.message;
    return { node, ok: false, error: `Gagal memulai backup: ${detail}`, durationMs: Date.now() - started };
  }

  const task = await waitForTask(srv, node, upid);
  const log = await parseBackupLog(srv, node, upid);
  const ok = task.done && task.exitstatus === 'OK' && !log.failVms.length;
  return { node, ok, storage: params.storage, exitstatus: task.exitstatus, ...log, durationMs: Date.now() - started };
}

// Backup semua node di satu server
async function backupServer(srv) {
  const st = serverStates.get(srv.name);
  if (st.isDown) return { srv, skipped: 'Server sedang DOWN' };
  try {
    const nodes = (await pve(srv, '/nodes')).filter((n) => n.status === 'online');
    if (!nodes.length) return { srv, skipped: 'Tidak ada node online' };
    const results = await Promise.all(nodes.map((n) => backupNode(srv, n.node)));
    return { srv, results };
  } catch (e) {
    return { srv, skipped: `API error: ${e.code || e.message}` };
  }
}

// Teks laporan untuk satu server
function renderBackupResult(r) {
  const out = [`🖥 <b>${esc(r.srv.name)}</b>`];
  if (r.skipped) {
    out.push(`⏭ Dilewati: ${esc(r.skipped)}`);
    return out.join('\n');
  }
  for (const n of r.results) {
    const dur = formatDuration(n.durationMs);
    if (n.error) {
      out.push(`🔴 Node ${esc(n.node)}: ${esc(n.error)}`);
      continue;
    }
    out.push(`${n.ok ? '🟢' : '🔴'} Node ${esc(n.node)} → <code>${esc(n.storage)}</code> · ⏱ ${dur}`);
    if (n.okVms.length) out.push(`   ✅ Berhasil (${n.okVms.length}): ${esc(n.okVms.join(', '))}`);
    if (n.failVms.length) out.push(`   ❌ Gagal: ${esc(n.failVms.join(', '))}`);
    if (!n.ok) {
      out.push(`   Status: ${esc(n.exitstatus || '-')}`);
      if (n.tail.length) out.push(`<pre>${esc(n.tail.join('\n').slice(0, 600))}</pre>`);
    }
  }
  return out.join('\n');
}

// Titik masuk: dipanggil oleh /backup (manual) dan scheduler (otomatis)
// Return false jika backup sedang berjalan.
async function runBackupAll(trigger) {
  if (state.running) return false;
  state.running = true;
  state.lastRun = Date.now();
  save();
  try {
    await send(
      [
        `💾 <b>BACKUP DIMULAI</b> (${trigger === 'manual' ? 'manual' : 'jadwal mingguan'})`,
        `Server: ${servers.map((s) => esc(s.name)).join(', ')}`,
        `🕒 ${now()}`,
        ``,
        `<i>Notifikasi hasil akan dikirim setelah selesai.</i>`
      ].join('\n')
    );
    const t0 = Date.now();
    const all = await Promise.all(
      servers.map((srv) => backupServer(srv).catch((e) => ({ srv, skipped: e.message })))
    );
    const allOk = all.every((r) => r.results && r.results.every((n) => n.ok));
    await send(
      [
        allOk ? `✅ <b>BACKUP SELESAI</b>` : `⚠️ <b>BACKUP SELESAI DENGAN MASALAH</b>`,
        ``,
        all.map(renderBackupResult).join('\n\n'),
        ``,
        `⏱ Total: ${formatDuration(Date.now() - t0)}`,
        `📅 Backup berikutnya: ${fmtDate(scheduleSlot(1))}`
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

module.exports = { runBackupAll };
