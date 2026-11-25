# Proxmox Monitor Bot

Bot Telegram untuk **memantau server Proxmox** dan **membackup VM/LXC** — otomatis tiap minggu atau manual lewat perintah.

## Fitur

- 🔴🟢 **Deteksi server DOWN / pulih** — cek ping + API Proxmox, kirim alert beserta diagnosa dan lama downtime.
- 🌡 **Alert resource otomatis** — suhu CPU, CPU, RAM, dan disk/storage melewati batas.
- 📡 **`/status`** — ringkasan lengkap tiap server (suhu, CPU, RAM, swap, load, storage, daftar VM & LXC) dengan tombol **Refresh**.
- 💾 **Backup manual** — `/backup vm101` untuk VM tertentu, atau `/backup all` untuk semuanya.
- ⏰ **Backup mingguan otomatis** — ke storage pilihan Anda (mis. `HDD-1TB`), backup lama dihapus otomatis.
- 🔒 **Hanya satu chat yang diizinkan** (`ALLOWED_CHAT_ID`), pesan dari chat lain diabaikan.

---

## Perintah Telegram

| Perintah | Fungsi |
| --- | --- |
| `/status` | Status lengkap semua server (juga `/start`, `/cek`) |
| `/backup` | Menampilkan cara pakai + daftar VM/LXC — **tidak membackup apa pun** |
| `/backup vm101` | Backup VM/LXC dengan ID 101 |
| `/backup vm101 vm102` | Backup beberapa VM/LXC sekaligus |
| `/backup vm101 dell` | Tambahkan nama server jika ID yang sama ada di 2 server |
| `/backup all` | Backup **semua** VM & LXC di semua server |
| `/help` | Bantuan, jadwal backup, batas alert, + tombol cepat |

Catatan `/backup`:
- Awalan `vm`, `ct`, `lxc` boleh dipakai atau dilewati: `/backup 101` = `/backup vm101` = `/backup ct101`.
- Nama server cukup sebagian, tidak peka huruf besar/kecil (`dell` cocok dengan `DELL R640`).
- Kalau sebagian ID tidak ditemukan, yang ketemu tetap dibackup dan bot memberi tahu yang tidak ketemu.
- Kalau backup sedang berjalan, perintah baru ditolak sampai backup selesai.

---

## Cara kerja

### Deteksi server DOWN
Tiap `CHECK_INTERVAL_SECONDS` (default 15 detik) bot melakukan **ping** dan memanggil **API Proxmox**.
Jika gagal `FAIL_THRESHOLD` kali berturut-turut (default 3), server dinyatakan DOWN dan alert dikirim dengan diagnosa:

| Ping | API | Diagnosa |
| --- | --- | --- |
| ❌ | ❌ | Host tidak terjangkau |
| ✅ | ❌ | Service Proxmox mati/hang |
| ❌ | ✅ | Ping diblokir/timeout (API masih responsif) |

Saat server pulih, bot mengirim pesan "kembali online" beserta total downtime.

### Alert resource
Tiap `METRICS_INTERVAL_SECONDS` (default 60 detik) bot membaca resource. Alert dikirim jika kondisi buruk
**3 kali pengecekan berturut-turut** (supaya tidak ada alert palsu karena lonjakan sesaat), dan dikirim satu kali
sampai kembali normal.

| Yang dipantau | Batas default |
| --- | --- |
| Suhu CPU | 70°C (hangat), 85°C (kritis) |
| CPU, RAM | 90% |
| Disk root & storage | 90% |

