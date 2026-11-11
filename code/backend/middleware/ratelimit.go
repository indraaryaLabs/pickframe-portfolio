package middleware

import (
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// clientIPHeaderEnv memungkinkan header sumber IP diganti lewat Environment
// Variable tanpa mengubah kode. Ini disediakan karena kontrak header platform
// perlu dibuktikan di lingkungan nyata, bukan diasumsikan: lihat
// GET /api/debug/client-ip.
const clientIPHeaderEnv = "CLIENT_IP_HEADER"

// defaultClientIPHeaders adalah urutan header yang dicoba untuk menemukan IP
// klien, dari yang paling sulit dipalsukan.
//
// `x-forwarded-for` SENGAJA tidak ada di daftar ini. Header itu paling mudah
// dikirim sendiri oleh penyerang, dan kalau ia dipercaya begitu saja, satu
// header berbeda per request sudah cukup untuk mendapatkan bucket baru setiap
// kali — limiternya berubah jadi hiasan. Kalau pembuktian di produksi ternyata
// menunjukkan hanya header itu yang tersedia, setel CLIENT_IP_HEADER dan
// pastikan dulu platform menimpanya, bukan menambahkan ke nilai dari klien.
var defaultClientIPHeaders = []string{"x-vercel-forwarded-for", "x-real-ip"}

// Limiter membatasi jumlah percobaan yang gagal per IP dalam satu window.
type Limiter struct {
	db      *gorm.DB
	window  time.Duration
	max     int
	headers []string
}

// NewLimiter membuat Limiter yang mengizinkan max kegagalan per window per IP.
func NewLimiter(db *gorm.DB, window time.Duration, max int) *Limiter {
	headers := defaultClientIPHeaders
	if override := strings.TrimSpace(os.Getenv(clientIPHeaderEnv)); override != "" {
		headers = []string{strings.ToLower(override)}
		log.Printf("[INFO] Rate limit: sumber IP klien di-override ke header %q", headers[0])
	}
	return &Limiter{db: db, window: window, max: max, headers: headers}
}

// TooManyFailures mencatat satu percobaan gagal dari pemanggil dan melaporkan
// apakah batasnya sudah terlampaui.
//
// Hanya percobaan GAGAL yang dihitung. Klien sah membuka galerinya lewat magic
// link yang benar, kadang berkali-kali; menghitung request yang berhasil berarti
// mencekik pengguna yang sah. Penebak token, menurut definisinya, hanya
// menghasilkan kegagalan. Konsekuensi yang menguntungkan: request yang berhasil
// tidak membayar satu query tambahan pun.

func (l *Limiter) TooManyFailures(c *gin.Context) bool {
	ip, ok := l.clientIP(c)
	if !ok {
		// Tanpa IP yang bisa dipercaya, satu-satunya bucket yang tersisa adalah
		// bucket bersama untuk semua orang — dan itu berarti 20 percobaan dari
		// siapa pun akan mengunci galeri untuk SELURUH klien. Salah konfigurasi
		// tidak boleh berubah jadi pemadaman, jadi di sini limiternya dilewati
		// dan dicatat keras. Endpoint-nya masih dilindungi entropi token.
		log.Printf("[ERROR] Rate limit DILEWATI: IP klien tidak dapat ditentukan. " +
			"Periksa GET /api/debug/client-ip lalu setel " + clientIPHeaderEnv)
		return false
	}

	return tooManyHits(l.db, "magic_link_miss:"+ip, l.window, l.max)
}

// TooManyHits membatasi berapa kali sebuah bucket boleh terkena dalam satu
// window bergulir, TANPA syarat "hanya yang gagal" milik TooManyFailures.
//
// Dipisah sebagai bucket dan window sendiri, bukan menumpang milik Limiter
// yang sudah ada: yang dilindungi di sini adalah kuota egress per UNDUHAN
// (lihat handlers.GalleryDownloadSelected), sama sekali beda dari percobaan
// menebak magic link yang dilindungi TooManyFailures. Menyamakan keduanya ke
// satu bucket berarti klien sah yang mengunduh berkali-kali ikut menggerus
// jatah percobaan magic link-nya sendiri.
func (l *Limiter) TooManyHits(bucketKey string, window time.Duration, max int) bool {
	return tooManyHits(l.db, bucketKey, window, max)
}

// tooManyHits adalah SQL upsert bersama TooManyFailures dan TooManyHits.
//
// Difaktorkan ke satu fungsi, bukan disalin: dua salinan query fixed-window
// yang harus identik adalah bug yang menunggu giliran menyimpang diam-diam.
func tooManyHits(db *gorm.DB, bucketKey string, window time.Duration, max int) bool {
	var hits int
	err := db.Raw(`
INSERT INTO rate_limits (bucket_key, window_start, hit_count)
VALUES (?, now(), 1)
ON CONFLICT (bucket_key) DO UPDATE SET
  hit_count = CASE
    WHEN rate_limits.window_start < now() - make_interval(secs => ?)
    THEN 1 ELSE rate_limits.hit_count + 1 END,
  window_start = CASE
    WHEN rate_limits.window_start < now() - make_interval(secs => ?)
    THEN now() ELSE rate_limits.window_start END
RETURNING hit_count`,
		bucketKey, window.Seconds(), window.Seconds()).Scan(&hits).Error
	if err != nil {
		// Gagal menghitung bukan alasan menolak pengunjung. Lebih baik limiter
		// tidak aktif daripada fitur yang dijaganya ikut mati.
		log.Printf("[ERROR] Rate limit: gagal memperbarui penghitung bucket %q: %v", bucketKey, err)
		return false
	}

	// hit_count == 1 berarti window baru saja dimulai, jadi ini titik yang jarang
	// dan alami untuk membuang baris kedaluwarsa tanpa perlu cron.
	if hits == 1 {
		if err := db.Exec(
			`DELETE FROM rate_limits WHERE window_start < now() - make_interval(secs => ?)`,
			window.Seconds()*2,
		).Error; err != nil {
			log.Printf("[WARN] Rate limit: gagal membersihkan baris kedaluwarsa: %v", err)
		}
	}

	return hits > max
}

// clientIP mengembalikan IP pemanggil dari header pertama yang terisi.
//
// Nilai berisi daftar dipisah koma diambil elemen TERAKHIR-nya. Proxy yang
// benar MENAMBAHKAN alamat pengirim ke ujung kanan, sehingga elemen paling
// kanan adalah satu-satunya yang ditulis oleh proxy tepercaya; elemen di
// sebelah kirinya bisa saja dikirim sendiri oleh klien.
//
// gin.Context.ClientIP() sengaja tidak dipakai: secara bawaan ia mempercayai
// X-Forwarded-For dari siapa pun.
func (l *Limiter) clientIP(c *gin.Context) (string, bool) {
	for _, name := range l.headers {
		raw := strings.TrimSpace(c.GetHeader(name))
		if raw == "" {
			continue
		}
		parts := strings.Split(raw, ",")
		candidate := strings.TrimSpace(parts[len(parts)-1])
		if net.ParseIP(candidate) != nil {
			return candidate, true
		}
	}
	return "", false
}

// ClientIP mengembalikan IP klien lewat resolusi header yang sama dipakai
// TooManyFailures, supaya pemanggil lain bisa membangun bucket rate limit
// sendiri lewat TooManyHits (mis. rute invoice publik, yang butuh bucket
// terpisah dari percobaan magic link galeri -- lihat komentar TooManyHits di
// atas untuk kenapa dua kelas kegagalan tidak boleh berbagi satu bucket)
// tanpa menduplikasi logika resolusi IP.
func (l *Limiter) ClientIP(c *gin.Context) (string, bool) {
	return l.clientIP(c)
}

// DebugClientIP adalah endpoint diagnostik untuk membuktikan header mana yang
// benar-benar diset platform. Ia hanya memantulkan kembali apa yang dikirim
// pemanggil sendiri, tapi tetap dimatikan secara bawaan supaya nama header
// infrastruktur tidak terekspos tanpa alasan. Nyalakan dengan DEBUG_CLIENT_IP=1,
// buktikan, lalu matikan lagi.
func (l *Limiter) DebugClientIP(c *gin.Context) {
	if os.Getenv("DEBUG_CLIENT_IP") != "1" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
		return
	}

	resolved, ok := l.clientIP(c)
	c.JSON(http.StatusOK, gin.H{
		"resolved_ip":       resolved,
		"resolved":          ok,
		"headers_consulted": l.headers,
		"candidates": gin.H{
			"x-vercel-forwarded-for": c.GetHeader("x-vercel-forwarded-for"),
			"x-real-ip":              c.GetHeader("x-real-ip"),
			"x-forwarded-for":        c.GetHeader("x-forwarded-for"),
		},
		"remote_addr": c.Request.RemoteAddr,
	})
}

// MaxBodySize membatasi ukuran body request. Batas panjang per field pada
// binding tidak menolong di sini: validator baru berjalan setelah body dibaca,
// jadi body raksasa sudah menghabiskan memori sebelum aturan panjang sempat
// diterapkan.
func MaxBodySize(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}
