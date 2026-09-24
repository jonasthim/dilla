package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres/pgdb"
)

// Repo adapts the generated pgdb.Querier to store.Repository. Postgres needs no
// writer/reader split — MVCC readers never block the writer — so r.w and r.r are
// bound to the same pool; inside a Tx both point at the transaction, so a
// read-your-writes sequence sees its own uncommitted rows.
type Repo struct {
	db      *sql.DB
	w       *pgdb.Queries // bound to db (or to the tx)
	r       *pgdb.Queries // bound to db (or to the tx)
	inTx    bool
	rawRead *sql.DB
}

// New returns the Postgres repository over an already-migrated database.
func New(db *sql.DB) store.Repository {
	q := pgdb.New(db)
	return &Repo{db: db, w: q, r: q, rawRead: db}
}

func (r *Repo) Close() error {
	if r.db == nil {
		return nil
	}
	return r.db.Close()
}

// Tx runs fn inside one transaction.
func (r *Repo) Tx(ctx context.Context, fn func(store.Repository) error) error {
	if r.inTx {
		return errors.New("store: nested transaction")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	q := pgdb.New(tx)
	sub := &Repo{db: r.db, w: q, r: q, inTx: true, rawRead: r.rawRead}
	if err := fn(sub); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
			return errors.Join(err, fmt.Errorf("store: rollback: %w", rbErr))
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}

// wrap turns driver errors into the package's three sentinels. Postgres spells
// a unique violation as SQLSTATE 23505 on a *pgconn.PgError, not as a message
// substring.
func wrap(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sql.ErrNoRows):
		return store.ErrNotFound
	default:
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			return fmt.Errorf("%w: %v", store.ErrConflict, err)
		}
		return err
	}
}

// nullInt64 and ptrInt64 convert between the store's nullable timestamps and
// the generated code's sql.NullInt64.
func nullInt64(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func ptrInt64(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

// ---------------------------------------------------------------- Instance

func (r *Repo) CreateInstance(ctx context.Context, in store.InstanceRow) error {
	return wrap(r.w.CreateInstance(ctx, pgdb.CreateInstanceParams{
		InstanceID:          in.InstanceID,
		ExternalSenderKeyID: in.ExternalSenderKeyID,
		KeyHistory:          in.KeyHistory,
		FrankingKeyID:       in.FrankingKeyID,
		Generation:          int64(in.Generation),
		PolicyVersion:       int64(in.PolicyVersion),
		Created:             in.Created,
	}))
}

func (r *Repo) GetInstance(ctx context.Context) (store.InstanceRow, error) {
	row, err := r.r.GetInstance(ctx)
	if err != nil {
		return store.InstanceRow{}, wrap(err)
	}
	return store.InstanceRow{
		InstanceID:          row.InstanceID,
		ExternalSenderKeyID: row.ExternalSenderKeyID,
		KeyHistory:          row.KeyHistory,
		FrankingKeyID:       row.FrankingKeyID,
		Generation:          uint64(row.Generation),
		PolicyVersion:       uint64(row.PolicyVersion),
		Created:             row.Created,
	}, nil
}

func (r *Repo) BumpGeneration(ctx context.Context) (uint64, error) {
	gen, err := r.w.BumpGeneration(ctx)
	if err != nil {
		return 0, wrap(err)
	}
	return uint64(gen), nil
}

func (r *Repo) GetSetting(ctx context.Context, key string) ([]byte, error) {
	v, err := r.r.GetSetting(ctx, pgdb.GetSettingParams{Key: key})
	return v, wrap(err)
}

func (r *Repo) PutSetting(ctx context.Context, key string, value []byte, updated int64) error {
	return wrap(r.w.PutSetting(ctx, pgdb.PutSettingParams{Key: key, Value: value, Updated: updated}))
}

// ---------------------------------------------------------------- Accounts

func (r *Repo) CreateUser(ctx context.Context, u store.UserRow) error {
	return wrap(r.w.CreateUser(ctx, pgdb.CreateUserParams{
		ID:         u.ID,
		Username:   u.Username,
		Display:    u.Display,
		Kind:       int64(u.Kind),
		UmkPub:     u.UMKPub,
		SskPub:     u.SSKPub,
		SigUmkSsk:  u.SigUMKSSK,
		Flags:      int64(u.Flags),
		AgeBracket: int64(u.AgeBracket),
		Created:    u.Created,
		DisabledAt: nullInt64(u.DisabledAt),
		DeletedAt:  nullInt64(u.DeletedAt),
	}))
}

func (r *Repo) GetUser(ctx context.Context, userID id.ID) (store.UserRow, error) {
	row, err := r.r.GetUser(ctx, pgdb.GetUserParams{ID: userID})
	if err != nil {
		return store.UserRow{}, wrap(err)
	}
	return userRow(row), nil
}

func (r *Repo) GetUserByUsername(ctx context.Context, username string) (store.UserRow, error) {
	row, err := r.r.GetUserByUsername(ctx, pgdb.GetUserByUsernameParams{Username: username})
	if err != nil {
		return store.UserRow{}, wrap(err)
	}
	return userRow(row), nil
}

func (r *Repo) ListUsers(ctx context.Context, after id.ID, limit int32) ([]store.UserRow, error) {
	rows, err := r.r.ListUsers(ctx, pgdb.ListUsersParams{ID: after, MaxRows: int64(limit)})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.UserRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, userRow(row))
	}
	return out, nil
}