Suhu CPU dibaca lewat SSH ke host Proxmox (opsional, lihat [SSH](#opsional-suhu-cpu-lewat-ssh)).

### Backup
Bot memakai fitur **vzdump** bawaan Proxmox lewat API, lalu menunggu sampai selesai dan mengirim laporan
(VM mana yang berhasil/gagal, lama pengerjaan, backup lama yang dihapus).

|  | Otomatis (mingguan) | Manual (`/backup ...`) |
| --- | --- | --- |
| Kapan | Default tiap **Minggu 02:00 WIB** | Saat perintah dikirim |
| Yang dibackup | Semua VM & LXC | Sesuai perintah |
| Storage tujuan | `backupStorage` per server | sama |
| Backup lama | **Dihapus**, simpan `BACKUP_KEEP_LAST` terbaru per VM (default 1) | Tidak dihapus oleh bot |

**Penghapusan backup lama** dilakukan oleh Proxmox sendiri (`prune-backups=keep-last=N`)
**setelah backup baru VM itu sukses**. Kalau backup baru gagal, backup lama tetap aman.

> ⚠️ `keep-last` menghitung **semua** backup VM tersebut di storage tujuan, termasuk hasil `/backup` manual
> dan job Proxmox lain. Jadi setelah backup mingguan, hanya backup terbaru tiap VM yang tersisa.
> Butuh Proxmox 7 atau lebih baru. Isi `BACKUP_KEEP_LAST=0` untuk menonaktifkan penghapusan.
> Sesaat saat backup berlangsung, VM yang sama bisa punya 2 file — pastikan ruang storage cukup.

**Pengecekan storage:** sebelum backup, bot memastikan storage tujuan ada dan aktif (mis. HDD sudah ter-mount).
Kalau tidak, backup dibatalkan dan bot mengirim pesan error — bot tidak menulis ke disk lain.

**Jika bot mati saat jadwal:** backup tetap dijalankan bila bot hidup lagi dalam `BACKUP_CATCHUP_HOURS` (default 6 jam)
setelah jadwal. Lebih dari itu, backup minggu itu dilewati dan menunggu jadwal berikutnya.
Waktu backup terakhir disimpan di `data/backup-state.json` supaya restart tidak menyebabkan backup ganda.

---

## Instalasi

### 1. Siapkan bot Telegram
1. Chat **@BotFather** → `/newbot` → salin **token** bot.
2. Cari tahu **chat ID** Anda (mis. lewat @userinfobot).

### 2. Buat API token di Proxmox (tiap server)
Datacenter → Permissions → **API Tokens** → Add.

| Kebutuhan | Izin |
| --- | --- |
| Hanya monitoring | `PVEAuditor` |
| Backup | `VM.Backup` dan `Datastore.AllocateSpace` pada storage tujuan |

Paling mudah: token milik `root@pam` dengan **Privilege Separation dimatikan** (cukup untuk semuanya).

### 3. Siapkan storage backup di Proxmox
Datacenter → Storage → *(storage Anda, mis. HDD-1TB)* → Edit → **Content** → centang **VZDump backup file**.
Nama storage di `servers.json` harus **persis sama** dengan ID storage (huruf besar/kecil berpengaruh).

### 4. Isi konfigurasi

**`.env`**
```env
TELEGRAM_BOT_TOKEN=123456:ABC-xxxxxxxx
ALLOWED_CHAT_ID=123456789

# opsional (nilai default)
CHECK_INTERVAL_SECONDS=15
FAIL_THRESHOLD=3
BACKUP_ENABLED=true
BACKUP_DAY=0
BACKUP_HOUR=2
BACKUP_MINUTE=0
BACKUP_KEEP_LAST=1
```

**`servers.json`**
```json
[
  {
    "name": "DELL R640",
    "ip": "192.168.200.2",
    "url": "https://192.168.200.2:8006",
    "tokenId": "root@pam!server",
    "tokenSecret": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "backupStorage": "HDD-1TB"
  }
]
```

### 5. Jalankan
```bash
docker compose up -d --build
docker compose logs -f
```
Kirim `/help` ke bot untuk mengecek. Folder `data/` dibuat otomatis.

### (Opsional) Suhu CPU lewat SSH
Suhu dibaca dari sensor `/sys/class/hwmon` di host Proxmox lewat SSH.

1. Taruh private key di `ssh/id_ed25519` (folder ini di-mount read-only ke container).
2. Tambahkan public key (`ssh/id_ed25519.pub`) ke `~/.ssh/authorized_keys` user `root` di tiap host Proxmox.
3. Port/user selain default bisa diatur per server di `servers.json`: `"sshUser": "root"`, `"sshPort": 22`.

Tanpa SSH, bot tetap jalan; `/status` hanya menampilkan "Suhu CPU: tidak tersedia".

---

## Pengaturan

### `.env`

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | – | Token dari @BotFather |
| `ALLOWED_CHAT_ID` | – | Satu-satunya chat yang boleh memakai bot |
| `CHECK_INTERVAL_SECONDS` | 15 | Interval cek ping + API |
| `FAIL_THRESHOLD` | 3 | Gagal berturut-turut sebelum dianggap DOWN |
| `METRICS_INTERVAL_SECONDS` | 60 | Interval cek resource |
| `TEMP_WARN` / `TEMP_CRIT` | 70 / 85 | Batas suhu CPU (°C) |
| `CPU_WARN` `RAM_WARN` `DISK_WARN` | 90 | Batas alert (%) |
| `SSH_KEY_PATH` | `/app/ssh/id_ed25519` | Lokasi private key di dalam container |
| `BACKUP_ENABLED` | true | `false` mematikan backup otomatis (perintah manual tetap bisa) |
| `BACKUP_DAY` | 0 | Hari backup: 0=Minggu, 1=Senin, … 6=Sabtu |
| `BACKUP_HOUR` / `BACKUP_MINUTE` | 2 / 0 | Jam backup (WIB) |
| `BACKUP_KEEP_LAST` | 1 | Backup mingguan: simpan N terbaru per VM, sisanya dihapus (0 = tidak hapus) |
| `BACKUP_MODE` | snapshot | `snapshot` / `suspend` / `stop` |
| `BACKUP_COMPRESS` | zstd | `0` / `gzip` / `lzo` / `zstd` |
| `BACKUP_TIMEOUT_HOURS` | 12 | Batas tunggu satu job backup |
| `BACKUP_CATCHUP_HOURS` | 6 | Batas keterlambatan untuk tetap menjalankan backup yang terlewat |
| `BACKUP_STATE_FILE` | `/app/data/backup-state.json` | Lokasi file penyimpan waktu backup terakhir |

### `servers.json` (per server)

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `name` | ✅ | Nama tampilan (juga dipakai untuk memilih server di `/backup vm101 dell`) |
| `ip` | ✅ | IP host (untuk ping dan SSH) |
| `url` | ✅ | URL Proxmox, mis. `https://192.168.200.2:8006` |
| `tokenId` / `tokenSecret` | ✅ | API token Proxmox |
| `backupStorage` | disarankan | Storage tujuan backup (default `local`) |
| `backupKeepLast` | – | Menimpa `BACKUP_KEEP_LAST` untuk server ini |
| `backupMode` | – | Menimpa `BACKUP_MODE` untuk server ini |
| `backupCompress` | – | Menimpa `BACKUP_COMPRESS` untuk server ini |
| `backupExclude` | – | Daftar VMID yang dilewati saat backup semua, mis. `[100, 101]` |
| `sshUser` / `sshPort` | – | Untuk pembacaan suhu (default `root` / `22`) |

---

## Struktur folder

```
proxmox-monitor-bot/
├── index.js                  ← titik masuk, hanya menyalakan semua bagian
├── servers.json              ← daftar server Proxmox + token API
├── .env                      ← token Telegram & pengaturan
├── docker-compose.yml · Dockerfile
├── ssh/                      ← key SSH untuk baca suhu (opsional)
├── data/                     ← dibuat otomatis (backup-state.json)
└── src/
    ├── config.js             ← SEMUA pengaturan (dibaca dari .env)
    │
    ├── utils/
    │   └── format.js         ← helper teks: tanggal, durasi, progress bar
    │
    ├── proxmox/
    │   └── api.js            ← pemanggil API Proxmox (pve = GET, pvePost = POST)
    │
    ├── telegram/
    │   ├── bot.js            ← koneksi bot + fungsi send()
    │   ├── commands.js       ← perintah /status /backup /help + tombol
    │   ├── help.js           ← tampilan pesan /help
    │   ├── status.js         ← merakit pesan /status
    │   └── render.js         ← tampilan blok server di /status
    │
    ├── monitor/
    │   ├── state.js          ← status tiap server di memori
    │   ├── health.js         ← cek ping + API, alert DOWN / ONLINE
    │   ├── metrics.js        ← ambil CPU/RAM/disk/VM + suhu (SSH)
    │   └── resources.js      ← alert otomatis suhu/CPU/RAM/disk
    │
    └── backup/
        ├── schedule.js       ← hitung jadwal mingguan
        ├── scheduler.js      ← tiap menit cek: sudah waktunya backup?
        ├── guests.js         ← cari VM/LXC + baca argumen /backup vm101
        ├── runner.js         ← proses backup (vzdump), hapus backup lama, laporan
        └── state.js          ← ingat waktu backup terakhir
```

### Mau ubah apa? Edit file mana?

| Keinginan | File |
| --- | --- |
| Ganti hari/jam backup, batas alert, interval | `.env` (atau nilai default di `src/config.js`) |
| Tambah/hapus server, ganti storage backup | `servers.json` |
| Ubah teks/desain `/help` dan tombolnya | `src/telegram/help.js` |
| Ubah tampilan `/status` | `src/telegram/render.js` |
| Tambah perintah Telegram baru | `src/telegram/commands.js` |
| Ubah isi laporan backup | `renderResults` di `src/backup/runner.js` |
| Ubah cara baca `/backup vm101 ...` | `src/backup/guests.js` |
| Ubah logika deteksi server DOWN | `src/monitor/health.js` |
| Tambah jenis alert resource baru | `buildConditions` di `src/monitor/resources.js` |

Setelah mengubah kode, jalankan `docker compose up -d --build`. Perubahan `.env` dan `servers.json` cukup `docker compose restart`.

---

## Troubleshooting

| Gejala | Penyebab / solusi |
| --- | --- |
| Bot tidak merespons | Cek `TELEGRAM_BOT_TOKEN` dan `ALLOWED_CHAT_ID`; lihat `docker compose logs -f` |
| `/status`: "Data resource kosong" | Token API tidak punya izin `PVEAuditor` |
| Suhu CPU "SSH gagal" / "SSH key belum dipasang" | Public key belum ada di `authorized_keys` host, atau key belum di folder `ssh/` |
| Backup: `Storage "X" tidak ditemukan` | Nama di `backupStorage` salah, atau Content storage belum mencentang *VZDump backup file* |
| Backup: `Storage "X" tidak aktif` | Disk/mount belum aktif di host Proxmox |
| Backup: `Gagal memulai backup: ...` | Token API kurang izin (`VM.Backup`, `Datastore.AllocateSpace`), atau Proxmox < 7 untuk penghapusan backup lama |
| `ID tidak ditemukan` | Cek ID di daftar `/backup`; server yang DOWN tidak ikut terdaftar |
| `ID ada di beberapa server` | Tambahkan nama server: `/backup vm101 dell` |
| Ingin menguji backup mingguan tanpa menunggu | Ubah `BACKUP_DAY/HOUR/MINUTE` ke beberapa menit lagi, `docker compose restart`, lalu kembalikan setelah tes |

---

## Keamanan

- `.env`, `servers.json`, dan folder `ssh/` berisi **token dan private key**. Jangan diunggah ke Git atau dibagikan.
  Jika memakai Git, tambahkan ke `.gitignore`:
  ```
  .env
  .env.docker
  servers.json
  ssh/
  data/
  node_modules/
  ```
- Bot hanya melayani chat dengan ID `ALLOWED_CHAT_ID`.
- Koneksi ke Proxmox memakai HTTPS **tanpa verifikasi sertifikat** (umum untuk sertifikat self-signed bawaan Proxmox).
  Pakai hanya di jaringan yang Anda percaya.
