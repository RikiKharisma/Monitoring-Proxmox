// ===========================================================================
// api.js - pemanggil API Proxmox (GET dan POST)
// ===========================================================================
const https = require('https');
const axios = require('axios');

// Proxmox biasanya memakai sertifikat self-signed -> verifikasi dimatikan
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const authHeader = (srv) => `PVEAPIToken=${srv.tokenId}=${srv.tokenSecret}`;

// GET, contoh: pve(srv, '/version')
async function pve(srv, path) {
  const r = await axios.get(`${srv.url}/api2/json${path}`, {
    httpsAgent,
    timeout: 8000,
    headers: { Authorization: authHeader(srv) }
  });
  return r.data.data;
}

// POST, contoh: pvePost(srv, '/nodes/pve/vzdump', { all: '1', storage: 'local' })
async function pvePost(srv, path, params = {}) {
  const r = await axios.post(
    `${srv.url}/api2/json${path}`,
    new URLSearchParams(params).toString(),
    {
      httpsAgent,
      timeout: 15000,
      headers: {
        Authorization: authHeader(srv),
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return r.data.data;
}

module.exports = { pve, pvePost };
