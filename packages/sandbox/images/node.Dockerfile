FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl tar xz

# Official nodejs.org builds are glibc — compatible with the Ubuntu base.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x64;   sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="node-v${VERSION}-linux-${arch}.tar.xz"; \
    url="https://nodejs.org/dist/v${VERSION}/${file}"; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    mkdir -p /tmp/node /out; \
    tar -xJ --strip-components=1 -C /tmp/node -f "/tmp/${file}"; \
    cp -a /tmp/node/bin     /out/bin; \
    cp -a /tmp/node/lib     /out/lib; \
    cp -a /tmp/node/include /out/include; \
    cp -a /tmp/node/share   /out/share; \
    rm -rf /tmp/node "/tmp/${file}"

FROM scratch
COPY --from=build /out /out
