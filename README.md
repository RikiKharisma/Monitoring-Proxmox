# Proxmox Monitor Bot

Bot Telegram untuk memantau server Proxmox + backup VM/LXC otomatis mingguan.

## Perintah Telegram

| Perintah  | Fungsi                                           |
| --------- | ------------------------------------------------ |
| `/status` | Status lengkap: suhu, CPU, RAM, disk, daftar VM  |
| `/backup` | Backup semua VM & LXC **sekarang**               |
| `/help`   | Bantuan + jadwal backup                          |

## Struktur folder

```
proxmox-monitor-bot/
├── index.js                  ← titik masuk, hanya menyalakan semua bagian
├── servers.json              ← daftar server Proxmox + token API
├── .env                      ← token Telegram & pengaturan
├── docker-compose.yml / Dockerfile
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
    │   ├── commands.js       ← perintah /status /backup /help + tombol Refresh
    │   ├── status.js         ← merakit pesan /status
    │   └── render.js         ← tampilan pesan (edit di sini untuk ubah desain)
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
        ├── runner.js         ← proses backup (vzdump) + laporan hasil
        └── state.js          ← ingat waktu backup terakhir (file di data/)
```

## Mau ubah apa? Edit file mana?

| Keinginan                                  | File                                   |
| ------------------------------------------ | -------------------------------------- |
| Ganti hari/jam backup, batas suhu, dll     | `.env` (atau `src/config.js`)          |
| Tambah/hapus server                        | `servers.json`                         |
| Ubah tampilan `/status`                    | `src/telegram/render.js`               |
| Tambah perintah Telegram baru              | `src/telegram/commands.js`             |
| Ubah isi laporan backup                    | `renderBackupResult` di `src/backup/runner.js` |
| Ubah logika deteksi server DOWN            | `src/monitor/health.js`                |
| Tambah jenis alert resource baru           | `buildConditions` di `src/monitor/resources.js` |

## Pengaturan `.env`

| Variabel                 | Default  | Keterangan                                   |
| ------------------------ | -------- | -------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | -        | Token dari @BotFather                        |
| `ALLOWED_CHAT_ID`        | -        | Chat ID yang boleh memakai bot               |
| `CHECK_INTERVAL_SECONDS` | 15       | Interval cek ping/API                        |
| `FAIL_THRESHOLD`         | 3        | Gagal berturut-turut sebelum dianggap DOWN   |
| `METRICS_INTERVAL_SECONDS` | 60     | Interval cek resource                        |
| `TEMP_WARN` / `TEMP_CRIT`| 70 / 85  | Batas suhu CPU (°C)                          |
| `CPU_WARN` `RAM_WARN` `DISK_WARN` | 90 | Batas alert (%)                          |
| `BACKUP_ENABLED`         | true     | `false` untuk mematikan backup otomatis      |
| `BACKUP_DAY`             | 0        | 0=Minggu, 1=Senin, ... 6=Sabtu               |
| `BACKUP_HOUR` / `BACKUP_MINUTE` | 2 / 0 | Jam backup (WIB)                         |
| `BACKUP_MODE`            | snapshot | snapshot / suspend / stop                    |
| `BACKUP_COMPRESS`        | zstd     | 0 / gzip / lzo / zstd                        |

## Pengaturan backup per server (`servers.json`)

```json
{
  "name": "DELL R640",
  "ip": "192.168.200.2",
  "url": "https://192.168.200.2:8006",
  "tokenId": "root@pam!server",
  "tokenSecret": "...",
  "backupStorage": "local",
  "backupMode": "snapshot",
  "backupCompress": "zstd",
  "backupExclude": [100, 101]
}
```

Hanya `backupStorage` yang wajib (default `local`). Sisanya opsional.

**Syarat di Proxmox:**
- Storage tujuan harus punya content type **VZDump backup**.
- Token API butuh izin `VM.Backup` dan `Datastore.AllocateSpace`
  (token `root@pam` dengan *Privilege Separation* dimatikan sudah cukup).

## Menjalankan

```bash
docker compose up -d --build
docker compose logs -f
```

Folder `data/` dibuat otomatis untuk menyimpan waktu backup terakhir.
