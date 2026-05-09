FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl unzip

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x64;      sha="${SHA256_AMD64}" ;; \
      arm64) arch=aarch64;  sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="bun-linux-${arch}.zip"; \
    url="https://github.com/oven-sh/bun/releases/download/bun-v${VERSION}/${file}"; \
    mkdir -p /tmp/bun /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    unzip -q "/tmp/${file}" -d /tmp/bun; \
    mv /tmp/bun/*/bun /out/bin/bun; \
    chmod +x /out/bin/bun; \
    ln -sf bun /out/bin/bunx; \
    rm -rf /tmp/bun "/tmp/${file}"

FROM scratch
COPY --from=build /out /out
