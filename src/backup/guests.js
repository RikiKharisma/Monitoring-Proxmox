// ===========================================================================
// guests.js - cari VM/LXC di semua server + baca argumen perintah /backup
//
// Contoh argumen:  "vm101"  |  "vm101 vm102"  |  "ct105 dell"  |  "101 pc i7"
// Aturan: ID (angka, boleh diawali vm/ct/lxc) ditulis dulu,
//         sisanya dianggap nama server (opsional).
// ===========================================================================
const { servers } = require('../config');
const { pve } = require('../proxmox/api');
const { serverStates } = require('../monitor/state');

const guestLabel = (g) => `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} (${g.name})`;

// Ambil semua VM & LXC dari semua server yang online
async function listGuests() {
  const guests = [];
  const problems = [];
  await Promise.all(
    servers.map(async (srv) => {
      if (serverStates.get(srv.name).isDown) {
        problems.push(`${srv.name}: sedang DOWN`);
        return;
      }
      try {
        const res = await pve(srv, '/cluster/resources?type=vm');
        for (const r of res) {
          if (r.type !== 'qemu' && r.type !== 'lxc') continue;
          guests.push({
            srv, node: r.node, vmid: Number(r.vmid),
            name: r.name || '-', type: r.type, status: r.status
          });
        }
      } catch (e) {
        problems.push(`${srv.name}: ${e.code || e.message}`);
      }
    })
  );
  guests.sort((a, b) => servers.indexOf(a.srv) - servers.indexOf(b.srv) || a.vmid - b.vmid);
  return { guests, problems };
}

// "vm101 vm102 pc i7" -> { vmids: [101, 102], serverFilter: 'pc i7' }
function parseBackupArgs(text) {
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean);
  const vmids = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = /^(?:vm|ct|lxc)?(\d+)$/i.exec(tokens[i]);
    if (!m) break;
    const id = Number(m[1]);
    if (!vmids.includes(id)) vmids.push(id);
  }
  return { vmids, serverFilter: tokens.slice(i).join(' ').toLowerCase() };
}

const serverMatches = (srv, filter) => srv.name.toLowerCase().includes(filter);

// Cocokkan ID dengan VM yang ada -> rencana backup per (server, node)
function resolveTargets(guests, vmids, serverFilter) {
  const pool = serverFilter ? guests.filter((g) => serverMatches(g.srv, serverFilter)) : guests;
  const found = [];
  const notFound = [];
  const ambiguous = [];
  for (const id of vmids) {
    const m = pool.filter((g) => g.vmid === id);
    if (!m.length) notFound.push(id);
    else if (m.length > 1) ambiguous.push({ id, servers: m.map((g) => g.srv.name) });
    else found.push(m[0]);
  }
  const groups = new Map();
  for (const g of found) {
    const key = `${g.srv.name}|${g.node}`;
    if (!groups.has(key)) groups.set(key, { srv: g.srv, node: g.node, vmids: [], guests: [] });
    const e = groups.get(key);
    e.vmids.push(g.vmid);
    e.guests.push(g);
  }
  return { plan: [...groups.values()], notFound, ambiguous };
}

module.exports = { listGuests, parseBackupArgs, resolveTargets, serverMatches, guestLabel };