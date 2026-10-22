package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func (r *Repo) SetSelfRolePolicy(ctx context.Context, community id.ID, approver id.ID, roles []id.ID, at int64) error {
	if !r.inTx {
		return fmt.Errorf("store: self role policy requires transaction")
	}
	if _, err := r.tx.ExecContext(ctx, `DELETE FROM self_role_policy WHERE community_id = ?`, community); err != nil {
		return wrap(err)
	}
	for _, role := range roles {
		if _, err := r.tx.ExecContext(ctx, `INSERT INTO self_role_policy(community_id,role_id,approved_by,approved_at) VALUES(?,?,?,?)`, community, role, approver, at); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (r *Repo) ListSelfRolePolicy(ctx context.Context, community id.ID) ([]store.SelfRolePolicyRow, error) {
	q := `SELECT community_id,role_id,approved_by,approved_at FROM self_role_policy WHERE community_id=? ORDER BY role_id`
	var rows *sql.Rows
	var err error
	if r.inTx {
		rows, err = r.tx.QueryContext(ctx, q, community)
	} else {
		rows, err = r.read.QueryContext(ctx, q, community)
	}
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []store.SelfRolePolicyRow{}
	for rows.Next() {
		var v store.SelfRolePolicyRow
		if err := rows.Scan(&v.CommunityID, &v.RoleID, &v.ApprovedBy, &v.ApprovedAt); err != nil {
			return nil, wrap(err)
		}
		out = append(out, v)
	}
	return out, wrap(rows.Err())
}

func (r *Repo) HasMemberRoleGrant(ctx context.Context, community, user, role id.ID, source store.RoleGrantSource) (bool, error) {
	q := `SELECT EXISTS(SELECT 1 FROM member_role_grant_sources WHERE community_id=? AND user_id=? AND role_id=? AND source=?)`
	var exists bool
	var err error
	if r.inTx {
		err = r.tx.QueryRowContext(ctx, q, community, user, role, string(source)).Scan(&exists)
	} else {
		err = r.read.QueryRowContext(ctx, q, community, user, role, string(source)).Scan(&exists)
	}
	return exists, wrap(err)
}
