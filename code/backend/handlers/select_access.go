package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/indraaryaLabs/pickframe/backend/middleware"
)

const selectCookieAge = 30 * time.Minute

// StartSelectSession is called from the authenticated workspace. The cookie is
// scoped to the API host and Select endpoints, so it cannot authorize unrelated
// workspace writes. It expires with the short-lived Supabase access token.
func (h *Handler) StartSelectSession(c *gin.Context) {
	userID := c.GetString(middleware.ContextUserIDKey)
	sub, err := langganan(h.DB, userID)
	if err != nil {
		c.JSON(503, gin.H{"error": "Paket belum dapat diperiksa. Coba lagi."})
		return
	}
	if !sub.Entitlements(time.Now().UTC()).PickframeSelect {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "PickFrame Select tersedia selama trial aktif atau dengan Pro/Studio.", "code": "subscription_required"})
		return
	}
	_, raw, _ := strings.Cut(c.GetHeader("Authorization"), " ")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Login kembali untuk membuka Select."})
		return
	}
	c.SetSameSite(http.SameSiteLaxMode)
	secure := !strings.HasPrefix(c.Request.Host, "localhost") && !strings.HasPrefix(c.Request.Host, "127.0.0.1")
	c.SetCookie("pf_select", raw, int(selectCookieAge.Seconds()), "/api/select/", "", secure, true)
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"allowed": true, "plan": sub.Plan})
}

func (h *Handler) CheckSelectAccess(c *gin.Context) {
	sub, err := langganan(h.DB, c.GetString(middleware.ContextUserIDKey))
	if err != nil {
		c.JSON(503, gin.H{"error": "Paket belum dapat diperiksa. Coba lagi."})
		return
	}
	if !sub.Entitlements(time.Now().UTC()).PickframeSelect {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "Trial aktif atau langganan Pro/Studio diperlukan untuk Select.", "code": "subscription_required"})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, gin.H{"allowed": true, "plan": sub.Plan})
}
