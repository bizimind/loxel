# syntax=docker/dockerfile:1.7
FROM base

# perl/less/libcurl3-gnutls are git runtime deps (the latter is what
# git-remote-https dynamically links against on Ubuntu). The rest are
# baseline OS utilities agents rely on (tree, wget, unzip, make, gcc, g++),
# shell (zsh), and auth plumbing (openssh-client, gnupg). Version-pinning
# these is not meaningful for agent workflows — Ubuntu's packages suffice.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      perl \
      less \
      libcurl3-gnutls \
      tree \
      wget \
      unzip \
      make \
      gcc \
      g++ \
      zsh \
      openssh-client \
      gnupg \
 && rm -rf /var/lib/apt/lists/*

# Git is pulled in first so the Oh My Zsh install can content-address via a
# pinned commit SHA. GitHub archive tarballs are not byte-stable (compression
# can change over time), so `curl | sha256sum -c -` is not reliable here —
# `git clone + git checkout <sha>` gives cryptographic content addressing
# through Git's own hash chain instead.
COPY --from=git /out /usr/local

# Ubuntu's git is compiled with its exec-path and template-dir pointing at
# /usr/{lib,share}/git-core, but the baked git target lays them out under
# /usr/local/{lib,share}/git-core. Without these overrides, git-remote-https
# isn't discoverable (HTTPS clones fail) and `git init` prints a templates
# warning. Setting them as global ENV fixes all git usage in the sandbox,
# not just the Oh My Zsh install below.
ENV GIT_EXEC_PATH=/usr/local/lib/git-core
ENV GIT_TEMPLATE_DIR=/usr/local/share/git-core/templates

# Oh My Zsh: install system-wide to /opt/oh-my-zsh, pinned to a specific
# commit for reproducibility. Skip the official install.sh — it rewrites
# ~/.zshrc and tries to chsh, neither of which fits an image build.
# Users opt into zsh via `zsh -l`; bash remains the default shell.
ARG OH_MY_ZSH_REF
RUN set -eux; \
    test -n "${OH_MY_ZSH_REF}"; \
    git clone --filter=blob:none https://github.com/ohmyzsh/ohmyzsh.git /opt/oh-my-zsh; \
    git -C /opt/oh-my-zsh checkout "${OH_MY_ZSH_REF}"; \
    rm -rf /opt/oh-my-zsh/.git; \
    printf '%s\n' \
      'export ZSH="/opt/oh-my-zsh"' \
      'ZSH_THEME="robbyrussell"' \
      'plugins=(git fzf)' \
      'DISABLE_AUTO_UPDATE="true"' \
      'source $ZSH/oh-my-zsh.sh' \
      > /root/.zshrc; \
    mkdir -p /etc/skel; \
    cp /root/.zshrc /etc/skel/.zshrc

ENV ZSH=/opt/oh-my-zsh

COPY --from=ripgrep   /out /usr/local
COPY --from=fd        /out /usr/local
COPY --from=python    /out /usr/local
COPY --from=go        /out /usr/local
COPY --from=awscli    /out /usr/local
COPY --from=node      /out /usr/local
COPY --from=pnpm      /out /usr/local
COPY --from=bun       /out /usr/local
COPY --from=jq        /out /usr/local
COPY --from=gh        /out /usr/local
COPY --from=claude    /out /usr/local
COPY --from=codex     /out /usr/local
COPY --from=bat       /out /usr/local
COPY --from=fzf       /out /usr/local
COPY --from=terraform /out /usr/local
COPY --from=kubectl   /out /usr/local
COPY --from=helm      /out /usr/local
COPY --from=uv        /out /usr/local
COPY --from=direnv    /out /usr/local

ENV PATH=/usr/local/bin:/usr/local/go/bin:${PATH}

CMD ["/bin/bash"]
