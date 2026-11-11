# Arsitektur PickFrame

Dokumen ini menjelaskan cara sistem PickFrame bekerja. Ini adalah deskripsi arsitektur dari produk yang berjalan di produksi; cuplikan kode terkait ada di [code/](code).

## Gambaran umum

```
┌──────────────────────────────────────────────────────────────────────┐
│ KLIEN & STUDIO │
│ │
│ Studio (login Supabase) Klien foto (tanpa akun) │
│ ┌──────────────────────┐ ┌────────────────────────┐ │
│ │ Portal web React 19 │ │ Galeri tautan token │ │
│ │ workspace + galeri │ │ dokumen publik │ │
│ │ dokumen + laporan │ │ │ │
│ └──────────┬───────────┘ └──────────┬─────────────┘ │
│ │ VITE_ / HTTP │ token magic link │
└─────────────┼──────────────────────────────┼─────────────────────────┘
 ▼ ▼
┌──────────────────────────────────────────────────────────────────────┐
│ API Go (Gin) di Vercel │
│ │
│ middleware/auth.go verifikasi JWT via JWKS, asimetris │
│ middleware/ratelimit.go fixed-window per IP, upsert PostgreSQL │
│ handlers/* galeri, order, dokumen, pembayaran, kuota │
│ blobstore ZIP unduhan opsional ke Storage signed URL │
└───────┬───────────────────────────────┬──────────────────────────────┘
 │ │
 ▼ ▼
┌──────────────────────┐ ┌──────────────────────┐
│ Supabase Postgres │ │ Google Drive API │
│ + Row Level Security │ │ (hanya baca folder │
│ Auth / JWKS │ │ yang dibagikan) │
└──────────────────────┘ └──────────────────────┘
```

**PickFrame Select** (PWA) berjalan sepenuhnya di perangkat fotografer: ia mengunduh daftar nama berkas terpilih (manifest `.pickframe`), lalu mencocokkannya dengan berkas RAW/JPG/XMP di disk lokal. Foto tidak diunggah ke mana pun melalui Select.

## Autentikasi

- Studio login melalui **Supabase Auth**. Supabase menerbitkan JWT (RS256/ES256).
- Backend Go **tidak memegang kunci privat**. Ia memverifikasi token lewat endpoint **JWKS** project (`<supabase-url>/auth/v1/.well-known/jwks.json`), dengan:
 - **Whitelist algoritma** (`ES256`, `RS256`) - token HS256 ditolak walau signature cocok, menutup celah *algorithm confusion*.
 - Pengecekan `iss` (diturunkan dari `SUPABASE_URL`), `aud` = `authenticated`, dan `exp` wajib.
 - **Lazy JWKS load** - penarikan kunci tidak berada di jalur cold start rute publik.
 - Pemisahan balasan `auth_unavailable` (503) dari `unauthorized` (401): kalau JWKS kosong karena outage, token yang sah tidak diberhentikan secara keliru.
- Middleware **hanya menetapkan identitas** (`user_id` di context). Kepemilikan resource diperiksa di handler lewat filter `WHERE user_id = ?` dan **Row Level Security** di PostgreSQL.

## Akses tanpa akun (galeri & dokumen)

Klien fotografer tidak membuat akun:

1. Studio membagikan folder Google Drive sebagai *Anyone with the link*.
2. API membaca isi folder itu lewat **Google Drive API** (API key yang dibatasi ke Drive saja) dan menyimpan **referensi foto**, bukan berkasnya.
3. Studio menerbitkan **magic link** dengan token acak berentropi tinggi; token dapat dicabut.
4. Backend menerbitkan sesi galeri dari token; percobaan menebak dihitung di tabel `rate_limits` - **hanya percobaan gagal** yang dihitung, sehingga klien sah yang membuka galerinya berulang kali tidak pernah dicekik.
5. Aplikasi pendamping **Select** menerima sesi browser berumur pendek lewat cookie `HttpOnly` host-only (bukan JWT di URL atau pesan lintas-window), dan entitlement langganan diperiksa ulang di server saat sesi dibuka.

## Kuota dan langganan

- Paket: **Free** (kuota mingguan), **Pro**, **Studio** (kuota bulanan), ditambah **trial** 24 jam sekali pakai.
- Kuota ditegakkan **atomik** di PostgreSQL - dua request bersamaan tidak dapat melampaui batas dengan terus-menerus memaksa kondisi lomba.
- Menghapus proyek/galeri/dokumen tidak mengembalikan kuota yang sudah terpakai.
- Backend tidak pernah menyimpan `amount_paid`: total terbayar selalu `SUM(payments.amount)` sehingga riwayat pembayaran tetap dapat dikoreksi.

## Dokumen & pembayaran

- Invoice DP / pelunasan / penuh dan kuitansi berbentuk dokumen kanonik: nilai disimpan sebagai data, tampilan (PDF cetak, PNG/JPG ekspor) dihasilkan dari data yang sama.
- Dokumen dapat diarsipkan atau dipublikasikan lewat tautan bertoken.
- Status pembayaran (`unpaid`/`partial`/`paid`) dihitung ulang, bukan disimpan; `totalBayar >= totalOrder` diperiksa lebih dulu daripada `totalBayar <= 0` agar order bernilai nol tetap terbaca `paid`.

## Laporan

- Laporan proyek, pembayaran, dan tagihan diekspor sebagai **buku Excel** (ExcelJS) di sisi frontend, termasuk grafik dan lembar ringkasan.
- Paket Studio dapat **memperbarui buku Excel yang sudah ada** - perubahan yang dibuat pemilik buku di luar area laporan dipertahankan.

## Keamanan secara ringkas

| Ancaman | Mitigasi |
| --- | --- |
| Pemalsuan token | Verifikasi asimetris JWKS, whitelist algoritma, cek `iss`/`aud`/`exp` |
| Brute-force magic link | Rate limit fixed-window per IP, hanya kegagalan yang dihitung |
| Spoofing IP via header | `X-Forwarded-For` tidak dipercaya; hanya header yang ditetapkan platform (`x-vercel-forwarded-for`, `x-real-ip`) |
| Body raksasa | `http.MaxBytesReader` sebelum binding/validasi |
| Akses lintas tenant | RLS PostgreSQL + filter `user_id` di handler |
| Kebocoran secret | Semua nilai via environment variable; frontend hanya menerima nilai publik `VITE_*` |
| Session Select dibajak | Cookie `HttpOnly`, `SameSite=Lax`, host-only, umur 30 menit, entitlement dicek ulang di server |

## Deploy

- **Frontend & Select**: Vercel (portal di `pickframe.satuarah.click`, Select di `select-pickframe.satuarah.click`).
- **API**: fungsi serverless Vercel dari satu biner Go (`backend/api/index.go`).
- **Basis data**: Supabase Postgres dengan migrasi skema terpisah dari startup aplikasi.
- Backup harian terenkripsi menjaga metadata penting (pilihan klien, riwayat pembayaran); foto sumber tetap milik studio di Google Drive.