func (r *Repo) SetUserDisabled(ctx context.Context, userID id.ID, at *int64) error {
	return wrap(r.w.SetUserDisabled(ctx, pgdb.SetUserDisabledParams{
		DisabledAt: nullInt64(at),
		ID:         userID,
	}))
}

func (r *Repo) TombstoneUser(ctx context.Context, userID id.ID, at int64) error {
	return wrap(r.w.TombstoneUser(ctx, pgdb.TombstoneUserParams{
		DeletedAt: nullInt64(&at),
		ID:        userID,
	}))
}

func userRow(row pgdb.Users) store.UserRow {
	return store.UserRow{
		ID:         row.ID,
		Username:   row.Username,
		Display:    row.Display,
		Kind:       uint8(row.Kind),
		UMKPub:     row.UmkPub,
		SSKPub:     row.SskPub,
		SigUMKSSK:  row.SigUmkSsk,
		Flags:      uint64(row.Flags),
		AgeBracket: uint64(row.AgeBracket),
		Created:    row.Created,
		DisabledAt: ptrInt64(row.DisabledAt),
		DeletedAt:  ptrInt64(row.DeletedAt),
	}
}

// ---------------------------------------------------------------- Devices

func (r *Repo) CreateDevice(ctx context.Context, d store.DeviceRow) error {
	return wrap(r.w.CreateDevice(ctx, pgdb.CreateDeviceParams{
		ID:               d.ID,
		UserID:           d.UserID,
		DskPub:           d.DSKPub,
		Tier:             int64(d.Tier),
		SignerTier:       int64(d.SignerTier),
		CredentialBlob:   d.CredentialBlob,
		VerifiedAt:       nullInt64(d.VerifiedAt),
		RevokedAt:        nullInt64(d.RevokedAt),
		QuarantinedAt:    nullInt64(d.QuarantinedAt),
		QuarantineReason: d.QuarantineReason,
		LastSeen:         d.LastSeen,
		Created:          d.Created,
	}))
}

func (r *Repo) GetDevice(ctx context.Context, deviceID id.ID) (store.DeviceRow, error) {
	row, err := r.r.GetDevice(ctx, pgdb.GetDeviceParams{ID: deviceID})
	if err != nil {
		return store.DeviceRow{}, wrap(err)
	}
	return deviceRow(row), nil
}

func (r *Repo) ListDevicesByUser(ctx context.Context, userID id.ID) ([]store.DeviceRow, error) {
	rows, err := r.r.ListDevicesByUser(ctx, pgdb.ListDevicesByUserParams{UserID: userID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.DeviceRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, deviceRow(row))
	}
	return out, nil
}

