// Command dillad is the dilla server. Week 1 ships only the spike harnesses
// under internal/; this binary exists so the module has a buildable main
// package and so CI can prove the release build stays cgo-free.
package main

import (
	"flag"
	"fmt"
	"runtime"
)

// Version is the dillad version. It is bumped by the release process, not by
// the build.
const Version = "0.0.0-dev"

func versionLine() string {
	return fmt.Sprintf("dillad %s (%s %s/%s)", Version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

func main() {
	flag.Parse()
	fmt.Println(versionLine())
}
