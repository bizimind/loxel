# syntax=docker/dockerfile:1.7
# Install git via apt on the shared base, then extract only git's files to /out.
# Runtime deps (zlib, openssl, libcurl, perl) are provided by the sandbox base
# image. VERSION is metadata only — git is pinned transitively via BASE_IMAGE.
FROM base AS build
ARG VERSION

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p /out/bin /out/lib /out/share; \
    cp -a /usr/bin/git          /out/bin/git; \
    cp -a /usr/bin/git-shell    /out/bin/git-shell 2>/dev/null || true; \
    cp -a /usr/bin/git-receive-pack /out/bin/git-receive-pack 2>/dev/null || true; \
    cp -a /usr/bin/git-upload-pack  /out/bin/git-upload-pack  2>/dev/null || true; \
    cp -a /usr/bin/git-upload-archive /out/bin/git-upload-archive 2>/dev/null || true; \
    cp -a /usr/lib/git-core     /out/lib/git-core; \
    cp -a /usr/share/git-core   /out/share/git-core

FROM scratch
COPY --from=build /out /out
