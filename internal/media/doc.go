// Package media connects internal/sframe to server-sdk-go without cgo: a FrameEncryptor and a
// FrameDecryptor for the SDK's e2ee hooks, single-layer publishers for the committed Ogg Opus, VP8
// IVF and H.264 fixtures, an H.264 access-unit builder that makes every SPS libwebrtc-stable, and a
// decrypt loop that counts every drop by its protocol/05 code (SP-15, task 6).
//
// Go publishers publish one layer with Encryption_CUSTOM (DEV-40 ruling b); simulcast waits for the
// upstream SDK fix (follow-up card 5). Nothing here may enter dillad's import graph: dillad holds no
// frame key (internal/sfu's TestDilladDoesNotImportTheMediaPackages), and nothing here may import
// server-sdk-go/v2/pkg/media, which needs cgo (TestNothingInTheModuleImportsTheCgoMediaPackage).
package media