func (r *Repo) TouchDevice(ctx context.Context, deviceID id.ID, lastSeen int64) error {
	return wrap(r.w.TouchDevice(ctx, pgdb.TouchDeviceParams{LastSeen: lastSeen, ID: deviceID}))
}

func (r *Repo) RevokeDevice(ctx context.Context, deviceID id.ID, at int64) error {
	return wrap(r.w.RevokeDevice(ctx, pgdb.RevokeDeviceParams{
		RevokedAt: nullInt64(&at),
		ID:        deviceID,
	}))
}

func (r *Repo) PutDeviceList(ctx context.Context, l store.DeviceListRow) error {
	return wrap(r.w.PutDeviceList(ctx, pgdb.PutDeviceListParams{
		UserID:       l.UserID,
		Version:      int64(l.Version),
		Blob:         l.Blob,
		SskSignature: l.SSKSignature,
		PrevHash:     l.PrevHash,
		Created:      l.Created,
	}))
}

func (r *Repo) GetDeviceList(ctx context.Context, userID id.ID) (store.DeviceListRow, error) {
	row, err := r.r.GetDeviceList(ctx, pgdb.GetDeviceListParams{UserID: userID})
	if err != nil {
		return store.DeviceListRow{}, wrap(err)
	}
	return store.DeviceListRow{
		UserID:       row.UserID,
		Version:      uint64(row.Version),
		Blob:         row.Blob,
		SSKSignature: row.SskSignature,
		PrevHash:     row.PrevHash,
		Created:      row.Created,
	}, nil
}

func deviceRow(row pgdb.Devices) store.DeviceRow {
	return store.DeviceRow{
		ID:               row.ID,
		UserID:           row.UserID,
		DSKPub:           row.DskPub,
		Tier:             uint8(row.Tier),
		SignerTier:       uint8(row.SignerTier),
		CredentialBlob:   row.CredentialBlob,
		VerifiedAt:       ptrInt64(row.VerifiedAt),
		RevokedAt:        ptrInt64(row.RevokedAt),
		QuarantinedAt:    ptrInt64(row.QuarantinedAt),
		QuarantineReason: row.QuarantineReason,
		LastSeen:         row.LastSeen,
		Created:          row.Created,
	}
}

// ---------------------------------------------------------------- Sessions

func (r *Repo) CreateSession(ctx context.Context, s store.SessionRow) error {
	return wrap(r.w.CreateSession(ctx, pgdb.CreateSessionParams{
		TokenHash:   s.TokenHash,
		DeviceID:    s.DeviceID,
		UserID:      s.UserID,
		Scope:       int64(s.Scope),
		Tier:        int64(s.Tier),
		Created:     s.Created,
		Expires:     s.Expires,
		IdleExpires: s.IdleExpires,
	}))
}

func (r *Repo) GetSessionByHash(ctx context.Context, tokenHash []byte, now int64) (store.SessionRow, error) {
	row, err := r.r.GetSessionByHash(ctx, pgdb.GetSessionByHashParams{
		TokenHash:   tokenHash,
		Expires:     now,
		IdleExpires: now,
	})
	if err != nil {
		return store.SessionRow{}, wrap(err)
	}
	return store.SessionRow{
		TokenHash:   row.TokenHash,
		DeviceID:    row.DeviceID,
		UserID:      row.UserID,
		Scope:       uint8(row.Scope),
		Tier:        uint8(row.Tier),
		Created:     row.Created,
		Expires:     row.Expires,
		IdleExpires: row.IdleExpires,
	}, nil
}

func (r *Repo) TouchSession(ctx context.Context, tokenHash []byte, idleExpires int64) error {
	return wrap(r.w.TouchSession(ctx, pgdb.TouchSessionParams{
		IdleExpires: idleExpires,
		TokenHash:   tokenHash,
	}))
}

func (r *Repo) DeleteSession(ctx context.Context, tokenHash []byte) error {
	return wrap(r.w.DeleteSession(ctx, pgdb.DeleteSessionParams{TokenHash: tokenHash}))
}

