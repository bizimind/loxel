FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

# Upstream archive layout: linux-<arch>/{helm,LICENSE,README.md}.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="helm-v${VERSION}-linux-${arch}.tar.gz"; \
    url="https://get.helm.sh/${file}"; \
    mkdir -p /tmp/helm /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xz --strip-components=1 -C /tmp/helm -f "/tmp/${file}"; \
    mv /tmp/helm/helm /out/bin/helm; \
    chmod +x /out/bin/helm

FROM scratch
COPY --from=build /out /out
