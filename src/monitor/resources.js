// ===========================================================================
// resources.js - alert otomatis kalau suhu / CPU / RAM / disk melewati batas
// Batas diatur di config.js (thresholds) atau lewat .env
// ===========================================================================
const { servers, monitor, thresholds } = require('../config');
const { send } = require('../telegram/bot');
const { serverStates } = require('./state');
const { getMetrics } = require('./metrics');
const { esc, now, pct } = require('../utils/format');

// Ubah data metrics menjadi daftar "kondisi" yang dicek satu per satu
function buildConditions(m) {
  const c = [];
  if (m.temp.ok) {
    const v = m.temp.value;
    c.push({
      key: 'temp',
      label: 'Suhu CPU',
      bad: v >= thresholds.tempWarn,
      text: `${v >= thresholds.tempCrit ? '🔥' : '🌡'} Suhu CPU <b>${v.toFixed(0)}°C</b> (batas ${thresholds.tempWarn}°C)`
    });
  }
  for (const n of m.nodes) {
    if (n.status === 'offline') continue;
    const cpu = (n.cpu || 0) * 100;
    const ram = pct(n.mem, n.maxmem);
    const disk = pct(n.disk, n.maxdisk);
    c.push({ key: `cpu:${n.node}`, label: `CPU ${n.node}`, bad: cpu >= thresholds.cpuWarn,
      text: `⚙️ CPU ${esc(n.node)} <b>${cpu.toFixed(0)}%</b> (batas ${thresholds.cpuWarn}%)` });
    c.push({ key: `ram:${n.node}`, label: `RAM ${n.node}`, bad: ram >= thresholds.ramWarn,
      text: `🧠 RAM ${esc(n.node)} <b>${ram.toFixed(0)}%</b> (batas ${thresholds.ramWarn}%)` });
    c.push({ key: `rootfs:${n.node}`, label: `Disk root ${n.node}`, bad: disk >= thresholds.diskWarn,
      text: `💾 Disk root ${esc(n.node)} <b>${disk.toFixed(0)}%</b> (batas ${thresholds.diskWarn}%)` });
  }
  const seen = new Set();
  for (const s of m.storages) {
    if (!s.maxdisk || seen.has(s.storage)) continue;
    seen.add(s.storage);
    const p = pct(s.disk, s.maxdisk);
    c.push({ key: `st:${s.storage}`, label: `Storage ${s.storage}`, bad: p >= thresholds.diskWarn,
      text: `💾 Storage ${esc(s.storage)} <b>${p.toFixed(0)}%</b> (batas ${thresholds.diskWarn}%)` });
  }
  return c;
}

async function checkResources(srv) {
  const state = serverStates.get(srv.name);
  if (state.isDown) return;
  let m;
  try {
    m = await getMetrics(srv);
  } catch (_) {
    return; // kalau API gagal, ditangani oleh logika DOWN
  }

  const alerts = [];
  const recovered = [];
  for (const cond of buildConditions(m)) {
    const e = (state.res[cond.key] = state.res[cond.key] || { count: 0, active: false });
    e.label = cond.label;
    if (cond.bad) {
      e.count++;
      if (e.count >= monitor.resourceConfirm && !e.active) {
        e.active = true;
        alerts.push(cond.text);
      }
    } else {
      e.count = 0;
      if (e.active) {
        e.active = false;
        recovered.push(esc(cond.label));
      }
    }
  }

  if (alerts.length) {
    await send(
      [
        `⚠️ <b>PERINGATAN RESOURCE</b>`,
        `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
        ``,
        ...alerts.map((a) => `• ${a}`),
        ``,
        `🕒 ${now()}`
      ].join('\n')
    );
  }
  if (recovered.length) {
    await send(
      [
        `✅ <b>RESOURCE KEMBALI NORMAL</b>`,
        `🖥 <b>${esc(srv.name)}</b>`,
        ``,
        ...recovered.map((r) => `• ${r}`)
      ].join('\n')
    );
  }
}

async function runResourceChecks() {
  await Promise.all(
    servers.map((srv) =>
      checkResources(srv).catch((e) => console.error(`[${srv.name}] resource error:`, e.message))
    )
  );
}

module.exports = { runResourceChecks };
