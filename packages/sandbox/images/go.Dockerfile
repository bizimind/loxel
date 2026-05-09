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
    file="go${VERSION}.linux-${arch}.tar.gz"; \
    url="https://go.dev/dl/${file}"; \
    mkdir -p /out; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xzf "/tmp/${file}" -C /out; \
    rm "/tmp/${file}"; \
    mkdir -p /out/bin; \
    ln -sf ../go/bin/go /out/bin/go; \
    ln -sf ../go/bin/gofmt /out/bin/gofmt

FROM scratch
COPY --from=build /out /out
