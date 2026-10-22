package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"math"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type rolePanelQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (r *Repo) SetRolePanel(ctx context.Context, panel store.RolePanelRow, options []store.RolePanelOptionRow) error {
	if !r.inTx {
		return fmt.Errorf("store: role panel write requires transaction")
	}
	if panel.CommunityID.IsZero() || panel.ChannelID.IsZero() || panel.MessageSeq == 0 || panel.MessageSeq > math.MaxInt64 || panel.AuthorID.IsZero() || panel.InstallationID.IsZero() || len(options) == 0 || len(options) > 100 {
		return fmt.Errorf("store: invalid role panel")
	}
	seen := map[string]bool{}
	for _, option := range options {
		if option.RoleID.IsZero() || len(option.Emoji) == 0 || len(option.Emoji) > 32 || seen[option.Emoji] {
			return fmt.Errorf("store: invalid role panel option")
		}
		seen[option.Emoji] = true
	}
	res, err := r.tx.ExecContext(ctx, `INSERT INTO role_panels(community_id,channel_id,message_seq,author_id,installation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id,message_seq) DO UPDATE SET community_id=excluded.community_id WHERE role_panels.community_id=excluded.community_id AND role_panels.author_id=excluded.author_id AND role_panels.installation_id=excluded.installation_id`, panel.CommunityID, panel.ChannelID, int64(panel.MessageSeq), panel.AuthorID, panel.InstallationID)
	if err != nil {
		return wrap(err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return store.ErrConflict
	}
	if _, err := r.tx.ExecContext(ctx, `DELETE FROM role_panel_options WHERE channel_id=$1 AND message_seq=$2`, panel.ChannelID, int64(panel.MessageSeq)); err != nil {
		return wrap(err)
	}
	for _, option := range options {
		if _, err := r.tx.ExecContext(ctx, `INSERT INTO role_panel_options(channel_id,message_seq,emoji,role_id) VALUES($1,$2,$3,$4)`, panel.ChannelID, int64(panel.MessageSeq), option.Emoji, option.RoleID); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (r *Repo) GetRolePanel(ctx context.Context, channel id.ID, seq uint64) (store.RolePanelRow, error) {
	if seq == 0 || seq > math.MaxInt64 {
		return store.RolePanelRow{}, store.ErrNotFound
	}
	var p store.RolePanelRow
	var q rolePanelQueryer = r.rawRead
	if r.inTx {
		q = r.tx
	}
	err := q.QueryRowContext(ctx, `SELECT community_id,channel_id,message_seq,author_id,installation_id FROM role_panels WHERE channel_id=$1 AND message_seq=$2`, channel, int64(seq)).Scan(&p.CommunityID, &p.ChannelID, &p.MessageSeq, &p.AuthorID, &p.InstallationID)
	return p, wrap(err)
}

func (r *Repo) ListRolePanelOptions(ctx context.Context, channel id.ID, seq uint64) ([]store.RolePanelOptionRow, error) {
	if seq == 0 || seq > math.MaxInt64 {
		return nil, store.ErrNotFound
	}
	var q rolePanelQueryer = r.rawRead
	if r.inTx {
		q = r.tx
	}
	rows, err := q.QueryContext(ctx, `SELECT emoji,role_id FROM role_panel_options WHERE channel_id=$1 AND message_seq=$2 ORDER BY emoji`, channel, int64(seq))
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []store.RolePanelOptionRow{}
	for rows.Next() {
		var v store.RolePanelOptionRow
		if err := rows.Scan(&v.Emoji, &v.RoleID); err != nil {
			return nil, wrap(err)
		}
		out = append(out, v)
	}
	return out, wrap(rows.Err())
}
