# Portable CPython from astral-sh/python-build-standalone.
#
# Unlike slim-bookworm's python, these tarballs carry the full stdlib (ssl,
# sqlite3, hashlib, _ctypes, _lzma, _bz2, readline) linked against libraries
# inside the bundle via $ORIGIN/../lib — no dependency on system /usr/lib.
# pip is included out of the box.
FROM alpine:3.20 AS build
ARG VERSION
ARG RELEASE
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64;  sha="${SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="cpython-${VERSION}+${RELEASE}-${arch}-unknown-linux-gnu-install_only.tar.gz"; \
    url="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${file}"; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    mkdir -p /tmp/extract /out; \
    tar -xzf "/tmp/${file}" -C /tmp/extract; \
    # install_only tarball extracts to `python/` with bin/ lib/ include/ share/
    cp -a /tmp/extract/python/. /out/; \
    rm -rf /tmp/extract "/tmp/${file}"

FROM scratch
COPY --from=build /out /out
