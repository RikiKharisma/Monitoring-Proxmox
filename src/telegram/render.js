// ===========================================================================
// render.js - mengubah data server menjadi teks pesan Telegram (HTML)
// Mau ubah tampilan /status? Edit file ini.
// ===========================================================================
const { thresholds } = require('../config');
const { esc, now, formatDuration, bar, fmtBytes, pct, tempLevel } = require('../utils/format');

function metricLine(label, p, extra, warnAt) {
  const flag = p >= warnAt ? ' ⚠️' : '';
  return `${label.padEnd(5)} ${bar(p)} ${p.toFixed(0).padStart(3)}%${extra ? '  ' + extra : ''}${flag}`;
}

// Tampilan server yang ONLINE
function renderServer(srv, state, m) {
  const out = [];
  out.push(`🟢 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`);
  out.push(`Online · Ping ${state.lastPingMs !== null ? state.lastPingMs + ' ms' : 'OK'}`);

  if (m.temp.ok) {
    const lv = tempLevel(m.temp.value);
    out.push(`🌡 Suhu CPU: <b>${m.temp.value.toFixed(0)}°C</b> ${lv.icon} ${lv.label}`);
  } else {
    out.push(`🌡 Suhu CPU: <i>tidak tersedia (${esc(m.temp.error)})</i>`);
  }

  if (!m.nodes.length) {
    out.push(`\n⚠️ <i>Data resource kosong. Pastikan API token punya role PVEAuditor.</i>`);
  }

  for (const n of m.nodes) {
    out.push('');
    if (n.status === 'offline' || n.uptime === 0) {
      out.push(`🖥 <b>Node ${esc(n.node)}</b> · 🔴 OFFLINE`);
      continue;
    }
    const up = formatDuration((n.uptime || 0) * 1000);
    out.push(`🖥 <b>Node ${esc(n.node)}</b> · ⏱ ${up}`);
    const info = n.status && n.status.cpuinfo;
    if (info) out.push(`<i>${esc(info.model)} · ${info.cpus} core</i>`);

    const lines = [
      metricLine('CPU', (n.cpu || 0) * 100, '', thresholds.cpuWarn),
      metricLine('RAM', pct(n.mem, n.maxmem), `${fmtBytes(n.mem)}/${fmtBytes(n.maxmem)}`, thresholds.ramWarn),
      metricLine('Disk', pct(n.disk, n.maxdisk), `${fmtBytes(n.disk)}/${fmtBytes(n.maxdisk)}`, thresholds.diskWarn)
    ];
    const sw = n.status && n.status.swap;
    if (sw && sw.total > 0) {
      lines.push(metricLine('Swap', pct(sw.used, sw.total), `${fmtBytes(sw.used)}/${fmtBytes(sw.total)}`, 90));
    }
    const la = n.status && n.status.loadavg;
    if (la) lines.push(`Load  ${la.map((x) => Number(x).toFixed(2)).join(' ')}`);
    out.push(`<pre>${esc(lines.join('\n'))}</pre>`);
  }

  if (m.storages.length) {
    const seen = new Set();
    const rows = [];
    for (const s of m.storages) {
      const key = `${s.storage}`;
      if (seen.has(key) || !s.maxdisk) continue;
      seen.add(key);
      const p = pct(s.disk, s.maxdisk);
      rows.push(
        `${s.storage.slice(0, 10).padEnd(10)} ${bar(p, 8)} ${p.toFixed(0).padStart(3)}%` +
          `  ${fmtBytes(s.disk)}/${fmtBytes(s.maxdisk)}${p >= thresholds.diskWarn ? ' ⚠️' : ''}`
      );
    }
    if (rows.length) {
      out.push(`\n💾 <b>Storage</b>`);
      out.push(`<pre>${esc(rows.slice(0, 6).join('\n'))}</pre>`);
    }
  }

  if (m.guests.length) {
    const running = m.guests.filter((g) => g.status === 'running').length;
    out.push(`\n📦 <b>VM &amp; LXC</b> · ${running}/${m.guests.length} berjalan`);
    const rows = m.guests.slice(0, 15).map((g) => {
      const icon = g.status === 'running' ? '🟢' : '⚫';
      const kind = g.type === 'qemu' ? 'VM' : 'LXC';
      return `${icon} <code>${g.vmid}</code> ${esc(g.name || '-')} <i>(${kind})</i>`;
    });
    out.push(rows.join('\n'));
    if (m.guests.length > 15) out.push(`<i>…dan ${m.guests.length - 15} lainnya</i>`);
  }

  return out.join('\n');
}

// Tampilan server yang DOWN
function renderDown(srv, state) {
  return [
    `🔴 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
    `Status: <b>DOWN</b> sejak ${formatDuration(Date.now() - state.downSince)} lalu`,
    `🔎 ${esc(state.lastReason || '-')}`
  ].join('\n');
}

module.exports = { renderServer, renderDown };
