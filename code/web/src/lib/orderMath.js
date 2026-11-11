// Aritmetika order & pembayaran bersama -- dipakai fixture generator dan
// businessData.js supaya keduanya menghitung dengan rumus yang identik.
// Cermin dari helper BE-2 di rencana eksekusi (bagian 05); kalau backend
// sungguhan sudah hidup, angka yang dikembalikannya harus cocok persis
// dengan yang dihasilkan fungsi-fungsi ini.

/**
 * Σ(qty × unit_price) dari daftar tambahan pada order.
 *
 * `amount` yang tersimpan sengaja diabaikan, bukan dibaca: server menghitungnya
 * ulang dari qty × unit_price (lihat backend/handlers/order_helpers.go
 * buildOrderAddons), dan menghitung ulang di sini membuat `hitungTotalOrder`
 * bisa dipanggil dengan baris yang amount-nya belum terisi — yaitu keadaan
 * setiap tambahan yang baru diketik di form.
 *
 * @param {{qty:number, unit_price:number}[]} [addons]
 * @returns {number}
 */
export function hitungTotalTambahan(addons) {
  return (addons || []).reduce((s, a) => s + (Number(a.qty) || 0) * (Number(a.unit_price) || 0), 0);
}

/**
 * total = (harga paket + tambahan) − diskon.
 *
 * Cermin dari backend/handlers/order_helpers.go:hitungTotalOrder -- rumus,
 * batas diskon, dan syarat error harus sama persis, kalau tidak angka yang
 * dilihat fotografer sebelum menekan simpan akan berbeda dari yang tersimpan.
 *
 * Diskon dihitung terhadap harga paket + tambahan, bukan harga paket saja:
 * tambahan adalah bagian dari nilai yang sedang didiskonkan. Konsekuensinya
 * diskon ikut menutup tambahan, dan batasnya bergeser ke nilai total supaya
 * total tidak pernah negatif (diskon > nilai adalah 400 di server).
 */
export function hitungTotalOrder(hargaSnapshot, diskon, tambahan) {
  const h = Number(hargaSnapshot) || 0;
  const d = Number(diskon) || 0;
  const nilai = h + hitungTotalTambahan(tambahan);
  if (d > nilai) throw new Error('Diskon tidak boleh lebih besar dari nilai order.');
  return nilai - d;
}

/** SUM(payments.amount) untuk satu order -- amount_paid tidak pernah disimpan. */
export function hitungAmountPaid(orderId, payments) {
  return payments
    .filter((p) => p.order_id === orderId)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

/**
 * unpaid / partial / paid dari total terbayar vs total order.
 *
 * Bayar lebih (kelebihan transfer) tetap `paid`, tidak error -- lihat
 * "Selesai bila" BE-2 di rencana eksekusi.
 *
 * totalBayar >= totalOrder DIPERIKSA LEBIH DULU, sebelum totalBayar <= 0:
 * order bertotal nol (diskon menutup seluruh harga paket, atau paket lepas
 * yang sengaja diketik gratis) harus terbaca "paid" walau belum ada satu pun
 * pembayaran tercatat -- tidak ada yang perlu dibayar, jadi "unpaid" akan
 * salah menagih. Urutan ini cermin persis perbaikan yang sama di
 * backend/handlers/order_helpers.go:paymentStatusFor.
 */
export function hitungPaymentStatus(totalBayar, totalOrder) {
  if (totalBayar >= totalOrder) return 'paid';
  if (totalBayar <= 0) return 'unpaid';
  return 'partial';
}

export function hitungBalance(totalOrder, totalBayar) {
  return Math.max(0, (Number(totalOrder) || 0) - (Number(totalBayar) || 0));
}

/** lines[] -> subtotal, dihitung ulang dari qty*unit_price -- nilai amount klien diabaikan. */
export function hitungSubtotalLines(lines) {
  return (lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
}

/**
 * Bentuk kanonik satu baris tambahan: hanya tiga field yang dipakai server, tanpa
 * `amount` (server menghitungnya sendiri) dan tanpa spasi pinggir.
 *
 * Baris yang benar-benar kosong DIBUANG. Menambah baris lalu meninggalkannya
 * kosong adalah hal normal saat mengetik -- menyampaikannya ke server hanya
 * menghasilkan 400 untuk sesuatu yang memang belum sempat diisi.
 */
export function normalisasiTambahan(tambahan) {
  return (tambahan || [])
    .filter((a) => String(a.label ?? '').trim() !== '' || Number(a.qty) > 0 || Number(a.unit_price) > 0)
    .map((a) => ({
      label: String(a.label ?? '').trim(),
      qty: Number(a.qty) || 0,
      unit_price: Number(a.unit_price) || 0,
    }));
}

/**
 * Apakah daftar tambahan berubah sehingga layak dikirim?
 *
 * Guard ini yang mencegah keystroke kosong menghapus tambahan yang sudah ada.
 * Tanpa perbandingan, setiap penyimpanan order yang tidak menyentuh tambahan
 * akan mengirim `addons: []` -- dan mengosongkan daftarnya.
 */
export function tambahanBerubah(sebelum, sesudah) {
  return JSON.stringify(normalisasiTambahan(sebelum)) !== JSON.stringify(normalisasiTambahan(sesudah));
}

/**
 * Baris tambahan yang tidak boleh dikirim: label kosong, atau qty di bawah 1.
 *
 * Server menolak keduanya dengan 400 (binding `required` dan `min=1`), jadi
 * lebih baik menahan tombol simpan di sini daripada membiarkan fotografer
 * menekan simpan lalu membaca pesan dari server.
 */
export function tambahanValid(tambahan) {
  return normalisasiTambahan(tambahan).every((a) => a.label !== '' && a.qty >= 1 && a.unit_price >= 0);
}
