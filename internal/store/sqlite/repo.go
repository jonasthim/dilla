package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite/sqlitedb"
)

// Repo adapts the generated sqlitedb.Querier to store.Repository. Reads go to
// the read pool and writes to the single-writer pool; inside a Tx both point at
// the transaction, so a read-your-writes sequence sees its own uncommitted rows.
type Repo struct {
	write   *sql.DB
	read    *sql.DB
	w       *sqlitedb.Queries // bound to write (or to the tx)
	r       *sqlitedb.Queries // bound to read  (or to the tx)
	inTx    bool
	rawRead *sql.DB
}

// New returns the SQLite repository over an already-migrated database.
func New(write, read *sql.DB) store.Repository {
	return &Repo{write: write, read: read, w: sqlitedb.New(write), r: sqlitedb.New(read), rawRead: read}
}

func (r *Repo) Close() error {
	var errs []error
	if r.read != nil {
		errs = append(errs, r.read.Close())
	}
	if r.write != nil {
		errs = append(errs, r.write.Close())
	}
	return errors.Join(errs...)
}

// Tx runs fn inside one immediate transaction on the write pool.
func (r *Repo) Tx(ctx context.Context, fn func(store.Repository) error) error {
	if r.inTx {
		return errors.New("store: nested transaction")
	}
	tx, err := r.write.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	// A panic inside fn must not abandon the transaction. The write pool is one
	// connection, so an *sql.Tx that is never rolled back holds it for the life
	// of the process and every later write blocks on the pool rather than on
	// busy_timeout. database/sql's awaitDone goroutine rescues only a caller
	// that passed a cancellable context; a CLI verb passes context.Background().
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()
	q := sqlitedb.New(tx)
	sub := &Repo{write: r.write, read: r.read, w: q, r: q, inTx: true, rawRead: r.rawRead}
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

// wrap turns driver errors into the package's three sentinels.
func wrap(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sql.ErrNoRows):
		return store.ErrNotFound
	case strings.Contains(err.Error(), "UNIQUE constraint failed"),
		strings.Contains(err.Error(), "PRIMARY KEY constraint failed"):
		return fmt.Errorf("%w: %w", store.ErrConflict, err)
	default:
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
	return wrap(r.w.CreateInstance(ctx, sqlitedb.CreateInstanceParams{
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

// SetGeneration is monotone in SQL (`MAX(generation, ?)`), so a manifest older
// than the instance's own generation is a no-op rather than a step backwards.
func (r *Repo) SetGeneration(ctx context.Context, generation uint64) error {
	return wrap(r.w.SetGeneration(ctx, sqlitedb.SetGenerationParams{
		Generation: int64(generation),
	}))
}

func (r *Repo) GetSetting(ctx context.Context, key string) ([]byte, error) {
	v, err := r.r.GetSetting(ctx, sqlitedb.GetSettingParams{Key: key})
	return v, wrap(err)
}

func (r *Repo) PutSetting(ctx context.Context, key string, value []byte, updated int64) error {
	return wrap(r.w.PutSetting(ctx, sqlitedb.PutSettingParams{Key: key, Value: value, Updated: updated}))
}

// ---------------------------------------------------------------- Accounts

func (r *Repo) CreateUser(ctx context.Context, u store.UserRow) error {
	return wrap(r.w.CreateUser(ctx, sqlitedb.CreateUserParams{
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
	row, err := r.r.GetUser(ctx, sqlitedb.GetUserParams{ID: userID})
	if err != nil {
		return store.UserRow{}, wrap(err)
	}
	return userRow(row), nil
}

func (r *Repo) GetUserByUsername(ctx context.Context, username string) (store.UserRow, error) {
	row, err := r.r.GetUserByUsername(ctx, sqlitedb.GetUserByUsernameParams{Username: username})
	if err != nil {
		return store.UserRow{}, wrap(err)
	}
	return userRow(row), nil
}

func (r *Repo) ListUsers(ctx context.Context, after id.ID, limit int32) ([]store.UserRow, error) {
	rows, err := r.r.ListUsers(ctx, sqlitedb.ListUsersParams{ID: after, MaxRows: int64(limit)})
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
	return wrap(r.w.SetUserDisabled(ctx, sqlitedb.SetUserDisabledParams{
		DisabledAt: nullInt64(at),
		ID:         userID,
	}))
}

func (r *Repo) TombstoneUser(ctx context.Context, userID id.ID, at int64) error {
	return wrap(r.w.TombstoneUser(ctx, sqlitedb.TombstoneUserParams{
		DeletedAt: nullInt64(&at),
		ID:        userID,
	}))
}

func userRow(row sqlitedb.Users) store.UserRow {
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
	return wrap(r.w.CreateDevice(ctx, sqlitedb.CreateDeviceParams{
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
	row, err := r.r.GetDevice(ctx, sqlitedb.GetDeviceParams{ID: deviceID})
	if err != nil {
		return store.DeviceRow{}, wrap(err)
	}
	return deviceRow(row), nil
}

func (r *Repo) ListDevicesByUser(ctx context.Context, userID id.ID) ([]store.DeviceRow, error) {
	rows, err := r.r.ListDevicesByUser(ctx, sqlitedb.ListDevicesByUserParams{UserID: userID})
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
	return wrap(r.w.TouchDevice(ctx, sqlitedb.TouchDeviceParams{LastSeen: lastSeen, ID: deviceID}))
}

func (r *Repo) RevokeDevice(ctx context.Context, deviceID id.ID, at int64) error {
	return wrap(r.w.RevokeDevice(ctx, sqlitedb.RevokeDeviceParams{
		RevokedAt: nullInt64(&at),
		ID:        deviceID,
	}))
}

func (r *Repo) PutDeviceList(ctx context.Context, l store.DeviceListRow) error {
	return wrap(r.w.PutDeviceList(ctx, sqlitedb.PutDeviceListParams{
		UserID:       l.UserID,
		Version:      int64(l.Version),
		Blob:         l.Blob,
		SskSignature: l.SSKSignature,
		PrevHash:     l.PrevHash,
		Created:      l.Created,
	}))
}

func (r *Repo) GetDeviceList(ctx context.Context, userID id.ID) (store.DeviceListRow, error) {
	row, err := r.r.GetDeviceList(ctx, sqlitedb.GetDeviceListParams{UserID: userID})
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

func deviceRow(row sqlitedb.Devices) store.DeviceRow {
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
	return wrap(r.w.CreateSession(ctx, sqlitedb.CreateSessionParams{
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
	row, err := r.r.GetSessionByHash(ctx, sqlitedb.GetSessionByHashParams{
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
	return wrap(r.w.TouchSession(ctx, sqlitedb.TouchSessionParams{
		IdleExpires: idleExpires,
		TokenHash:   tokenHash,
	}))
}

func (r *Repo) DeleteSession(ctx context.Context, tokenHash []byte) error {
	return wrap(r.w.DeleteSession(ctx, sqlitedb.DeleteSessionParams{TokenHash: tokenHash}))
}

func (r *Repo) DeleteSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error) {
	n, err := r.w.DeleteSessionsByDevice(ctx, sqlitedb.DeleteSessionsByDeviceParams{DeviceID: deviceID})
	return n, wrap(err)
}

func (r *Repo) DeleteSessionsByUser(ctx context.Context, userID id.ID) (int64, error) {
	n, err := r.w.DeleteSessionsByUser(ctx, sqlitedb.DeleteSessionsByUserParams{UserID: userID})
	return n, wrap(err)
}

func (r *Repo) CountSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error) {
	n, err := r.r.CountSessionsByDevice(ctx, sqlitedb.CountSessionsByDeviceParams{DeviceID: deviceID})
	return n, wrap(err)
}

func (r *Repo) DeleteOldestSessionForDevice(ctx context.Context, deviceID id.ID) error {
	return wrap(r.w.DeleteOldestSessionForDevice(ctx, sqlitedb.DeleteOldestSessionForDeviceParams{
		DeviceID: deviceID,
	}))
}

func (r *Repo) PruneSessions(ctx context.Context, now int64) (int64, error) {
	n, err := r.w.PruneSessions(ctx, sqlitedb.PruneSessionsParams{Expires: now, IdleExpires: now})
	return n, wrap(err)
}

// ---------------------------------------------------------------- Auth

func (r *Repo) PutPasswordCredential(ctx context.Context, userID id.ID, phc string, updated int64) error {
	return wrap(r.w.PutPasswordCredential(ctx, sqlitedb.PutPasswordCredentialParams{
		UserID:  userID,
		Phc:     phc,
		Updated: updated,
	}))
}

func (r *Repo) GetPasswordCredential(ctx context.Context, userID id.ID) (string, error) {
	phc, err := r.r.GetPasswordCredential(ctx, sqlitedb.GetPasswordCredentialParams{UserID: userID})
	return phc, wrap(err)
}

func (r *Repo) PutTOTP(ctx context.Context, t store.TOTPRow) error {
	return wrap(r.w.PutTOTP(ctx, sqlitedb.PutTOTPParams{
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
	row, err := r.r.GetTOTP(ctx, sqlitedb.GetTOTPParams{UserID: userID})
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
	n, err := r.w.ConsumeTOTPCounter(ctx, sqlitedb.ConsumeTOTPCounterParams{
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
		sub, ok := tx.(*Repo)
		if !ok {
			return fmt.Errorf("store: Tx handed a %T, not this adapter's *Repo", tx)
		}
		return sub.putRecoveryCodesTx(ctx, sub.w, userID, hashes, created)
	})
}

func (r *Repo) putRecoveryCodesTx(ctx context.Context, q *sqlitedb.Queries, userID id.ID, hashes [][]byte, created int64) error {
	if err := q.DeleteRecoveryCodes(ctx, sqlitedb.DeleteRecoveryCodesParams{UserID: userID}); err != nil {
		return wrap(err)
	}
	for _, h := range hashes {
		if err := q.PutRecoveryCode(ctx, sqlitedb.PutRecoveryCodeParams{
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
	n, err := r.w.ConsumeRecoveryCode(ctx, sqlitedb.ConsumeRecoveryCodeParams{
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
	n, err := r.r.CountRecoveryCodes(ctx, sqlitedb.CountRecoveryCodesParams{UserID: userID})
	return n, wrap(err)
}

func (r *Repo) PutWebauthnUser(ctx context.Context, userID id.ID, rpID string, handle []byte, created int64) error {
	return wrap(r.w.PutWebauthnUser(ctx, sqlitedb.PutWebauthnUserParams{
		RpID:       rpID,
		UserID:     userID,
		UserHandle: handle,
		Created:    created,
	}))
}

func (r *Repo) GetWebauthnUserHandle(ctx context.Context, rpID string, userID id.ID) ([]byte, error) {
	h, err := r.r.GetWebauthnUserHandle(ctx, sqlitedb.GetWebauthnUserHandleParams{
		RpID:   rpID,
		UserID: userID,
	})
	return h, wrap(err)
}

func (r *Repo) GetWebauthnUserByHandle(ctx context.Context, rpID string, handle []byte) (id.ID, error) {
	userID, err := r.r.GetWebauthnUserByHandle(ctx, sqlitedb.GetWebauthnUserByHandleParams{
		RpID:       rpID,
		UserHandle: handle,
	})
	if err != nil {
		return id.Zero, wrap(err)
	}
	return userID, nil
}

func (r *Repo) PutWebauthnCredential(ctx context.Context, c store.WebauthnCredentialRow) error {
	return wrap(r.w.PutWebauthnCredential(ctx, sqlitedb.PutWebauthnCredentialParams{
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
	rows, err := r.r.ListWebauthnCredentials(ctx, sqlitedb.ListWebauthnCredentialsParams{
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
	row, err := r.r.GetWebauthnCredential(ctx, sqlitedb.GetWebauthnCredentialParams{CredID: credID})
	if err != nil {
		return store.WebauthnCredentialRow{}, wrap(err)
	}
	return webauthnCredentialRow(row), nil
}

func (r *Repo) UpdateWebauthnCredential(ctx context.Context, credID []byte, signCount int64, flags []byte, lastUsed int64) error {
	return wrap(r.w.UpdateWebauthnCredential(ctx, sqlitedb.UpdateWebauthnCredentialParams{
		SignCount: signCount,
		Flags:     flags,
		LastUsed:  nullInt64(&lastUsed),
		CredID:    credID,
	}))
}

func webauthnCredentialRow(row sqlitedb.WebauthnCredentials) store.WebauthnCredentialRow {
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
	return wrap(r.w.PutCeremony(ctx, sqlitedb.PutCeremonyParams{
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
		sub, ok := tx.(*Repo)
		if !ok {
			return fmt.Errorf("store: Tx handed a %T, not this adapter's *Repo", tx)
		}
		var err error
		out, err = sub.takeCeremonyTx(ctx, sub.w, ceremonyID, now)
		return err
	})
	return out, err
}

func (r *Repo) takeCeremonyTx(ctx context.Context, q *sqlitedb.Queries, ceremonyID id.ID, now int64) (store.CeremonyRow, error) {
	row, err := q.GetCeremony(ctx, sqlitedb.GetCeremonyParams{ID: ceremonyID, Expires: now})
	if err != nil {
		return store.CeremonyRow{}, wrap(err)
	}
	n, err := q.DeleteCeremony(ctx, sqlitedb.DeleteCeremonyParams{ID: ceremonyID})
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
	n, err := r.w.PruneCeremonies(ctx, sqlitedb.PruneCeremoniesParams{Expires: now})
	return n, wrap(err)
}

func (r *Repo) PutOIDCIdentity(ctx context.Context, issuer, subject string, userID id.ID, created int64) error {
	return wrap(r.w.PutOIDCIdentity(ctx, sqlitedb.PutOIDCIdentityParams{
		Issuer:  issuer,
		Subject: subject,
		UserID:  userID,
		Created: created,
	}))
}

func (r *Repo) GetOIDCIdentity(ctx context.Context, issuer, subject string) (id.ID, error) {
	userID, err := r.r.GetOIDCIdentity(ctx, sqlitedb.GetOIDCIdentityParams{
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
	return wrap(r.w.RecordLoginAttempt(ctx, sqlitedb.RecordLoginAttemptParams{
		UserID: a.UserID,
		Ip:     a.IP,
		Method: int64(a.Method),
		Ok:     ok,
		At:     a.At,
	}))
}

func (r *Repo) CountLoginFailures(ctx context.Context, userID id.ID, since int64) (int64, error) {
	n, err := r.r.CountLoginFailures(ctx, sqlitedb.CountLoginFailuresParams{
		UserID: &userID,
		At:     since,
	})
	return n, wrap(err)
}

func (r *Repo) ClearLoginFailures(ctx context.Context, userID id.ID) error {
	return wrap(r.w.ClearLoginFailures(ctx, sqlitedb.ClearLoginFailuresParams{UserID: &userID}))
}

// ---------------------------------------------------------------- Invites

func (r *Repo) CreateInvite(ctx context.Context, i store.InviteRow) error {
	return wrap(r.w.CreateInvite(ctx, sqlitedb.CreateInviteParams{
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
	row, err := r.r.GetInviteByHash(ctx, sqlitedb.GetInviteByHashParams{CodeHash: codeHash})
	if err != nil {
		return store.InviteRow{}, wrap(err)
	}
	return inviteRow(row), nil
}

// RedeemInvite is the one method whose SQL is the concurrency control: the
// UPDATE's own WHERE clause is the guard, so 64 racing callers produce exactly
// one RETURNING row and 63 sql.ErrNoRows.
func (r *Repo) RedeemInvite(ctx context.Context, codeHash []byte, now int64) (store.InviteRow, error) {
	row, err := r.w.RedeemInvite(ctx, sqlitedb.RedeemInviteParams{CodeHash: codeHash, ExpiresAt: now})
	if errors.Is(err, sql.ErrNoRows) {
		return store.InviteRow{}, store.ErrExhausted
	}
	if err != nil {
		return store.InviteRow{}, wrap(err)
	}
	return inviteRow(row), nil
}

func (r *Repo) RevokeInvite(ctx context.Context, inviteID id.ID, at int64) error {
	return wrap(r.w.RevokeInvite(ctx, sqlitedb.RevokeInviteParams{
		RevokedAt: nullInt64(&at),
		ID:        inviteID,
	}))
}

func (r *Repo) ListInvites(ctx context.Context, communityID *id.ID) ([]store.InviteRow, error) {
	var rows []sqlitedb.Invites
	var err error
	if communityID == nil {
		rows, err = r.r.ListInvites(ctx)
	} else {
		rows, err = r.r.ListInvitesByCommunity(ctx, sqlitedb.ListInvitesByCommunityParams{
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

func inviteRow(row sqlitedb.Invites) store.InviteRow {
	return store.InviteRow{
		ID: row.ID, CodeHash: row.CodeHash, CommunityID: row.CommunityID, CreatedBy: row.CreatedBy,
		GrantsAdmin: uint8(row.GrantsAdmin), MaxUses: uint64(row.MaxUses), UsedCount: uint64(row.UsedCount),
		Created: row.Created, ExpiresAt: row.ExpiresAt, RevokedAt: ptrInt64(row.RevokedAt),
	}
}

// ---------------------------------------------------------------- Ops

func (r *Repo) PutReport(ctx context.Context, rep store.ReportRow) error {
	return wrap(r.w.PutReport(ctx, sqlitedb.PutReportParams{
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
	row, err := r.r.GetReport(ctx, sqlitedb.GetReportParams{ID: reportID})
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
	return wrap(r.w.UpdateReportStatus(ctx, sqlitedb.UpdateReportStatusParams{
		Status:             int64(status),
		VerificationResult: result,
		ID:                 reportID,
	}))
}

func (r *Repo) Audit(ctx context.Context, a store.AuditRow) error {
	return wrap(r.w.InsertAudit(ctx, sqlitedb.InsertAuditParams{
		Actor:  a.Actor,
		Action: a.Action,
		Target: a.Target,
		Detail: a.Detail,
		At:     a.At,
	}))
}

func (r *Repo) ListAudit(ctx context.Context, since int64, limit int32) ([]store.AuditRow, error) {
	rows, err := r.r.ListAudit(ctx, sqlitedb.ListAuditParams{At: since, MaxRows: int64(limit)})
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

// ------------------------------------------------------------------- MLS
//
// 004_mls.sql's table set. Deviation ID1: `store.Repository` embeds `MLS` from
// this task onward, so these methods and the embed land in one commit.

// mlsGroupRow maps `mls_groups` onto store.GroupRow. `epoch_unknown` is the
// column's 0/1 integer and the Row's bool (deviation B13).
func mlsGroupRow(m sqlitedb.MlsGroups) store.GroupRow {
	return store.GroupRow{
		GroupID:             m.GroupID,
		Binding:             m.Binding,
		Kind:                uint8(m.Kind),
		CommunityID:         m.CommunityID,
		TargetID:            m.TargetID,
		CallID:              m.CallID,
		Ciphersuite:         uint64(m.Ciphersuite),
		Epoch:               uint64(m.Epoch),
		Seq:                 uint64(m.Seq),
		GroupInfoBlob:       m.GroupInfoBlob,
		TreeHash:            m.TreeHash,
		PublicGroupState:    m.PublicGroupState,
		ExternalSenderKeyID: m.ExternalSenderKeyID,
		E2EEVersion:         uint64(m.E2eeVersion),
		MediaVersion:        uint64(m.MediaVersion),
		PolicyVersion:       uint64(m.PolicyVersion),
		EpochUnknown:        m.EpochUnknown != 0,
		HealDeadline:        ptrInt64(m.HealDeadline),
		Created:             m.Created,
		ClosedAt:            ptrInt64(m.ClosedAt),
		PrunedBelow:         uint64(m.PrunedBelow),
		HandshakesPruned:    uint64(m.HandshakesPrunedThrough),
	}
}

func (r *Repo) CreateGroup(ctx context.Context, g store.GroupRow) error {
	return wrap(r.w.CreateGroup(ctx, sqlitedb.CreateGroupParams{
		GroupID:             g.GroupID,
		Binding:             g.Binding,
		Kind:                int64(g.Kind),
		CommunityID:         g.CommunityID,
		TargetID:            g.TargetID,
		CallID:              g.CallID,
		Ciphersuite:         int64(g.Ciphersuite),
		Epoch:               int64(g.Epoch),
		Seq:                 int64(g.Seq),
		GroupInfoBlob:       g.GroupInfoBlob,
		TreeHash:            g.TreeHash,
		PublicGroupState:    g.PublicGroupState,
		ExternalSenderKeyID: g.ExternalSenderKeyID,
		E2eeVersion:         int64(g.E2EEVersion),
		MediaVersion:        int64(g.MediaVersion),
		PolicyVersion:       int64(g.PolicyVersion),
		EpochUnknown:        boolInt64(g.EpochUnknown),
		HealDeadline:        nullInt64(g.HealDeadline),
		Created:             g.Created,
		ClosedAt:            nullInt64(g.ClosedAt),
	}))
}

func (r *Repo) GetGroup(ctx context.Context, groupID id.ID) (store.GroupRow, error) {
	row, err := r.r.GetGroup(ctx, sqlitedb.GetGroupParams{GroupID: groupID})
	if err != nil {
		return store.GroupRow{}, wrap(err)
	}
	return mlsGroupRow(row), nil
}

// GroupsForTarget is P2-D3 (Plan 2 task 4): the open groups of one kind bound
// to one target, oldest first.
func (r *Repo) GroupsForTarget(ctx context.Context, targetID id.ID, kind uint8) ([]store.GroupRow, error) {
	rows, err := r.r.GroupsForTarget(ctx, sqlitedb.GroupsForTargetParams{TargetID: targetID, Kind: int64(kind)})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.GroupRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, mlsGroupRow(row))
	}
	return out, nil
}

func (r *Repo) ListOpenGroups(ctx context.Context, after id.ID, limit int32) ([]store.GroupRow, error) {
	rows, err := r.r.ListOpenGroups(ctx, sqlitedb.ListOpenGroupsParams{GroupID: after, MaxRows: int64(limit)})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.GroupRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, mlsGroupRow(row))
	}
	return out, nil
}

// ListGroupsForRetention is ListOpenGroups without the `closed_at IS NULL`
// filter: retention applies to every group, closed ones included, because a
// closed group's ciphertext is still ciphertext.
func (r *Repo) ListGroupsForRetention(ctx context.Context, after id.ID, limit int32) ([]store.GroupRow, error) {
	rows, err := r.r.ListGroupsForRetention(ctx, sqlitedb.ListGroupsForRetentionParams{GroupID: after, MaxRows: int64(limit)})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.GroupRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, mlsGroupRow(row))
	}
	return out, nil
}

func (r *Repo) CloseGroup(ctx context.Context, groupID id.ID, at int64) error {
	return wrap(r.w.CloseGroup(ctx, sqlitedb.CloseGroupParams{
		ClosedAt: sql.NullInt64{Int64: at, Valid: true},
		GroupID:  groupID,
	}))
}

// MarkAllGroupsEpochUnknown is the first of invariant 11's three statements (deviation B13);
// ClearEpochUnknown and EndAllVoiceSessions are the other two.
func (r *Repo) MarkAllGroupsEpochUnknown(ctx context.Context, healDeadline int64) error {
	return wrap(r.w.MarkAllGroupsEpochUnknown(ctx, sqlitedb.MarkAllGroupsEpochUnknownParams{
		HealDeadline: healDeadline,
	}))
}

func (r *Repo) ClearEpochUnknown(ctx context.Context, groupID id.ID) error {
	return wrap(r.w.ClearEpochUnknown(ctx, sqlitedb.ClearEpochUnknownParams{GroupID: groupID}))
}

func (r *Repo) EndAllVoiceSessions(ctx context.Context, at int64) error {
	return wrap(r.w.EndAllVoiceSessions(ctx, sqlitedb.EndAllVoiceSessionsParams{At: at}))
}

// NextSeq allocates the next number in the group's ONE sequence space, shared by
// the handshake and application streams. The allocation is the UPDATE itself, so
// two concurrent callers never see the same value.
func (r *Repo) NextSeq(ctx context.Context, groupID id.ID) (uint64, error) {
	seq, err := r.w.BumpGroupSeq(ctx, sqlitedb.BumpGroupSeqParams{GroupID: groupID})
	if err != nil {
		return 0, wrap(err)
	}
	return uint64(seq), nil
}

// PutGroupState writes the PublicGroup blob and the three columns derived from
// it. It clears `epoch_unknown`: a state blob is by definition a known epoch.
func (r *Repo) PutGroupState(ctx context.Context, groupID id.ID, epoch uint64, state, groupInfo, treeHash []byte) error {
	return wrap(r.w.PutGroupState(ctx, sqlitedb.PutGroupStateParams{
		Epoch:            int64(epoch),
		PublicGroupState: state,
		GroupInfoBlob:    groupInfo,
		TreeHash:         treeHash,
		GroupID:          groupID,
	}))
}

func (r *Repo) AppendHandshake(ctx context.Context, h store.HandshakeRow) error {
	return wrap(r.w.AppendHandshake(ctx, sqlitedb.AppendHandshakeParams{
		GroupID:      h.GroupID,
		Seq:          int64(h.Seq),
		Epoch:        int64(h.Epoch),
		Kind:         int64(h.Kind),
		SenderLeaf:   nullUint32(h.SenderLeaf),
		SenderDevice: idBytes(h.SenderDevice),
		Blob:         h.Blob,
		Created:      h.Created,
	}))
}

func (r *Repo) ListHandshakes(ctx context.Context, groupID id.ID, fromSeq uint64, limit int32) ([]store.HandshakeRow, error) {
	rows, err := r.r.ListHandshakes(ctx, sqlitedb.ListHandshakesParams{
		GroupID: groupID, Seq: int64(fromSeq), MaxRows: int64(limit),
	})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.HandshakeRow, 0, len(rows))
	for _, m := range rows {
		device, err := idPtr(m.SenderDevice)
		if err != nil {
			return nil, err
		}
		out = append(out, store.HandshakeRow{
			GroupID:      m.GroupID,
			Seq:          uint64(m.Seq),
			Epoch:        uint64(m.Epoch),
			Kind:         uint8(m.Kind),
			SenderLeaf:   ptrUint32(m.SenderLeaf),
			SenderDevice: device,
			Blob:         m.Blob,
			Created:      m.Created,
		})
	}
	return out, nil
}

// GetCommitAtEpoch is the handshake that carried the group into `epoch`: the
// lowest-seq commit or external commit recorded at it, read over
// `mls_handshakes_by_epoch`. `E_COMMIT_CONFLICT` names that blob, and a scan of
// the log from seq 0 would miss it on any group with more than one page of live
// handshakes (deviation B13).
func (r *Repo) GetCommitAtEpoch(ctx context.Context, groupID id.ID, epoch uint64) (store.HandshakeRow, error) {
	m, err := r.r.GetCommitAtEpoch(ctx, sqlitedb.GetCommitAtEpochParams{
		GroupID: groupID, Epoch: int64(epoch),
	})
	if err != nil {
		return store.HandshakeRow{}, wrap(err)
	}
	device, err := idPtr(m.SenderDevice)
	if err != nil {
		return store.HandshakeRow{}, err
	}
	return store.HandshakeRow{
		GroupID:      m.GroupID,
		Seq:          uint64(m.Seq),
		Epoch:        uint64(m.Epoch),
		Kind:         uint8(m.Kind),
		SenderLeaf:   ptrUint32(m.SenderLeaf),
		SenderDevice: device,
		Blob:         m.Blob,
		Created:      m.Created,
	}, nil
}

// OldestHandshakeSeq is the retention floor a resync is refused below. An empty
// log has no floor, which is 0 and not ErrNotFound: a group with nothing to
// replay refuses nothing.
func (r *Repo) OldestHandshakeSeq(ctx context.Context, groupID id.ID) (uint64, error) {
	seq, err := r.r.OldestHandshakeSeq(ctx, sqlitedb.OldestHandshakeSeqParams{GroupID: groupID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, wrap(err)
	}
	return uint64(seq), nil
}

// PruneHandshakes deletes every handshake older than `before` and, in the same transaction and
// first, raises each affected group's handshakes_pruned_through to the highest seq it loses: the
// catch-up's E_PRUNED is decided against that mark, so a deletion the mark does not record would
// serve a log with a silent hole.
func (r *Repo) PruneHandshakes(ctx context.Context, before int64) (int64, error) {
	var n int64
	err := r.atomically(ctx, func(q *sqlitedb.Queries) error {
		if err := q.RaiseHandshakesPrunedThrough(ctx, sqlitedb.RaiseHandshakesPrunedThroughParams{Created: before}); err != nil {
			return err
		}
		var err error
		n, err = q.PruneHandshakes(ctx, sqlitedb.PruneHandshakesParams{Created: before})
		return err
	})
	return n, wrap(err)
}

// atomically runs fn on the transaction this repository is already in, or on a new one.
func (r *Repo) atomically(ctx context.Context, fn func(q *sqlitedb.Queries) error) error {
	if r.inTx {
		return fn(r.w)
	}
	return r.Tx(ctx, func(tx store.Repository) error {
		sub, ok := tx.(*Repo)
		if !ok {
			return errors.New("store: a transaction that is not this engine's")
		}
		return fn(sub.w)
	})
}

func (r *Repo) PutProposal(ctx context.Context, p store.ProposalRow) error {
	return wrap(r.w.PutProposal(ctx, proposalParams(p)))
}

func proposalParams(p store.ProposalRow) sqlitedb.PutProposalParams {
	return sqlitedb.PutProposalParams{
		GroupID:      p.GroupID,
		Ref:          p.Ref,
		Epoch:        int64(p.Epoch),
		Kind:         int64(p.Kind),
		TargetLeaf:   nullUint32(p.TargetLeaf),
		TargetDevice: idBytes(p.TargetDevice),
		KeyPackage:   p.KeyPackage,
		Origin:       int64(p.Origin),
		ActionID:     p.ActionID,
		IssuedAt:     p.IssuedAt,
		Ttl:          int64(p.TTL),
		VoidAt:       nullInt64(p.VoidAt),
	}
}

func mlsProposalRow(m sqlitedb.MlsPendingProposals) (store.ProposalRow, error) {
	device, err := idPtr(m.TargetDevice)
	if err != nil {
		return store.ProposalRow{}, err
	}
	return store.ProposalRow{
		GroupID:      m.GroupID,
		Ref:          m.Ref,
		Epoch:        uint64(m.Epoch),
		Kind:         uint8(m.Kind),
		TargetLeaf:   ptrUint32(m.TargetLeaf),
		TargetDevice: device,
		KeyPackage:   m.KeyPackage,
		Origin:       uint8(m.Origin),
		ActionID:     m.ActionID,
		IssuedAt:     m.IssuedAt,
		TTL:          uint64(m.Ttl),
		VoidAt:       ptrInt64(m.VoidAt),
	}, nil
}

func (r *Repo) ListProposals(ctx context.Context, groupID id.ID, epoch uint64, includeVoid bool) ([]store.ProposalRow, error) {
	var rows []sqlitedb.MlsPendingProposals
	var err error
	if includeVoid {
		rows, err = r.r.ListAllProposals(ctx, sqlitedb.ListAllProposalsParams{GroupID: groupID, Epoch: int64(epoch)})
	} else {
		rows, err = r.r.ListLiveProposals(ctx, sqlitedb.ListLiveProposalsParams{GroupID: groupID, Epoch: int64(epoch)})
	}
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.ProposalRow, 0, len(rows))
	for _, m := range rows {
		p, err := mlsProposalRow(m)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (r *Repo) VoidProposal(ctx context.Context, groupID id.ID, ref []byte, at int64) error {
	return wrap(r.w.VoidProposal(ctx, sqlitedb.VoidProposalParams{
		VoidAt: sql.NullInt64{Int64: at, Valid: true}, GroupID: groupID, Ref: ref,
	}))
}

func (r *Repo) DeleteProposals(ctx context.Context, groupID id.ID, refs [][]byte) error {
	for _, ref := range refs {
		if err := r.w.DeleteProposal(ctx, sqlitedb.DeleteProposalParams{GroupID: groupID, Ref: ref}); err != nil {
			return wrap(err)
		}
	}
	return nil
}

// ReissueProposal replaces one outstanding row with a fresh one and KEEPS the
// old row's action_id: the logical action survives a re-issue with a new
// KeyPackage, which is what lets the DS tell a retry from a second request.
func (r *Repo) ReissueProposal(ctx context.Context, oldRef []byte, p store.ProposalRow) error {
	old, err := r.w.GetProposal(ctx, sqlitedb.GetProposalParams{GroupID: p.GroupID, Ref: oldRef})
	switch {
	case err == nil:
		p.ActionID = old.ActionID
		if err := r.w.DeleteProposal(ctx, sqlitedb.DeleteProposalParams{GroupID: p.GroupID, Ref: oldRef}); err != nil {
			return wrap(err)
		}
	case errors.Is(err, sql.ErrNoRows):
		// Nothing to supersede; the re-issue is an ordinary insert.
	default:
		return wrap(err)
	}
	return wrap(r.w.PutProposal(ctx, proposalParams(p)))
}

// ReplaceMembers rewrites one group's leaves. Its two statements belong to the
// caller's transaction: every delivery-service caller runs it inside the same Tx
// as the handshake row that changed the tree (R12).
func (r *Repo) ReplaceMembers(ctx context.Context, groupID id.ID, epoch uint64, m []store.MemberRow) error {
	if err := r.w.DeleteMembers(ctx, sqlitedb.DeleteMembersParams{GroupID: groupID}); err != nil {
		return wrap(err)
	}
	for _, row := range m {
		if err := r.w.PutMemberLeaf(ctx, sqlitedb.PutMemberLeafParams{
			GroupID:      groupID,
			LeafIndex:    int64(row.LeafIndex),
			UserID:       row.UserID,
			DeviceID:     row.DeviceID,
			SignatureKey: row.SignatureKey,
			AddedEpoch:   int64(row.AddedEpoch),
			RemovedEpoch: nullUint64(row.RemovedEpoch),
		}); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (r *Repo) ListMembers(ctx context.Context, groupID id.ID) ([]store.MemberRow, error) {
	rows, err := r.r.ListMembers(ctx, sqlitedb.ListMembersParams{GroupID: groupID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.MemberRow, 0, len(rows))
	for _, m := range rows {
		out = append(out, store.MemberRow{
			GroupID:      m.GroupID,
			LeafIndex:    uint32(m.LeafIndex),
			UserID:       m.UserID,
			DeviceID:     m.DeviceID,
			SignatureKey: m.SignatureKey,
			AddedEpoch:   uint64(m.AddedEpoch),
			RemovedEpoch: ptrUint64(m.RemovedEpoch),
		})
	}
	return out, nil
}

func (r *Repo) GroupsForDevice(ctx context.Context, deviceID id.ID) ([]id.ID, error) {
	rows, err := r.r.GroupsForDevice(ctx, sqlitedb.GroupsForDeviceParams{DeviceID: deviceID})
	return rows, wrap(err)
}

// PutKeyPackages writes a device's published packages, and holds the directory's one structural
// invariant: a device has AT MOST ONE last-resort package, so a new one REPLACES the old. That is
// protocol/01 § Joining in SQL — "each device keeps 32 ordinary KeyPackages plus 1 last-resort
// KeyPackage on the DS" — and nothing else in the stack enforces the second half of that sentence.
//
// The rule is here rather than in the delivery service because nothing above can see the rows it
// bounds. `key_packages` is unique only on `(device_id, kp_ref)`, and `CountKeyPackages` — the
// count the publish cap is taken against — filters `last_resort = 0` by contract, because the
// number it reports is what a client refills against and the fallback package is not one a client
// refills. Without this, a device that mints a fresh valid last-resort package and publishes it in
// a loop adds one unbounded row per call, each a full KeyPackage blob held for its 90-day
// lifetime. Dropping the older row is also what the package MEANS: one reusable fallback per
// device, and RFC 9420 gives a joiner no way to choose between two.
//
// Insert first, then delete the others, and both inside ONE transaction: the order keeps the
// device addressable at every instant (a delete-then-insert leaves a window with no fallback at
// all), and the transaction keeps two concurrent republishes from each deleting the other's row.
func (r *Repo) PutKeyPackages(ctx context.Context, deviceID id.ID, kps []store.KeyPackageRow) error {
	// Only a publish that carries a last-resort package needs the transaction; the ordinary path,
	// which is the hot one, pays nothing.
	if !r.inTx && holdsLastResort(kps) {
		return r.Tx(ctx, func(s store.Repository) error {
			return s.PutKeyPackages(ctx, deviceID, kps)
		})
	}
	for _, kp := range kps {
		if err := r.w.PutKeyPackage(ctx, sqlitedb.PutKeyPackageParams{
			DeviceID:   deviceID,
			KpRef:      kp.KPRef,
			Blob:       kp.Blob,
			LastResort: int64(kp.LastResort),
			Expires:    kp.Expires,
			Created:    kp.Created,
			ConsumedAt: nullInt64(kp.ConsumedAt),
		}); err != nil {
			return wrap(err)
		}
		if kp.LastResort == 0 {
			continue
		}
		if err := r.w.DeleteOtherLastResortKeyPackages(ctx, sqlitedb.DeleteOtherLastResortKeyPackagesParams{
			DeviceID: deviceID,
			KpRef:    kp.KPRef,
		}); err != nil {
			return wrap(err)
		}
	}
	return nil
}

// holdsLastResort reports whether the batch carries a last-resort package. A batch with more than
// one is not rejected: each insert drops the ones before it, so the last one written is the one
// that survives, and the invariant holds however the caller batched its rows.
func holdsLastResort(kps []store.KeyPackageRow) bool {
	for _, kp := range kps {
		if kp.LastResort != 0 {
			return true
		}
	}
	return false
}

// TakeKeyPackage consumes one ordinary KeyPackage, and falls back to the
// device's last-resort package WITHOUT consuming it: a last-resort package is
// reusable by construction, and consuming it would leave the device unaddable.
func (r *Repo) TakeKeyPackage(ctx context.Context, deviceID id.ID, now int64) (store.KeyPackageRow, error) {
	kp, err := r.w.TakeKeyPackage(ctx, sqlitedb.TakeKeyPackageParams{
		Now: sql.NullInt64{Int64: now, Valid: true}, DeviceID: deviceID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		kp, err = r.r.GetLastResortKeyPackage(ctx, sqlitedb.GetLastResortKeyPackageParams{
			DeviceID: deviceID, Expires: now,
		})
	}
	if err != nil {
		return store.KeyPackageRow{}, wrap(err)
	}
	return store.KeyPackageRow{
		DeviceID:   kp.DeviceID,
		KPRef:      kp.KpRef,
		Blob:       kp.Blob,
		LastResort: uint8(kp.LastResort),
		Expires:    kp.Expires,
		Created:    kp.Created,
		ConsumedAt: ptrInt64(kp.ConsumedAt),
	}, nil
}

// CountKeyPackages counts the ORDINARY packages still available: the last-resort
// one is never the answer to "is this device running low".
func (r *Repo) CountKeyPackages(ctx context.Context, deviceID id.ID, now int64) (int64, error) {
	n, err := r.r.CountKeyPackages(ctx, sqlitedb.CountKeyPackagesParams{DeviceID: deviceID, Expires: now})
	return n, wrap(err)
}

func (r *Repo) PurgeKeyPackages(ctx context.Context, keepLastResort bool) (int64, error) {
	if keepLastResort {
		n, err := r.w.PurgeKeyPackagesKeepingLastResort(ctx)
		return n, wrap(err)
	}
	n, err := r.w.PurgeAllKeyPackages(ctx)
	return n, wrap(err)
}

func (r *Repo) PutWelcomePayload(ctx context.Context, w store.WelcomePayloadRow) error {
	return wrap(r.w.PutWelcomePayload(ctx, sqlitedb.PutWelcomePayloadParams{
		BlobSha256: w.BlobSHA256,
		GroupID:    w.GroupID,
		Epoch:      int64(w.Epoch),
		Blob:       w.Blob,
		Created:    w.Created,
	}))
}

func (r *Repo) PutEpochTree(ctx context.Context, t store.EpochTreeRow) error {
	return wrap(r.w.PutEpochTree(ctx, sqlitedb.PutEpochTreeParams{
		GroupID:     t.GroupID,
		Epoch:       int64(t.Epoch),
		RatchetTree: t.RatchetTree,
		TreeHash:    t.TreeHash,
		Created:     t.Created,
	}))
}

func (r *Repo) PutWelcomes(ctx context.Context, ws []store.WelcomeRow) error {
	for _, w := range ws {
		if err := r.w.PutWelcome(ctx, sqlitedb.PutWelcomeParams{
			DeviceID:    w.DeviceID,
			GroupID:     w.GroupID,
			Epoch:       int64(w.Epoch),
			CommitSeq:   int64(w.CommitSeq),
			BlobSha256:  w.BlobSHA256,
			Created:     w.Created,
			Expires:     w.Expires,
			DeliveredAt: nullInt64(w.DeliveredAt),
		}); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (r *Repo) ListWelcomes(ctx context.Context, deviceID id.ID, afterID int64, limit int32) ([]store.WelcomeFull, error) {
	rows, err := r.r.ListWelcomes(ctx, sqlitedb.ListWelcomesParams{
		DeviceID: deviceID, WelcomeID: afterID, MaxRows: int64(limit),
	})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.WelcomeFull, 0, len(rows))
	for _, m := range rows {
		out = append(out, store.WelcomeFull{
			WelcomeRow: store.WelcomeRow{
				WelcomeID:   m.WelcomeID,
				DeviceID:    m.DeviceID,
				GroupID:     m.GroupID,
				Epoch:       uint64(m.Epoch),
				CommitSeq:   uint64(m.CommitSeq),
				BlobSHA256:  m.BlobSha256,
				Created:     m.Created,
				Expires:     m.Expires,
				DeliveredAt: ptrInt64(m.DeliveredAt),
			},
			Blob: m.Blob,
			// The tree of the WELCOMING epoch, from the LEFT JOIN on
			// `mls_epoch_trees`: a dilla Welcome carries no ratchet tree and
			// the live one has moved on (protocol/02 row 15). The join is
			// LEFT so a Welcome whose epoch tree has been pruned still
			// reaches its device — with an empty tree it can act on rather
			// than vanishing from the queue.
			RatchetTree: m.RatchetTree,
			TreeHash:    m.TreeHash,
		})
	}
	return out, nil
}

// DeleteWelcome marks one queued Welcome delivered. The row survives so the
// unique index keeps the same payload from being queued to the same device
// twice.
func (r *Repo) DeleteWelcome(ctx context.Context, deviceID id.ID, welcomeID int64, at int64) error {
	return wrap(r.w.DeleteWelcome(ctx, sqlitedb.DeleteWelcomeParams{
		DeliveredAt: sql.NullInt64{Int64: at, Valid: true},
		DeviceID:    deviceID,
		WelcomeID:   welcomeID,
	}))
}

func (r *Repo) PruneWelcomes(ctx context.Context, before int64) (int64, error) {
	n, err := r.w.PruneWelcomes(ctx, sqlitedb.PruneWelcomesParams{Expires: before})
	return n, wrap(err)
}

func (r *Repo) PutForkReport(ctx context.Context, f store.ForkReportRow) error {
	return wrap(r.w.PutForkReport(ctx, sqlitedb.PutForkReportParams{
		GroupID:        f.GroupID,
		Seq:            int64(f.Seq),
		ReporterDevice: f.ReporterDevice,
		Epoch:          int64(f.Epoch),
		Reason:         f.Reason,
		Created:        f.Created,
	}))
}

// CountForkReporters counts DISTINCT reporters without saying so: the primary
// key is (group_id, seq, reporter_device), so one device contributes one row.
func (r *Repo) CountForkReporters(ctx context.Context, groupID id.ID, seq uint64) (int64, error) {
	n, err := r.r.CountForkReporters(ctx, sqlitedb.CountForkReportersParams{GroupID: groupID, Seq: int64(seq)})
	return n, wrap(err)
}

func (r *Repo) QuarantineDevice(ctx context.Context, deviceID id.ID, at int64, reason string) error {
	return wrap(r.w.QuarantineDevice(ctx, sqlitedb.QuarantineDeviceParams{
		QuarantinedAt:    sql.NullInt64{Int64: at, Valid: true},
		QuarantineReason: reason,
		ID:               deviceID,
	}))
}

// ---------------------------------------------------------------- Messages

// PutAppMessage appends one application ciphertext at the seq NextSeq allocated.
// It runs inside the delivery service's own transaction, beside that allocation.
func (r *Repo) PutAppMessage(ctx context.Context, m store.AppMessageRow) error {
	return wrap(r.w.PutAppMessage(ctx, sqlitedb.PutAppMessageParams{
		GroupID:        m.GroupID,
		Seq:            int64(m.Seq),
		Epoch:          int64(m.Epoch),
		UploaderDevice: m.UploaderDevice,
		Blob:           m.Blob,
		CommitmentC:    m.CommitmentC,
		FrankingTag:    m.FrankingTag,
		Size:           int64(m.Size),
		Created:        m.Created,
		Expires:        nullInt64(m.Expires),
		DeletedAt:      nullInt64(m.DeletedAt),
	}))
}

func (r *Repo) ListAppMessages(ctx context.Context, groupID id.ID, fromSeq uint64, limit int32) ([]store.AppMessageRow, error) {
	rows, err := r.r.ListAppMessages(ctx, sqlitedb.ListAppMessagesParams{
		GroupID: groupID, Seq: int64(fromSeq), MaxRows: int64(limit),
	})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.AppMessageRow, 0, len(rows))
	for _, m := range rows {
		out = append(out, appMessageRow(m))
	}
	return out, nil
}

func (r *Repo) GetAppMessage(ctx context.Context, groupID id.ID, seq uint64) (store.AppMessageRow, error) {
	row, err := r.r.GetAppMessage(ctx, sqlitedb.GetAppMessageParams{GroupID: groupID, Seq: int64(seq)})
	if err != nil {
		return store.AppMessageRow{}, wrap(err)
	}
	return appMessageRow(row), nil
}

// appMessageRow is the one place `mls_app_messages` becomes store.AppMessageRow.
// A tombstoned row keeps every column but `blob`, which the UPDATE nulls.
func appMessageRow(m sqlitedb.MlsAppMessages) store.AppMessageRow {
	return store.AppMessageRow{
		GroupID:        m.GroupID,
		Seq:            uint64(m.Seq),
		Epoch:          uint64(m.Epoch),
		UploaderDevice: m.UploaderDevice,
		Blob:           m.Blob,
		CommitmentC:    m.CommitmentC,
		FrankingTag:    m.FrankingTag,
		Size:           uint64(m.Size),
		Created:        m.Created,
		Expires:        ptrInt64(m.Expires),
		DeletedAt:      ptrInt64(m.DeletedAt),
	}
}

// TombstoneAppMessage drops the ciphertext and records when. The row itself
// stays: seq, epoch, uploader_device, commitment_c, franking_tag and recv_ts are
// what a franking report is checked against, and a deleted message must still be
// reportable (R29). The `deleted_at IS NULL` guard keeps a second delete from
// moving the timestamp.
func (r *Repo) TombstoneAppMessage(ctx context.Context, groupID id.ID, seq uint64, at int64) error {
	return wrap(r.w.TombstoneAppMessage(ctx, sqlitedb.TombstoneAppMessageParams{
		DeletedAt: sql.NullInt64{Int64: at, Valid: true},
		GroupID:   groupID,
		Seq:       int64(seq),
	}))
}

func (r *Repo) PruneAppMessages(ctx context.Context, groupID id.ID,
	cursorFloor uint64, deliveryFloor, now int64) (int64, error) {
	var n int64
	err := r.atomically(ctx, func(q *sqlitedb.Queries) error {
		// The high-water first, from the same predicate the DELETE applies: pruned_below is
		// then exactly the highest seq this call takes, whichever trigger takes it.
		top, err := q.MaxPrunableAppMessageSeq(ctx, sqlitedb.MaxPrunableAppMessageSeqParams{
			GroupID:       groupID,
			CursorFloor:   int64(cursorFloor),
			DeliveryFloor: deliveryFloor,
			Now:           now,
		})
		if err != nil {
			return err
		}
		if top > 0 {
			if err := q.RaisePrunedBelow(ctx, sqlitedb.RaisePrunedBelowParams{GroupID: groupID, PrunedBelow: top}); err != nil {
				return err
			}
		}
		n, err = q.PruneAppMessages(ctx, sqlitedb.PruneAppMessagesParams{
			GroupID:       groupID,
			CursorFloor:   int64(cursorFloor),
			DeliveryFloor: deliveryFloor,
			Now:           now,
		})
		return err
	})
	return n, wrap(err)
}

func (r *Repo) RaisePrunedBelow(ctx context.Context, groupID id.ID, below uint64) error {
	return wrap(r.w.RaisePrunedBelow(ctx, sqlitedb.RaisePrunedBelowParams{
		GroupID:     groupID,
		PrunedBelow: int64(below),
	}))
}

// ---------------------------------------------------------------- Cursors

func (r *Repo) PutCursor(ctx context.Context, deviceID, groupID id.ID, lastSeq, lastEpoch uint64, at int64) error {
	return wrap(r.w.PutCursor(ctx, sqlitedb.PutCursorParams{
		DeviceID:  deviceID,
		GroupID:   groupID,
		LastSeq:   int64(lastSeq),
		LastEpoch: int64(lastEpoch),
		Updated:   at,
	}))
}

// GetCursor answers a device that has acknowledged nothing in this group with a
// ZERO CursorRow and a nil error, not store.ErrNotFound. A cursor row is created
// by the first POST /cursor, while the gateway reads one per group of every
// device that connects (internal/gateway/session.go, sendReady) and returns the
// first error it gets: an ErrNotFound here would close every new connection
// before `ready`, and `Gateway.Online` — the predicate invariants 5, 6 and 7 are
// all defined over — would then be false for every device forever. "No row" and
// "acknowledged nothing" are the same state, so the absent row is not an error.
func (r *Repo) GetCursor(ctx context.Context, deviceID, groupID id.ID) (store.CursorRow, error) {
	row, err := r.r.GetCursor(ctx, sqlitedb.GetCursorParams{DeviceID: deviceID, GroupID: groupID})
	if errors.Is(err, sql.ErrNoRows) {
		return store.CursorRow{DeviceID: deviceID, GroupID: groupID}, nil
	}
	if err != nil {
		return store.CursorRow{}, wrap(err)
	}
	return store.CursorRow{
		DeviceID:  row.DeviceID,
		GroupID:   row.GroupID,
		LastSeq:   uint64(row.LastSeq),
		LastEpoch: uint64(row.LastEpoch),
		Updated:   row.Updated,
	}, nil
}

// MinCursor is the retention floor: the lowest seq acknowledged by any device
// that is still eligible, which is any device whose cursor moved at or after
// `activeSince`. A group no eligible device has acknowledged anything in
// answers 0, which retains everything.
func (r *Repo) MinCursor(ctx context.Context, groupID id.ID, activeSince int64) (uint64, error) {
	n, err := r.r.MinCursor(ctx, sqlitedb.MinCursorParams{GroupID: groupID, Updated: activeSince})
	if err != nil {
		return 0, wrap(err)
	}
	return uint64(n), nil
}

// boolInt64, nullUint32/ptrUint32, nullUint64/ptrUint64 and idBytes/idPtr are
// 004_mls.sql's conversions: a 0/1 integer column, a uint32 leaf index in a
// nullable INTEGER, a uint64 epoch in one, and a nullable 16-byte identifier
// column that no sqlc override types as id.ID because its name does not end in
// `_id`.
func boolInt64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullUint32(v *uint32) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(*v), Valid: true}
}

func ptrUint32(v sql.NullInt64) *uint32 {
	if !v.Valid {
		return nil
	}
	n := uint32(v.Int64)
	return &n
}

func nullUint64(v *uint64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(*v), Valid: true}
}

func ptrUint64(v sql.NullInt64) *uint64 {
	if !v.Valid {
		return nil
	}
	n := uint64(v.Int64)
	return &n
}

func idBytes(v *id.ID) []byte {
	if v == nil {
		return nil
	}
	return append([]byte(nil), v[:]...)
}

func idPtr(b []byte) (*id.ID, error) {
	if len(b) == 0 {
		return nil, nil
	}
	if len(b) != id.Size {
		return nil, fmt.Errorf("store: identifier column is %d bytes, want %d", len(b), id.Size)
	}
	var out id.ID
	copy(out[:], b)
	return &out, nil
}

// ---------------------------------------------------------------- Communities
//
// Plan 2 task 1: the slice of store.Structure whose tables 00004_structure.sql
// ships. internal/store/postgres/repo.go carries the same fifteen methods with
// the package name changed: policy_json is TEXT on both engines and the three
// SMALLINT flags are pulled back to int64 by sqlc.yaml, so nothing else differs.

func (r *Repo) CreateCommunity(ctx context.Context, c store.CommunityRow) error {
	return wrap(r.w.CreateCommunity(ctx, sqlitedb.CreateCommunityParams{
		ID:                   c.ID,
		Owner:                c.Owner,
		Name:                 c.Name,
		IconBlob:             c.IconBlob,
		PolicyJson:           string(c.PolicyJSON),
		PolicyVersion:        int64(c.PolicyVersion),
		MinAccountAgeSeconds: int64(c.MinAccountAgeSeconds),
		RequireMod2fa:        int64(c.RequireMod2FA),
		Created:              c.Created,
		DeletedAt:            nullInt64(c.DeletedAt),
	}))
}

func (r *Repo) GetCommunity(ctx context.Context, communityID id.ID) (store.CommunityRow, error) {
	row, err := r.r.GetCommunity(ctx, sqlitedb.GetCommunityParams{ID: communityID})
	if err != nil {
		return store.CommunityRow{}, wrap(err)
	}
	return store.CommunityRow{
		ID:                   row.ID,
		Owner:                row.Owner,
		Name:                 row.Name,
		IconBlob:             row.IconBlob,
		PolicyJSON:           []byte(row.PolicyJson),
		PolicyVersion:        uint64(row.PolicyVersion),
		MinAccountAgeSeconds: uint64(row.MinAccountAgeSeconds),
		RequireMod2FA:        uint8(row.RequireMod2fa),
		Created:              row.Created,
		DeletedAt:            ptrInt64(row.DeletedAt),
	}, nil
}

func (r *Repo) UpdateCommunityPolicy(ctx context.Context, communityID id.ID, policy []byte, version int64) error {
	n, err := r.w.UpdateCommunityPolicy(ctx, sqlitedb.UpdateCommunityPolicyParams{
		PolicyJson:    string(policy),
		PolicyVersion: version,
		ID:            communityID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 1 {
		return nil
	}
	// Zero rows: an unknown or deleted community, or a stored version at or
	// above the one offered. Read through the write handle so a caller inside
	// a Tx sees its own transaction.
	if _, err := r.w.GetCommunity(ctx, sqlitedb.GetCommunityParams{ID: communityID}); err != nil {
		return wrap(err)
	}
	return fmt.Errorf("%w: community %s is already at or past policy version %d", store.ErrConflict, communityID, version)
}

func (r *Repo) UpdateCommunityMeta(ctx context.Context, communityID id.ID, name string, minAge uint64, requireMod2FA uint8) error {
	n, err := r.w.UpdateCommunityMeta(ctx, sqlitedb.UpdateCommunityMetaParams{
		Name:                 name,
		MinAccountAgeSeconds: int64(minAge),
		RequireMod2fa:        int64(requireMod2FA),
		ID:                   communityID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) SoftDeleteCommunity(ctx context.Context, communityID id.ID, at int64) error {
	n, err := r.w.SoftDeleteCommunity(ctx, sqlitedb.SoftDeleteCommunityParams{
		DeletedAt: sql.NullInt64{Int64: at, Valid: true},
		ID:        communityID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) PutMember(ctx context.Context, m store.MemberOfCommunityRow) error {
	return wrap(r.w.PutMember(ctx, sqlitedb.PutMemberParams{
		CommunityID: m.CommunityID, UserID: m.UserID, Joined: m.Joined, Nick: m.Nick,
	}))
}

func (r *Repo) GetMember(ctx context.Context, communityID, userID id.ID) (store.MemberOfCommunityRow, error) {
	row, err := r.r.GetMember(ctx, sqlitedb.GetMemberParams{CommunityID: communityID, UserID: userID})
	if err != nil {
		// wrap turns sql.ErrNoRows into store.ErrNotFound, which is what every
		// membership gate in internal/api tests with errors.Is.
		return store.MemberOfCommunityRow{}, wrap(err)
	}
	return store.MemberOfCommunityRow{
		CommunityID: row.CommunityID, UserID: row.UserID, Joined: row.Joined, Nick: row.Nick,
	}, nil
}

func (r *Repo) DeleteMember(ctx context.Context, communityID, userID id.ID) error {
	n, err := r.w.DeleteMember(ctx, sqlitedb.DeleteMemberParams{CommunityID: communityID, UserID: userID})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) ListMembersOfCommunity(ctx context.Context, communityID, after id.ID, limit int32) ([]store.MemberOfCommunityRow, error) {
	rows, err := r.r.ListMembersOfCommunity(ctx, sqlitedb.ListMembersOfCommunityParams{
		CommunityID: communityID, UserID: after, MaxRows: int64(limit),
	})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.MemberOfCommunityRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, store.MemberOfCommunityRow{
			CommunityID: row.CommunityID, UserID: row.UserID, Joined: row.Joined, Nick: row.Nick,
		})
	}
	return out, nil
}

func (r *Repo) PutRole(ctx context.Context, role store.RoleRow) error {
	return wrap(r.w.PutRole(ctx, sqlitedb.PutRoleParams{
		ID: role.ID, CommunityID: role.CommunityID, Name: role.Name,
		Color: int64(role.Color), Position: int64(role.Position),
		Allow: int64(role.Allow), Deny: int64(role.Deny),
		Hoist: int64(role.Hoist), Mentionable: int64(role.Mentionable),
		Created: role.Created,
	}))
}

func roleRow(row sqlitedb.Roles) store.RoleRow {
	return store.RoleRow{
		ID: row.ID, CommunityID: row.CommunityID, Name: row.Name,
		Color: uint64(row.Color), Position: uint64(row.Position),
		Allow: uint64(row.Allow), Deny: uint64(row.Deny),
		Hoist: uint8(row.Hoist), Mentionable: uint8(row.Mentionable),
		Created: row.Created,
	}
}

func (r *Repo) GetRole(ctx context.Context, roleID id.ID) (store.RoleRow, error) {
	row, err := r.r.GetRole(ctx, sqlitedb.GetRoleParams{ID: roleID})
	if err != nil {
		return store.RoleRow{}, wrap(err)
	}
	return roleRow(row), nil
}

func (r *Repo) ListRoles(ctx context.Context, communityID id.ID) ([]store.RoleRow, error) {
	rows, err := r.r.ListRoles(ctx, sqlitedb.ListRolesParams{CommunityID: communityID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.RoleRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, roleRow(row))
	}
	return out, nil
}

func (r *Repo) PutMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error {
	return wrap(r.w.PutMemberRole(ctx, sqlitedb.PutMemberRoleParams{
		CommunityID: communityID, UserID: userID, RoleID: roleID,
	}))
}

func (r *Repo) DeleteMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error {
	n, err := r.w.DeleteMemberRole(ctx, sqlitedb.DeleteMemberRoleParams{
		CommunityID: communityID, UserID: userID, RoleID: roleID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) ListMemberRoles(ctx context.Context, communityID, userID id.ID) ([]id.ID, error) {
	rows, err := r.r.ListMemberRoles(ctx, sqlitedb.ListMemberRolesParams{
		CommunityID: communityID, UserID: userID,
	})
	if err != nil {
		return nil, wrap(err)
	}
	return rows, nil
}

// ---------------------------------------------------------------- Channels
//
// Plan 2 task 2: the slice of store.Structure whose table 00005_channels.sql
// ships. The other adapter carries the same seven methods with the package name
// changed: settings_json is TEXT on both engines and the three SMALLINT enums
// are pulled back to int64 by sqlc.yaml, so nothing else differs.

func (r *Repo) CreateChannel(ctx context.Context, c store.ChannelRow) error {
	return wrap(r.w.CreateChannel(ctx, sqlitedb.CreateChannelParams{
		ID:                c.ID,
		CommunityID:       c.CommunityID,
		Kind:              int64(c.Kind),
		Mode:              int64(c.Mode),
		Visibility:        int64(c.Visibility),
		ParentID:          c.ParentID,
		Name:              c.Name,
		Topic:             c.Topic,
		Position:          int64(c.Position),
		SettingsJson:      settingsJSON(c.SettingsJSON),
		HostPolicyVersion: int64(c.HostPolicyVersion),
		SlowmodeSeconds:   int64(c.SlowmodeSeconds),
		Seq:               int64(c.Seq),
		Created:           c.Created,
		DeletedAt:         nullInt64(c.DeletedAt),
	}))
}

// settingsJSON is the stored form of a channel's settings document: `{}` when
// the row carries none, because the column is NOT NULL.
func settingsJSON(b []byte) string {
	if len(b) == 0 {
		return "{}"
	}
	return string(b)
}

func channelRow(row sqlitedb.Channels) store.ChannelRow {
	return store.ChannelRow{
		ID:                row.ID,
		CommunityID:       row.CommunityID,
		Kind:              uint8(row.Kind),
		Mode:              uint8(row.Mode),
		Visibility:        uint8(row.Visibility),
		ParentID:          row.ParentID,
		Name:              row.Name,
		Topic:             row.Topic,
		Position:          uint64(row.Position),
		SettingsJSON:      []byte(row.SettingsJson),
		HostPolicyVersion: uint64(row.HostPolicyVersion),
		SlowmodeSeconds:   uint64(row.SlowmodeSeconds),
		Seq:               uint64(row.Seq),
		Created:           row.Created,
		DeletedAt:         ptrInt64(row.DeletedAt),
	}
}

func (r *Repo) GetChannel(ctx context.Context, channelID id.ID) (store.ChannelRow, error) {
	row, err := r.r.GetChannel(ctx, sqlitedb.GetChannelParams{ID: channelID})
	if err != nil {
		return store.ChannelRow{}, wrap(err)
	}
	return channelRow(row), nil
}

func (r *Repo) ListChannels(ctx context.Context, communityID id.ID) ([]store.ChannelRow, error) {
	rows, err := r.r.ListChannels(ctx, sqlitedb.ListChannelsParams{CommunityID: &communityID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.ChannelRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, channelRow(row))
	}
	return out, nil
}

// UpdateChannel deliberately does not write kind, community_id, seq or created:
// a channel's kind and home are immutable, and seq moves only through
// NextChannelSeq.
func (r *Repo) UpdateChannel(ctx context.Context, c store.ChannelRow) error {
	n, err := r.w.UpdateChannel(ctx, sqlitedb.UpdateChannelParams{
		Mode:              int64(c.Mode),
		Visibility:        int64(c.Visibility),
		ParentID:          c.ParentID,
		Name:              c.Name,
		Topic:             c.Topic,
		Position:          int64(c.Position),
		SettingsJson:      settingsJSON(c.SettingsJSON),
		HostPolicyVersion: int64(c.HostPolicyVersion),
		SlowmodeSeconds:   int64(c.SlowmodeSeconds),
		ID:                c.ID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteChannel(ctx context.Context, channelID id.ID, at int64) error {
	n, err := r.w.DeleteChannel(ctx, sqlitedb.DeleteChannelParams{
		DeletedAt: sql.NullInt64{Int64: at, Valid: true},
		ID:        channelID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteChannelsOfCommunity(ctx context.Context, communityID id.ID, at int64) (int64, error) {
	n, err := r.w.DeleteChannelsOfCommunity(ctx, sqlitedb.DeleteChannelsOfCommunityParams{
		DeletedAt:   sql.NullInt64{Int64: at, Valid: true},
		CommunityID: &communityID,
	})
	return n, wrap(err)
}

func (r *Repo) NextChannelSeq(ctx context.Context, channelID id.ID) (uint64, error) {
	seq, err := r.w.NextChannelSeq(ctx, sqlitedb.NextChannelSeqParams{ID: channelID})
	if err != nil {
		return 0, wrap(err)
	}
	return uint64(seq), nil
}

func (r *Repo) DeleteRole(ctx context.Context, communityID, roleID id.ID) error {
	n, err := r.w.DeleteRole(ctx, sqlitedb.DeleteRoleParams{ID: roleID, CommunityID: communityID})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- Overwrites
//
// Plan 2 task 3: the slice of store.Structure whose table 00006_overwrites.sql
// ships. target_kind is SMALLINT on Postgres and pulled back to int64 by
// sqlc.yaml, so both adapters carry the same three methods.

func (r *Repo) PutOverwrite(ctx context.Context, o store.OverwriteRow) error {
	return wrap(r.w.PutOverwrite(ctx, sqlitedb.PutOverwriteParams{
		ChannelID:  o.ChannelID,
		TargetKind: int64(o.TargetKind),
		TargetID:   o.TargetID,
		Allow:      int64(o.Allow),
		Deny:       int64(o.Deny),
	}))
}

func (r *Repo) ListOverwrites(ctx context.Context, channelID id.ID) ([]store.OverwriteRow, error) {
	rows, err := r.r.ListOverwrites(ctx, sqlitedb.ListOverwritesParams{ChannelID: channelID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.OverwriteRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, store.OverwriteRow{
			ChannelID:  row.ChannelID,
			TargetKind: uint8(row.TargetKind),
			TargetID:   row.TargetID,
			Allow:      uint64(row.Allow),
			Deny:       uint64(row.Deny),
		})
	}
	return out, nil
}

func (r *Repo) DeleteOverwrite(ctx context.Context, channelID id.ID, targetKind uint8, targetID id.ID) error {
	n, err := r.w.DeleteOverwrite(ctx, sqlitedb.DeleteOverwriteParams{
		ChannelID: channelID, TargetKind: int64(targetKind), TargetID: targetID,
	})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- Bans
//
// Plan 2 task 4: the slice of store.Structure whose table 00007_bans.sql ships,
// with P2-D10's listing.

func (r *Repo) PutBan(ctx context.Context, b store.BanRow) error {
	return wrap(r.w.PutBan(ctx, sqlitedb.PutBanParams{
		CommunityID: b.CommunityID,
		UserID:      b.UserID,
		Reason:      b.Reason,
		ByUser:      b.ByUser,
		Created:     b.Created,
		Expires:     nullInt64(b.Expires),
	}))
}

func banRow(row sqlitedb.Bans) store.BanRow {
	return store.BanRow{
		CommunityID: row.CommunityID,
		UserID:      row.UserID,
		Reason:      row.Reason,
		ByUser:      row.ByUser,
		Created:     row.Created,
		Expires:     ptrInt64(row.Expires),
	}
}

func (r *Repo) GetBan(ctx context.Context, communityID, userID id.ID) (store.BanRow, error) {
	row, err := r.r.GetBan(ctx, sqlitedb.GetBanParams{CommunityID: communityID, UserID: userID})
	if err != nil {
		return store.BanRow{}, wrap(err)
	}
	return banRow(row), nil
}

func (r *Repo) ListBans(ctx context.Context, communityID id.ID) ([]store.BanRow, error) {
	rows, err := r.r.ListBans(ctx, sqlitedb.ListBansParams{CommunityID: communityID})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]store.BanRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, banRow(row))
	}
	return out, nil
}

func (r *Repo) DeleteBan(ctx context.Context, communityID, userID id.ID) error {
	n, err := r.w.DeleteBan(ctx, sqlitedb.DeleteBanParams{CommunityID: communityID, UserID: userID})
	if err != nil {
		return wrap(err)
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

var _ store.Repository = (*Repo)(nil)
