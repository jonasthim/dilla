//go:build !unix

package main

// restrictUmask has nothing to restrict off unix: there is no process umask.
func restrictUmask() {}