func (r *Repo) DeleteSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error) {
	n, err := r.w.DeleteSessionsByDevice(ctx, pgdb.DeleteSessionsByDeviceParams{DeviceID: deviceID})
	return n, wrap(err)
}

func (r *Repo) DeleteSessionsByUser(ctx context.Context, userID id.ID) (int64, error) {
	n, err := r.w.DeleteSessionsByUser(ctx, pgdb.DeleteSessionsByUserParams{UserID: userID})
	return n, wrap(err)
}

func (r *Repo) CountSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error) {
	n, err := r.r.CountSessionsByDevice(ctx, pgdb.CountSessionsByDeviceParams{DeviceID: deviceID})
	return n, wrap(err)
}

func (r *Repo) DeleteOldestSessionForDevice(ctx context.Context, deviceID id.ID) error {
	return wrap(r.w.DeleteOldestSessionForDevice(ctx, pgdb.DeleteOldestSessionForDeviceParams{
		DeviceID: deviceID,
	}))
}

func (r *Repo) PruneSessions(ctx context.Context, now int64) (int64, error) {
	n, err := r.w.PruneSessions(ctx, pgdb.PruneSessionsParams{Expires: now, IdleExpires: now})
	return n, wrap(err)
}

// ---------------------------------------------------------------- Auth

func (r *Repo) PutPasswordCredential(ctx context.Context, userID id.ID, phc string, updated int64) error {
	return wrap(r.w.PutPasswordCredential(ctx, pgdb.PutPasswordCredentialParams{
		UserID:  userID,
		Phc:     phc,
		Updated: updated,
	}))
}

func (r *Repo) GetPasswordCredential(ctx context.Context, userID id.ID) (string, error) {
	phc, err := r.r.GetPasswordCredential(ctx, pgdb.GetPasswordCredentialParams{UserID: userID})
	return phc, wrap(err)
}

func (r *Repo) PutTOTP(ctx context.Context, t store.TOTPRow) error {
	return wrap(r.w.PutTOTP(ctx, pgdb.PutTOTPParams{
		UserID:      t.UserID,
		Secret:      t.Secret,
		Digits:      int64(t.Digits),
		Period:      int64(t.Period),
		Algorithm:   t.Algorithm,
		ConfirmedAt: nullInt64(t.ConfirmedAt),
		LastCounter: t.LastCounter,
		Created:     t.Created,
	}))
}

func (r *Repo) GetTOTP(ctx context.Context, userID id.ID) (store.TOTPRow, error) {
	row, err := r.r.GetTOTP(ctx, pgdb.GetTOTPParams{UserID: userID})
	if err != nil {
		return store.TOTPRow{}, wrap(err)
	}
	return store.TOTPRow{
		UserID:      row.UserID,
		Secret:      row.Secret,
		Digits:      uint64(row.Digits),
		Period:      uint64(row.Period),
		Algorithm:   row.Algorithm,
		ConfirmedAt: ptrInt64(row.ConfirmedAt),
		LastCounter: row.LastCounter,
		Created:     row.Created,
	}, nil
}

// ConsumeTOTPCounter is the replay guard: the UPDATE only fires while the
// presented counter is strictly greater than the stored one, so a code accepted
// once cannot be presented again.
func (r *Repo) ConsumeTOTPCounter(ctx context.Context, userID id.ID, counter int64) error {
	n, err := r.w.ConsumeTOTPCounter(ctx, pgdb.ConsumeTOTPCounterParams{
		LastCounter:   counter,
		UserID:        userID,
		LastCounter_2: counter,
	})
	if err != nil {
		return wrap(err)
	}
	if n != 1 {
		return store.ErrConflict
	}
	return nil
}

