FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

# Asset naming: fzf-<ver>-linux_<arch>.tar.gz (hyphen then underscore).
# Archive contains a single flat `fzf` binary at the root.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="fzf-${VERSION}-linux_${arch}.tar.gz"; \
    url="https://github.com/junegunn/fzf/releases/download/v${VERSION}/${file}"; \
    mkdir -p /tmp/fzf /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xz -C /tmp/fzf -f "/tmp/${file}"; \
    mv /tmp/fzf/fzf /out/bin/fzf; \
    chmod +x /out/bin/fzf

FROM scratch
COPY --from=build /out /out
