# AWS CLI v2 ships a self-contained Python bundle. We skip the official
# install script (which just creates symlinks) and lay out the same structure
# manually — that lets us stay on the alpine builder like every other tool.
# The binaries run on glibc at runtime (sandbox base is ubuntu:24.04).
FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl unzip

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) arch=x86_64;  sha="${SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    url="https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${VERSION}.zip"; \
    curl -fsSL "${url}" -o /tmp/awscli.zip; \
    echo "${sha}  /tmp/awscli.zip" | sha256sum -c -; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    mkdir -p "/out/aws-cli/v2/${VERSION}" /out/bin; \
    cp -a /tmp/aws/dist "/out/aws-cli/v2/${VERSION}/dist"; \
    ln -s "${VERSION}" /out/aws-cli/v2/current; \
    ln -s ../aws-cli/v2/current/dist/aws           /out/bin/aws; \
    ln -s ../aws-cli/v2/current/dist/aws_completer /out/bin/aws_completer; \
    rm -rf /tmp/aws /tmp/awscli.zip

FROM scratch
COPY --from=build /out /out
