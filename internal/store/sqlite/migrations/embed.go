// Package migrations holds dillad's SQLite goose migrations, embedded so the
// binary carries its own schema history and needs no files on disk.
package migrations

import "embed"

// FS is the migration set. goose reads it through goose.NewProvider.
//
//go:embed *.sql
var FS embed.FS
