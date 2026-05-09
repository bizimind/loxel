FROM alpine:3.20 AS build
ARG VERSION
ARG SHA256_AMD64
ARG SHA256_ARM64
ARG TARGETARCH

RUN apk add --no-cache curl

# Anthropic publishes glibc and musl native binaries for both x64 and arm64
# to a public GCS bucket. Use the glibc variants to match the Ubuntu base.
# Layout: ${bucket}/${version}/${platform}/claude.
# SHA256s are taken from manifest.json at the same path.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) platform=linux-x64;   sha="${SHA256_AMD64}" ;; \
      arm64) platform=linux-arm64; sha="${SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    bucket="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"; \
    url="${bucket}/${VERSION}/${platform}/claude"; \
    mkdir -p /out/bin; \
    curl -fsSL "${url}" -o /out/bin/claude; \
    echo "${sha}  /out/bin/claude" | sha256sum -c -; \
    chmod +x /out/bin/claude

FROM scratch
COPY --from=build /out /out
