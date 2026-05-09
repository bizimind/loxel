FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="gh_${VERSION}_linux_${arch}.tar.gz"; \
    url="https://github.com/cli/cli/releases/download/v${VERSION}/${file}"; \
    mkdir -p /tmp/gh /out; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xz --strip-components=1 -C /tmp/gh -f "/tmp/${file}"; \
    cp -a /tmp/gh/bin   /out/bin; \
    cp -a /tmp/gh/share /out/share; \
    rm -rf /tmp/gh "/tmp/${file}"

FROM scratch
COPY --from=build /out /out
