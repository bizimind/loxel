FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

# The codex release tarball contains a single flat binary named
# `codex-${triple}` at the archive root. Use the musl static build so the
# binary runs on any libc. The release tag is prefixed with `rust-v`.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple=x86_64-unknown-linux-musl;  sha="${SHA256_AMD64}" ;; \
      arm64) triple=aarch64-unknown-linux-musl; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="codex-${triple}.tar.gz"; \
    url="https://github.com/openai/codex/releases/download/rust-v${VERSION}/${file}"; \
    mkdir -p /tmp/codex /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xzf "/tmp/${file}" -C /tmp/codex; \
    mv "/tmp/codex/codex-${triple}" /out/bin/codex; \
    chmod +x /out/bin/codex; \
    rm -rf /tmp/codex "/tmp/${file}"

FROM scratch
COPY --from=build /out /out
