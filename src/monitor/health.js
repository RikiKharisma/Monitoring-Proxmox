// ===========================================================================
// health.js - cek apakah server hidup (ping + API) dan kirim alert DOWN/UP
// ===========================================================================
const { execFile } = require('child_process');
const { servers, monitor } = require('../config');
const { pve } = require('../proxmox/api');
const { send } = require('../telegram/bot');
const { serverStates } = require('./state');
const { esc, now, formatDuration } = require('../utils/format');

function checkPing(ip) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', ip], (error, stdout) => {
      if (error) return resolve({ alive: false, latency: null });
      const m = /time[=<]([\d.]+)/.exec(stdout || '');
      resolve({ alive: true, latency: m ? Math.round(parseFloat(m[1])) : 0 });
    });
  });
}

async function checkProxmoxApi(srv) {
  try {
    await pve(srv, '/version');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

async function checkSingleServer(srv) {
  const state = serverStates.get(srv.name);
  const [pingRes, apiRes] = await Promise.all([checkPing(srv.ip), checkProxmoxApi(srv)]);
  state.lastPingMs = pingRes.latency;

  // --- Server sehat ---
  if (pingRes.alive && apiRes.ok) {
    state.failCount = 0;
    if (state.isDown) {
      const downtimeMs = Date.now() - state.downSince;
      state.isDown = false;
      state.downSince = null;
      state.lastReason = null;

      await send(
        [
          `🟢 <b>SERVER KEMBALI ONLINE</b>`,
          ``,
          `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
          `📶 Ping: ${pingRes.latency} ms`,
          `⏳ Total downtime: <b>${formatDuration(downtimeMs)}</b>`,
          `🕒 Pulih: ${now()}`
        ].join('\n')
      );
    }
    return;
  }

  // --- Server bermasalah ---
  state.failCount++;
  let reason;
  if (!pingRes.alive && !apiRes.ok) {
    reason = `Host tidak terjangkau (ping timeout & API mati: ${apiRes.error})`;
  } else if (pingRes.alive && !apiRes.ok) {
    reason = `Service Proxmox mati/hang (ping ${pingRes.latency}ms, API error: ${apiRes.error})`;
  } else {
    reason = `Ping diblokir/timeout (API masih responsif)`;
  }
  state.lastReason = reason;
  console.warn(`[${srv.name}] Gagal ${state.failCount}/${monitor.failThreshold} - ${reason}`);

  if (!state.isDown && state.failCount >= monitor.failThreshold) {
    state.isDown = true;
    state.downSince = Date.now();

    await send(
      [
        `🚨🔴 <b>ALERT: SERVER DOWN!</b> 🔴🚨`,
        ``,
        `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
        `🔎 Diagnosa: ${esc(reason)}`,
        `🕒 Waktu: ${now()}`
      ].join('\n')
    );
  }
}

async function runHealthChecks() {
  await Promise.all(
    servers.map((srv) =>
      checkSingleServer(srv).catch((e) => console.error(`[${srv.name}] check error:`, e.message))
    )
  );
}

module.exports = { runHealthChecks };