// PutRecoveryCodes replaces the whole set in one transaction: regenerating
// invalidates every unconsumed code (facts-auth §2.5).
//
// Every multi-statement method is split in two: an inner form that assumes an
// open transaction, and an exported form that opens one only when it is not
// already inside one. Without the split, a caller that legitimately needs
// atomicity across two of these — task 9's TOTP-confirm writes the TOTP row and
// its recovery codes together — gets `store: nested transaction` from Tx.
func (r *Repo) PutRecoveryCodes(ctx context.Context, userID id.ID, hashes [][]byte, created int64) error {
	if r.inTx {
		return r.putRecoveryCodesTx(ctx, r.w, userID, hashes, created)
	}
	return r.Tx(ctx, func(tx store.Repository) error {
		sub := tx.(*Repo)
		return sub.putRecoveryCodesTx(ctx, sub.w, userID, hashes, created)
	})
}

func (r *Repo) putRecoveryCodesTx(ctx context.Context, q *pgdb.Queries, userID id.ID, hashes [][]byte, created int64) error {
	if err := q.DeleteRecoveryCodes(ctx, pgdb.DeleteRecoveryCodesParams{UserID: userID}); err != nil {
		return wrap(err)
	}
	for _, h := range hashes {
		if err := q.PutRecoveryCode(ctx, pgdb.PutRecoveryCodeParams{
			UserID: userID, CodeHash: h, Created: created,
		}); err != nil {
			return wrap(err)
		}
	}
	return nil
}

// ConsumeRecoveryCode marks one unused code used. A code that does not exist and
// a code already spent are the same answer to the caller: ErrNotFound.
func (r *Repo) ConsumeRecoveryCode(ctx context.Context, userID id.ID, hash []byte, at int64) error {
	n, err := r.w.ConsumeRecoveryCode(ctx, pgdb.ConsumeRecoveryCodeParams{
		UsedAt:   nullInt64(&at),
		UserID:   userID,
		CodeHash: hash,
	})
	if err != nil {
		return wrap(err)
	}
	if n != 1 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) CountRecoveryCodes(ctx context.Context, userID id.ID) (int64, error) {
	n, err := r.r.CountRecoveryCodes(ctx, pgdb.CountRecoveryCodesParams{UserID: userID})
	return n, wrap(err)
}

func (r *Repo) PutWebauthnUser(ctx context.Context, userID id.ID, rpID string, handle []byte, created int64) error {
	return wrap(r.w.PutWebauthnUser(ctx, pgdb.PutWebauthnUserParams{
		RpID:       rpID,
		UserID:     userID,
		UserHandle: handle,
		Created:    created,
	}))
}

func (r *Repo) GetWebauthnUserHandle(ctx context.Context, rpID string, userID id.ID) ([]byte, error) {
	h, err := r.r.GetWebauthnUserHandle(ctx, pgdb.GetWebauthnUserHandleParams{
		RpID:   rpID,
		UserID: userID,
	})
	return h, wrap(err)
}

func (r *Repo) GetWebauthnUserByHandle(ctx context.Context, rpID string, handle []byte) (id.ID, error) {
	userID, err := r.r.GetWebauthnUserByHandle(ctx, pgdb.GetWebauthnUserByHandleParams{
		RpID:       rpID,
		UserHandle: handle,
	})
	if err != nil {
		return id.Zero, wrap(err)
	}
	return userID, nil
}

func (r *Repo) PutWebauthnCredential(ctx context.Context, c store.WebauthnCredentialRow) error {
	return wrap(r.w.PutWebauthnCredential(ctx, pgdb.PutWebauthnCredentialParams{
		CredID:            c.CredID,
		RpID:              c.RPID,
		UserID:            c.UserID,
		PublicKey:         c.PublicKey,
		SignCount:         c.SignCount,
		AttestationType:   c.AttestationType,
		AttestationFormat: c.AttestationFormat,
		Transports:        c.Transports,
		Flags:             c.Flags,
		ExtensionsJson:    c.ExtensionsJSON,
		Name:              c.Name,
		Created:           c.Created,
		LastUsed:          nullInt64(c.LastUsed),
	}))
}

