# syntax=docker/dockerfile:1
#
# dillad is pure Go — wazero and modernc SQLite included — so the binary
# cross-compiles with GOOS/GOARCH from a builder pinned to $BUILDPLATFORM and
# nothing ever runs under emulation. Emulation "can be much slower than native
# builds, especially for compute-heavy tasks like compilation" (Docker's own
# multi-platform guidance), and buys nothing here.
#
# The build context must already hold internal/mlswasi/testdata/dilla_core_wasi.wasm:
# dillad loads the wasi core from beside its own binary at start, and Rust is not
# installed in this builder. CI's rust-wasi job builds it and the image job
# downloads it into that path first; a context without it fails the COPY below
# instead of producing an image that cannot start.
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
# -buildvcs=false: the builder image carries no VCS client and the context has
# no .git. The revision is recorded as an image label instead (below), and
# `dillad version` reports the const main.Version, which no -X flag can set.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false \
      -ldflags="-s -w" \
      -o /out/dillad ./cmd/dillad

# Pinned by digest AND by the -debian13 suffix. The distroless README warns that
# the unsuffixed tag "will change in the future to a newer version of Debian",
# and the previous Debian's image is still published under its own suffix.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
ARG VERSION
ARG COMMIT
LABEL org.opencontainers.image.title="dillad" \
      org.opencontainers.image.source="https://github.com/jonasthim/dilla" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"
# Explicit, because the base config records only "User": "65532" with no group.
USER 65532:65532
WORKDIR /var/lib/dilla
VOLUME ["/var/lib/dilla"]
EXPOSE 443/tcp 7882/udp
COPY --from=build /out/dillad /usr/local/bin/dillad
# Beside the binary, where dillad and `dillad doctor` look for it.
COPY --from=build /src/internal/mlswasi/testdata/dilla_core_wasi.wasm /usr/local/bin/dilla_core_wasi.wasm
ENTRYPOINT ["/usr/local/bin/dillad"]
CMD ["serve", "--config=/etc/dilla/dilla.toml"]
