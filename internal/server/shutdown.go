package server

import (
	"context"
	"net/http"
	"time"
)

// Shutdown drains srv within grace and then closes whatever is left. A
// Shutdown that never returns is worse than a hard close: systemd sends
// SIGKILL after its own timeout and the database loses the clean close.
func Shutdown(ctx context.Context, srv *http.Server, grace time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, grace)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return srv.Close()
	}
	return nil
}
