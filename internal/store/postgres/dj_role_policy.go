package postgres

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func (r *Repo) SetDJRolePolicy(ctx context.Context, installation, approver id.ID, roles []id.ID, at int64) error {
	if !r.inTx {
		return fmt.Errorf("store: DJ role policy requires transaction")
	}
	if _, err := r.tx.ExecContext(ctx, `DELETE FROM dj_role_policy WHERE installation_id=$1`, installation); err != nil {
		return wrap(err)
	}
	for _, role := range roles {
		if _, err := r.tx.ExecContext(ctx, `INSERT INTO dj_role_policy(installation_id,role_id,approved_by,approved_at) VALUES($1,$2,$3,$4)`, installation, role, approver, at); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (r *Repo) ListDJRolePolicy(ctx context.Context, installation id.ID) ([]store.DJRolePolicyRow, error) {
	q := `SELECT installation_id,role_id,approved_by,approved_at FROM dj_role_policy WHERE installation_id=$1 ORDER BY role_id`
	var rows *sql.Rows
	var err error
	if r.inTx {
		rows, err = r.tx.QueryContext(ctx, q, installation)
	} else {
		rows, err = r.db.QueryContext(ctx, q, installation)
	}
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []store.DJRolePolicyRow{}
	for rows.Next() {
		var v store.DJRolePolicyRow
		if err := rows.Scan(&v.InstallationID, &v.RoleID, &v.ApprovedBy, &v.ApprovedAt); err != nil {
			return nil, wrap(err)
		}
		out = append(out, v)
	}
	return out, wrap(rows.Err())
}
