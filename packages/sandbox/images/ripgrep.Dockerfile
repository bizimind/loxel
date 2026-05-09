FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

# Upstream publishes x86_64-unknown-linux-musl (static) for amd64 and
# aarch64-unknown-linux-gnu for arm64. Both work on the glibc sandbox base.
# No gnu x86_64 or musl aarch64 variant is published, so the split is forced.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple=x86_64-unknown-linux-musl; sha="${SHA256_AMD64}" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="ripgrep-${VERSION}-${triple}.tar.gz"; \
    url="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${file}"; \
    mkdir -p /tmp/rg /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xz --strip-components=1 -C /tmp/rg -f "/tmp/${file}"; \
    mv /tmp/rg/rg /out/bin/rg; \
    chmod +x /out/bin/rg

FROM scratch
COPY --from=build /out /out
