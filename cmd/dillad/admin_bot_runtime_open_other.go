//go:build !linux

package main

import (
	"errors"
	"os"
)

func openSecretParent(string) (*os.File, error) {
	return nil, errors.New("protected credential files require Linux descriptor-relative path support")
}
func openNewSecretFileAt(*os.File, string) (*os.File, error) {
	return nil, errors.New("protected credential files require Linux descriptor-relative path support")
}
func unlinkCreatedSecret(*os.File, string, os.FileInfo) error {
	return errors.New("protected credential files require Linux descriptor-relative path support")
}
