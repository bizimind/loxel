FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    url="https://github.com/jqlang/jq/releases/download/jq-${VERSION}/jq-linux-${arch}"; \
    mkdir -p /out/bin; \
    curl -fsSL "${url}" -o /out/bin/jq; \
    echo "${sha}  /out/bin/jq" | sha256sum -c -; \
    chmod +x /out/bin/jq

FROM scratch
COPY --from=build /out /out