func (r *Repo) ListWebauthnCredentials(ctx context.Context, userID id.ID, rpID string) ([]store.WebauthnCredentialRow, error) {
	rows, err := r.r.ListWebauthnCredentials(ctx, pgdb.ListWebauthnCredentialsParams{
		RpID:   rpID,
		UserID: userID,
	})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.WebauthnCredentialRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, webauthnCredentialRow(row))
	}
	return out, nil
}

func (r *Repo) GetWebauthnCredential(ctx context.Context, credID []byte) (store.WebauthnCredentialRow, error) {
	row, err := r.r.GetWebauthnCredential(ctx, pgdb.GetWebauthnCredentialParams{CredID: credID})
	if err != nil {
		return store.WebauthnCredentialRow{}, wrap(err)
	}
	return webauthnCredentialRow(row), nil
}

func (r *Repo) UpdateWebauthnCredential(ctx context.Context, credID []byte, signCount int64, flags []byte, lastUsed int64) error {
	return wrap(r.w.UpdateWebauthnCredential(ctx, pgdb.UpdateWebauthnCredentialParams{
		SignCount: signCount,
		Flags:     flags,
		LastUsed:  nullInt64(&lastUsed),
		CredID:    credID,
	}))
}

func webauthnCredentialRow(row pgdb.WebauthnCredentials) store.WebauthnCredentialRow {
	return store.WebauthnCredentialRow{
		CredID:            row.CredID,
		RPID:              row.RpID,
		UserID:            row.UserID,
		PublicKey:         row.PublicKey,
		SignCount:         row.SignCount,
		AttestationType:   row.AttestationType,
		AttestationFormat: row.AttestationFormat,
		Transports:        row.Transports,
		Flags:             row.Flags,
		ExtensionsJSON:    row.ExtensionsJson,
		Name:              row.Name,
		Created:           row.Created,
		LastUsed:          ptrInt64(row.LastUsed),
	}
}

func (r *Repo) PutCeremony(ctx context.Context, c store.CeremonyRow) error {
	return wrap(r.w.PutCeremony(ctx, pgdb.PutCeremonyParams{
		ID:          c.ID,
		Kind:        int64(c.Kind),
		UserID:      c.UserID,
		SessionJson: c.SessionJSON,
		Created:     c.Created,
		Expires:     c.Expires,
	}))
}

// TakeCeremony is single use: read and delete in one transaction, and treat a
// zero-row delete as "someone else took it" rather than as success. Same split
// as PutRecoveryCodes.
func (r *Repo) TakeCeremony(ctx context.Context, ceremonyID id.ID, now int64) (store.CeremonyRow, error) {
	if r.inTx {
		return r.takeCeremonyTx(ctx, r.w, ceremonyID, now)
	}
	var out store.CeremonyRow
	err := r.Tx(ctx, func(tx store.Repository) error {
		sub := tx.(*Repo)
		var err error
		out, err = sub.takeCeremonyTx(ctx, sub.w, ceremonyID, now)
		return err
	})
	return out, err
}

func (r *Repo) takeCeremonyTx(ctx context.Context, q *pgdb.Queries, ceremonyID id.ID, now int64) (store.CeremonyRow, error) {
	row, err := q.GetCeremony(ctx, pgdb.GetCeremonyParams{ID: ceremonyID, Expires: now})
	if err != nil {
		return store.CeremonyRow{}, wrap(err)
	}
	n, err := q.DeleteCeremony(ctx, pgdb.DeleteCeremonyParams{ID: ceremonyID})
	if err != nil {
		return store.CeremonyRow{}, wrap(err)
	}
	if n != 1 {
		return store.CeremonyRow{}, store.ErrNotFound
	}
	// SessionJson, not SessionJSON: that is sqlc's spelling of the column, and
	// this conversion is the only place in the tree that uses it.
	return store.CeremonyRow{
		ID: row.ID, Kind: uint8(row.Kind), UserID: row.UserID,
		SessionJSON: row.SessionJson, Created: row.Created, Expires: row.Expires,
	}, nil
}

