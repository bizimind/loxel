FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

# Same asymmetric release matrix as fd (same maintainer): musl for x86_64,
# gnu for aarch64 — both work on the glibc sandbox base.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple=x86_64-unknown-linux-musl; sha="${SHA256_AMD64}" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="bat-v${VERSION}-${triple}.tar.gz"; \
    url="https://github.com/sharkdp/bat/releases/download/v${VERSION}/${file}"; \
    mkdir -p /tmp/bat /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xz --strip-components=1 -C /tmp/bat -f "/tmp/${file}"; \
    mv /tmp/bat/bat /out/bin/bat; \
    chmod +x /out/bin/bat

FROM scratch
COPY --from=build /out /out
