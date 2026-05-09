FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl

# Upstream distributes a raw binary per arch (no archive).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    url="https://github.com/direnv/direnv/releases/download/v${VERSION}/direnv.linux-${arch}"; \
    mkdir -p /out/bin; \
    curl -fsSL "${url}" -o /out/bin/direnv; \
    echo "${sha}  /out/bin/direnv" | sha256sum -c -; \
    chmod +x /out/bin/direnv

FROM scratch
COPY --from=build /out /out
