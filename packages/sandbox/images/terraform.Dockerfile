FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl unzip

# Upstream ships a flat zip with a single `terraform` binary.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=amd64; sha="${SHA256_AMD64}" ;; \
      arm64) arch=arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    file="terraform_${VERSION}_linux_${arch}.zip"; \
    url="https://releases.hashicorp.com/terraform/${VERSION}/${file}"; \
    mkdir -p /tmp/tf /out/bin; \
    curl -fsSL "${url}" -o "/tmp/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    unzip -q "/tmp/${file}" -d /tmp/tf; \
    mv /tmp/tf/terraform /out/bin/terraform; \
    chmod +x /out/bin/terraform

FROM scratch
COPY --from=build /out /out
