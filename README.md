# Screener UT Bot + Volume SuperTrend (4H)

Screener kripto (spot, long only) yang menggabungkan **UT Bot Alerts** dan **Volume SuperTrend AI**, dengan dashboard web.
**Mode PAPER**: bot hanya mencatat posisi virtual dan **tidak mengirim order ke exchange**. Bukan saran keuangan.

## Isi
| File | Fungsi |
|---|---|
| `strategy.js` | Indikator + logika sinyal BUY/SELL + stop loss |
| `screener.js` | Bot: scan terjadwal, manajemen posisi tiap 1 menit, filter pasar, ranking, server dashboard |
| `universe.js` | Daftar top N koin dari CoinGecko (tanpa stablecoin/wrapped), dicocokkan dengan pair OKX |
| `dashboard.html` | Dashboard (posisi, history, konfigurasi) |
| `backtest.js` / `portfolio.js` | Backtest satu koin / backtest portofolio (opsional, tidak dipakai bot) |
| `futures_backtest.js` | Backtest futures USDT-M (candle Bitget, timeframe bebas, long+short, leverage, likuidasi, funding) |

## Menjalankan
Butuh Node.js 18+. Tanpa library tambahan.
```
node screener.js        # lalu buka http://localhost:3000
```
Scan jalan tiap close candle 4H + 30 detik. Setting disimpan di `data/config.json` (dibuat otomatis, contoh: `config.example.json`).
Ubah setting lalu **restart bot**. Kalau JSON rusak (misalnya kurang koma), bot **tidak dijalankan** dan menampilkan pesan error. Nama pengaturan yang salah ketik muncul sebagai peringatan di log dan di tab Konfigurasi. Posisi dan history ada di `data/state.json`.

Urutan prioritas pengaturan: **bawaan kode < `data/config.json` < variabel lingkungan `CONFIG_JSON`**. Cukup tulis bagian yang ingin diubah (digabung per bagian, bukan menimpa seluruhnya).

## Variabel lingkungan (opsional)
`PORT`, `DATA_DIR`, `CONFIG_JSON` (pengaturan lewat env, lihat bawah), `DASHBOARD_TOKEN` (**wajib di server publik**), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `COINGECKO_API_KEY` (Demo key gratis).

## Railway
1. Hubungkan repo, start command `npm start`.
2. Variabel: `DASHBOARD_TOKEN` (wajib), `DATA_DIR=/data`, opsional Telegram dan CoinGecko.
3. Tambahkan **Volume** di `/data` supaya posisi/history tidak hilang saat redeploy.
4. Pengaturan lewat variabel `CONFIG_JSON` (tanpa menyentuh volume), satu baris JSON, contoh:
   ```
   {"pairs":["HYPE-USDT"],"maxOpenPositions":3,"regime":{"enabled":true,"mode":"utvst"}}
   ```
   Ubah nilainya di Variables lalu redeploy. Tab Konfigurasi di dashboard menunjukkan sumber pengaturan yang aktif.

## Backtest (opsional)
```
node backtest.js --okx HYPE-USDT --bars 9000
node backtest.js data/HYPE-USDT-4H.csv --trailcompare      # juga --exitcompare, --slcompare
node portfolio.js --part 1/3 --bars 9000                   # unduh data (ulangi 2/3, 3/3)
node portfolio.js --maxpos 3 --bars 9000 --regimecompare
```

## Backtest futures (Bitget, 1H)
```
node futures_backtest.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --bar 1H --bars 9000 --lev 1,3
node futures_backtest.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --bar 1H --bars 9000 --regime utvst
node futures_backtest.js --universe --top 50 --bar 1H --bars 9000 --part 1/3    # unduh bertahap, lalu jalankan tanpa --part
```
Bot screener sendiri masih 4H / OKX / spot. Asumsi: fee taker 0,06%/sisi (cek tarif akunmu), funding 0,01%/8 jam dibayar kedua sisi, likuidasi aproksimasi.

## Catatan penting
- Hasil backtest tidak menjamin hasil nyata. Daftar koin memakai top CoinGecko hari ini (survivorship bias).
- Setting terbaik dipilih dari banyak percobaan pada data yang sama, jadi ada bias seleksi.
- **Lisensi:** Volume SuperTrend AI (c) Zeiierman, CC BY-NC-SA 4.0 (non-komersial, atribusi, share-alike). Jangan dijual atau dijadikan layanan berbayar. Disarankan repo **private**.