func (r *Repo) PruneCeremonies(ctx context.Context, now int64) (int64, error) {
	n, err := r.w.PruneCeremonies(ctx, pgdb.PruneCeremoniesParams{Expires: now})
	return n, wrap(err)
}

func (r *Repo) PutOIDCIdentity(ctx context.Context, issuer, subject string, userID id.ID, created int64) error {
	return wrap(r.w.PutOIDCIdentity(ctx, pgdb.PutOIDCIdentityParams{
		Issuer:  issuer,
		Subject: subject,
		UserID:  userID,
		Created: created,
	}))
}

func (r *Repo) GetOIDCIdentity(ctx context.Context, issuer, subject string) (id.ID, error) {
	userID, err := r.r.GetOIDCIdentity(ctx, pgdb.GetOIDCIdentityParams{
		Issuer:  issuer,
		Subject: subject,
	})
	if err != nil {
		return id.Zero, wrap(err)
	}
	return userID, nil
}

func (r *Repo) RecordLoginAttempt(ctx context.Context, a store.LoginAttemptRow) error {
	ok := int64(0)
	if a.OK {
		ok = 1
	}
	return wrap(r.w.RecordLoginAttempt(ctx, pgdb.RecordLoginAttemptParams{
		UserID: a.UserID,
		Ip:     a.IP,
		Method: int64(a.Method),
		Ok:     ok,
		At:     a.At,
	}))
}

func (r *Repo) CountLoginFailures(ctx context.Context, userID id.ID, since int64) (int64, error) {
	n, err := r.r.CountLoginFailures(ctx, pgdb.CountLoginFailuresParams{
		UserID: &userID,
		At:     since,
	})
	return n, wrap(err)
}

func (r *Repo) ClearLoginFailures(ctx context.Context, userID id.ID) error {
	return wrap(r.w.ClearLoginFailures(ctx, pgdb.ClearLoginFailuresParams{UserID: &userID}))
}

// ---------------------------------------------------------------- Invites

func (r *Repo) CreateInvite(ctx context.Context, i store.InviteRow) error {
	return wrap(r.w.CreateInvite(ctx, pgdb.CreateInviteParams{
		ID:          i.ID,
		CodeHash:    i.CodeHash,
		CommunityID: i.CommunityID,
		CreatedBy:   i.CreatedBy,
		GrantsAdmin: int64(i.GrantsAdmin),
		MaxUses:     int64(i.MaxUses),
		UsedCount:   int64(i.UsedCount),
		Created:     i.Created,
		ExpiresAt:   i.ExpiresAt,
		RevokedAt:   nullInt64(i.RevokedAt),
	}))
}

func (r *Repo) GetInviteByHash(ctx context.Context, codeHash []byte) (store.InviteRow, error) {
	row, err := r.r.GetInviteByHash(ctx, pgdb.GetInviteByHashParams{CodeHash: codeHash})
	if err != nil {
		return store.InviteRow{}, wrap(err)
	}
	return inviteRow(row), nil
}

// RedeemInvite is the one method whose SQL is the concurrency control: the
// UPDATE's own WHERE clause is the guard, so 64 racing callers produce exactly
// one RETURNING row and 63 sql.ErrNoRows.
func (r *Repo) RedeemInvite(ctx context.Context, codeHash []byte, now int64) (store.InviteRow, error) {
	row, err := r.w.RedeemInvite(ctx, pgdb.RedeemInviteParams{CodeHash: codeHash, ExpiresAt: now})
	if errors.Is(err, sql.ErrNoRows) {
		return store.InviteRow{}, store.ErrExhausted
	}
	if err != nil {
		return store.InviteRow{}, wrap(err)
	}
	return inviteRow(row), nil
}

func (r *Repo) RevokeInvite(ctx context.Context, inviteID id.ID, at int64) error {
	return wrap(r.w.RevokeInvite(ctx, pgdb.RevokeInviteParams{
		RevokedAt: nullInt64(&at),
		ID:        inviteID,
	}))
}

func (r *Repo) ListInvites(ctx context.Context, communityID *id.ID) ([]store.InviteRow, error) {
	var rows []pgdb.Invites
	var err error
	if communityID == nil {
		rows, err = r.r.ListInvites(ctx)
	} else {
		rows, err = r.r.ListInvitesByCommunity(ctx, pgdb.ListInvitesByCommunityParams{
			CommunityID: communityID,
		})
	}
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.InviteRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, inviteRow(row))
	}
	return out, nil
}

func inviteRow(row pgdb.Invites) store.InviteRow {
	return store.InviteRow{
		ID: row.ID, CodeHash: row.CodeHash, CommunityID: row.CommunityID, CreatedBy: row.CreatedBy,
		GrantsAdmin: uint8(row.GrantsAdmin), MaxUses: uint64(row.MaxUses), UsedCount: uint64(row.UsedCount),
		Created: row.Created, ExpiresAt: row.ExpiresAt, RevokedAt: ptrInt64(row.RevokedAt),
	}
}

// ---------------------------------------------------------------- Ops

func (r *Repo) PutReport(ctx context.Context, rep store.ReportRow) error {
	return wrap(r.w.PutReport(ctx, pgdb.PutReportParams{
		ID:                 rep.ID,
		Reporter:           rep.Reporter,
		GroupID:            rep.GroupID,
		Seq:                int64(rep.Seq),
		RevealedEnvelope:   rep.RevealedEnvelope,
		KF:                 rep.KF,
		FrankingKeyID:      rep.FrankingKeyID,
		VerificationResult: rep.VerificationResult,
		Status:             int64(rep.Status),
		Created:            rep.Created,
	}))
}

func (r *Repo) GetReport(ctx context.Context, reportID id.ID) (store.ReportRow, error) {
	row, err := r.r.GetReport(ctx, pgdb.GetReportParams{ID: reportID})
	if err != nil {
		return store.ReportRow{}, wrap(err)
	}
	return store.ReportRow{
		ID:                 row.ID,
		Reporter:           row.Reporter,
		GroupID:            row.GroupID,
		Seq:                uint64(row.Seq),
		RevealedEnvelope:   row.RevealedEnvelope,
		KF:                 row.KF,
		FrankingKeyID:      row.FrankingKeyID,
		VerificationResult: row.VerificationResult,
		Status:             int32(row.Status),
		Created:            row.Created,
	}, nil
}

func (r *Repo) UpdateReportStatus(ctx context.Context, reportID id.ID, status int32, result string) error {
	return wrap(r.w.UpdateReportStatus(ctx, pgdb.UpdateReportStatusParams{
		Status:             int64(status),
		VerificationResult: result,
		ID:                 reportID,
	}))
}

func (r *Repo) Audit(ctx context.Context, a store.AuditRow) error {
	return wrap(r.w.InsertAudit(ctx, pgdb.InsertAuditParams{
		Actor:  a.Actor,
		Action: a.Action,
		Target: a.Target,
		Detail: a.Detail,
		At:     a.At,
	}))
}

func (r *Repo) ListAudit(ctx context.Context, since int64, limit int32) ([]store.AuditRow, error) {
	rows, err := r.r.ListAudit(ctx, pgdb.ListAuditParams{At: since, MaxRows: int64(limit)})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.AuditRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, store.AuditRow{
			Actor:  row.Actor,
			Action: row.Action,
			Target: row.Target,
			Detail: row.Detail,
			At:     row.At,
		})
	}
	return out, nil
}

// SchemaVersion reads goose's table with a plain SELECT: every Provider read
// path calls ensureVersionTable and would create the table as a side effect
// (gap-67 claim 9), which a read-only doctor must not do.
func (r *Repo) SchemaVersion(ctx context.Context) (int64, error) {
	var v sql.NullInt64
	err := r.rawRead.QueryRowContext(ctx, `SELECT max(version_id) FROM goose_db_version`).Scan(&v)
	if err != nil {
		return 0, wrap(err)
	}
	if !v.Valid {
		return 0, nil
	}
	return v.Int64, nil
}

var _ store.Repository = (*Repo)(nil)
