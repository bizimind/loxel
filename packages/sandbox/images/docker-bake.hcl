// docker-bake.hcl — sandbox tool images
//
// Build:    docker buildx bake                # default group → sandbox composer
//           docker buildx bake tools          # all tool images, no composer
//           docker buildx bake ripgrep        # single tool
//
// Override: docker buildx bake --set ripgrep.args.VERSION=14.1.0 ripgrep
//
// Version bumps: update the VERSION variable and the matching SHA256_AMD64 /
// SHA256_ARM64. Checksums are taken from upstream release artifacts where a
// checksum file exists, and computed from the artifact directly otherwise.

variable "REGISTRY"   { default = "ghcr.io/bizimind/loxel" }
variable "BASE_IMAGE" { default = "ubuntu:24.04" }

variable "RIPGREP_VERSION"      { default = "15.1.0" }
variable "RIPGREP_SHA256_AMD64" { default = "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599" }
variable "RIPGREP_SHA256_ARM64" { default = "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e" }

variable "FD_VERSION"      { default = "10.4.2" }
variable "FD_SHA256_AMD64" { default = "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde" }
variable "FD_SHA256_ARM64" { default = "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5" }

// python-build-standalone from Astral: portable, statically-selfcontained
// CPython that ships pip and the full stdlib (ssl / sqlite3 / hashlib / libffi
// etc. all baked in via $ORIGIN/../lib rpath).
variable "PYTHON_VERSION"      { default = "3.13.13" }
variable "PYTHON_RELEASE"      { default = "20260414" }
variable "PYTHON_SHA256_AMD64" { default = "e5ec3b2c5693215d153c434ac018e75511b2c4f96d2bce30468a477cb3a89d5e" }
variable "PYTHON_SHA256_ARM64" { default = "6a65f68043d7fadcd580415493d2929d1fd686013f9ae44ddbd3a81307ab256d" }

variable "GO_VERSION"      { default = "1.26.2" }
variable "GO_SHA256_AMD64" { default = "990e6b4bbba816dc3ee129eaeaf4b42f17c2800b88a2166c265ac1a200262282" }
variable "GO_SHA256_ARM64" { default = "c958a1fe1b361391db163a485e21f5f228142d6f8b584f6bef89b26f66dc5b23" }

variable "AWS_CLI_VERSION"      { default = "2.34.32" }
variable "AWS_CLI_SHA256_AMD64" { default = "ad983363b8286928b37bec605348255ddc39e73ba2e79a969ed1c034fe2dc8b3" }
variable "AWS_CLI_SHA256_ARM64" { default = "5456bb34d6a77f1690fb0db8fbd8ae17cbab43b21f833ac36e256bc1f716a809" }

variable "NODE_VERSION"      { default = "24.15.0" }
variable "NODE_SHA256_AMD64" { default = "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6" }
variable "NODE_SHA256_ARM64" { default = "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0" }

variable "PNPM_VERSION"      { default = "10.33.0" }
variable "PNPM_SHA256_AMD64" { default = "aa02280c8d6925b43ded806f22a46ba17a44700271ec6b58679bbe1ffe537973" }
variable "PNPM_SHA256_ARM64" { default = "eac3104a8cf3fb1a4c22d6045d017d27d33226f0dda6ec5c1690a28f2f29273b" }

variable "BUN_VERSION"      { default = "1.4.0" }
variable "BUN_SHA256_AMD64" { default = "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452" }
variable "BUN_SHA256_ARM64" { default = "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e" }

variable "JQ_VERSION"      { default = "1.8.1" }
variable "JQ_SHA256_AMD64" { default = "020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d" }
variable "JQ_SHA256_ARM64" { default = "6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4" }

// git is still installed via apt on the base image — the VERSION here is
// metadata for the image tag and documents what ships with ubuntu:24.04 at
// time of writing. Real version pin happens via BASE_IMAGE.
variable "GIT_VERSION" { default = "2.43.0-ubuntu24.04" }

variable "GH_VERSION"      { default = "2.90.0" }
variable "GH_SHA256_AMD64" { default = "b2aef7b23ec6899bf27f37a32c57a7935d0a178568ac33dc9bb03842f724195a" }
variable "GH_SHA256_ARM64" { default = "1139e1ad912fcddb5ef4b957530184c2c30d9937ff65ff4e641fbf6ca5f28c7c" }

variable "CLAUDE_VERSION"      { default = "2.1.114" }
variable "CLAUDE_SHA256_AMD64" { default = "12bd4b0916deb06be17ffc7b2f0485e140bf00b2db3dcb78469d66723d73c27f" }
variable "CLAUDE_SHA256_ARM64" { default = "9556b74e2c912e7dcaef90c91fd0dd5095364f8a9d71398de3c5c669612b828a" }

variable "CODEX_VERSION"      { default = "0.121.0" }
variable "CODEX_SHA256_AMD64" { default = "278c72b03d4e1f661ba828c1ccf36eba2f88d8074c70e3f03211dbfb631273c4" }
variable "CODEX_SHA256_ARM64" { default = "d0de1caef01b5cb1dcc3d63ef6db100720879a9bfcf11996aa536c67d2fa8320" }

variable "BAT_VERSION"      { default = "0.26.1" }
variable "BAT_SHA256_AMD64" { default = "0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191" }
variable "BAT_SHA256_ARM64" { default = "422eb73e11c854fddd99f5ca8461c2f1d6e6dce0a2a8c3d5daade5ffcb6564aa" }

variable "FZF_VERSION"      { default = "0.71.0" }
variable "FZF_SHA256_AMD64" { default = "22639bb38489dbca8acef57850cbb50231ab714d0e8e855ac52fae8b41233df4" }
variable "FZF_SHA256_ARM64" { default = "98b7d322efae9c37e4bfbbab1cbcd8722eb742d9399511f96375feb40cc35d1d" }

variable "TERRAFORM_VERSION"      { default = "1.14.8" }
variable "TERRAFORM_SHA256_AMD64" { default = "56a5d12f47cbc1c6bedb8f5426ae7d5df984d1929572c24b56f4c82e9f9bf709" }
variable "TERRAFORM_SHA256_ARM64" { default = "c953171cde6b25ca0448c3b29a90d2f46c0310121e18742ec8f89631768e770c" }

variable "KUBECTL_VERSION"      { default = "1.35.4" }
variable "KUBECTL_SHA256_AMD64" { default = "b529430df69a688fd61b64ad2299edb5fd71cb58be2a4779dba624c7d3510efd" }
variable "KUBECTL_SHA256_ARM64" { default = "6a5a4cc4e396d7626a7a693a3044b51c75520f81db30fe6816c2554e53be336f" }

variable "HELM_VERSION"      { default = "4.1.4" }
variable "HELM_SHA256_AMD64" { default = "70b2c30a19da4db264dfd68c8a3664e05093a361cefd89572ffb36f8abfa3d09" }
variable "HELM_SHA256_ARM64" { default = "13d03672be289045d2ff00e4e345d61de1c6f21c1257a45955a30e8ae036d8f1" }

variable "UV_VERSION"      { default = "0.11.7" }
variable "UV_SHA256_AMD64" { default = "6681d691eb7f9c00ac6a3af54252f7ab29ae72f0c8f95bdc7f9d1401c23ea868" }
variable "UV_SHA256_ARM64" { default = "f2ee1cde9aabb4c6e43bd3f341dadaf42189a54e001e521346dc31547310e284" }

variable "DIRENV_VERSION"      { default = "2.37.1" }
variable "DIRENV_SHA256_AMD64" { default = "1f1b93dd6f38523fde26dfac96151ef9d31a374e3005cd3345fb93555ae0c9b5" }
variable "DIRENV_SHA256_ARM64" { default = "2a9cef8d73521d6a3ec3f2871c4b747b8c4cc038628c1b57a7efa42b393a2d82" }

// Oh My Zsh has no tagged releases — pin a commit SHA for reproducible
// image builds. Consumed by sandbox.Dockerfile via `git clone` + `git
// checkout <sha>` for cryptographic content addressing (GitHub archive
// tarballs are not byte-stable, so a static sha256 isn't viable here).
variable "OH_MY_ZSH_REF" { default = "e42ac8c57bc7eb473b689ffcbb98473ba45dbab8" }

group "default" {
  targets = ["sandbox"]
}

group "tools" {
  targets = [
    "ripgrep", "fd", "python", "go", "aws-cli",
    "node", "pnpm", "bun", "jq", "git", "gh",
    "claude", "codex",
    "bat", "fzf", "terraform", "kubectl", "helm", "uv", "direnv",
  ]
}

target "_common" {
  context   = "."
  platforms = ["linux/amd64", "linux/arm64"]
  output    = ["type=image"]
  cache-to  = ["type=inline"]
}

target "base" {
  inherits   = ["_common"]
  dockerfile = "base.Dockerfile"
  args       = { BASE_IMAGE = "${BASE_IMAGE}" }
  tags       = ["${REGISTRY}/base:latest"]
}

target "ripgrep" {
  inherits   = ["_common"]
  dockerfile = "ripgrep.Dockerfile"
  args = {
    VERSION      = "${RIPGREP_VERSION}"
    SHA256_AMD64 = "${RIPGREP_SHA256_AMD64}"
    SHA256_ARM64 = "${RIPGREP_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/ripgrep:${RIPGREP_VERSION}"]
}

target "fd" {
  inherits   = ["_common"]
  dockerfile = "fd.Dockerfile"
  args = {
    VERSION      = "${FD_VERSION}"
    SHA256_AMD64 = "${FD_SHA256_AMD64}"
    SHA256_ARM64 = "${FD_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/fd:${FD_VERSION}"]
}

target "go" {
  inherits   = ["_common"]
  dockerfile = "go.Dockerfile"
  args = {
    VERSION      = "${GO_VERSION}"
    SHA256_AMD64 = "${GO_SHA256_AMD64}"
    SHA256_ARM64 = "${GO_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/go:${GO_VERSION}"]
}

target "python" {
  inherits   = ["_common"]
  dockerfile = "python.Dockerfile"
  args = {
    VERSION      = "${PYTHON_VERSION}"
    RELEASE      = "${PYTHON_RELEASE}"
    SHA256_AMD64 = "${PYTHON_SHA256_AMD64}"
    SHA256_ARM64 = "${PYTHON_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/python:${PYTHON_VERSION}"]
}

target "aws-cli" {
  inherits   = ["_common"]
  dockerfile = "aws-cli.Dockerfile"
  args = {
    VERSION      = "${AWS_CLI_VERSION}"
    SHA256_AMD64 = "${AWS_CLI_SHA256_AMD64}"
    SHA256_ARM64 = "${AWS_CLI_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/aws-cli:${AWS_CLI_VERSION}"]
}

target "node" {
  inherits   = ["_common"]
  dockerfile = "node.Dockerfile"
  args = {
    VERSION      = "${NODE_VERSION}"
    SHA256_AMD64 = "${NODE_SHA256_AMD64}"
    SHA256_ARM64 = "${NODE_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/node:${NODE_VERSION}"]
}

target "pnpm" {
  inherits   = ["_common"]
  dockerfile = "pnpm.Dockerfile"
  args = {
    VERSION      = "${PNPM_VERSION}"
    SHA256_AMD64 = "${PNPM_SHA256_AMD64}"
    SHA256_ARM64 = "${PNPM_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/pnpm:${PNPM_VERSION}"]
}

target "bun" {
  inherits   = ["_common"]
  dockerfile = "bun.Dockerfile"
  args = {
    VERSION      = "${BUN_VERSION}"
    SHA256_AMD64 = "${BUN_SHA256_AMD64}"
    SHA256_ARM64 = "${BUN_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/bun:${BUN_VERSION}"]
}

target "jq" {
  inherits   = ["_common"]
  dockerfile = "jq.Dockerfile"
  args = {
    VERSION      = "${JQ_VERSION}"
    SHA256_AMD64 = "${JQ_SHA256_AMD64}"
    SHA256_ARM64 = "${JQ_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/jq:${JQ_VERSION}"]
}

target "git" {
  inherits   = ["_common"]
  dockerfile = "git.Dockerfile"
  args       = { VERSION = "${GIT_VERSION}" }
  contexts   = { base = "target:base" }
  tags       = ["${REGISTRY}/git:${GIT_VERSION}"]
}

target "gh" {
  inherits   = ["_common"]
  dockerfile = "gh.Dockerfile"
  args = {
    VERSION      = "${GH_VERSION}"
    SHA256_AMD64 = "${GH_SHA256_AMD64}"
    SHA256_ARM64 = "${GH_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/gh:${GH_VERSION}"]
}

target "claude" {
  inherits   = ["_common"]
  dockerfile = "claude.Dockerfile"
  args = {
    VERSION      = "${CLAUDE_VERSION}"
    SHA256_AMD64 = "${CLAUDE_SHA256_AMD64}"
    SHA256_ARM64 = "${CLAUDE_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/claude:${CLAUDE_VERSION}"]
}

target "codex" {
  inherits   = ["_common"]
  dockerfile = "codex.Dockerfile"
  args = {
    VERSION      = "${CODEX_VERSION}"
    SHA256_AMD64 = "${CODEX_SHA256_AMD64}"
    SHA256_ARM64 = "${CODEX_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/codex:${CODEX_VERSION}"]
}

target "bat" {
  inherits   = ["_common"]
  dockerfile = "bat.Dockerfile"
  args = {
    VERSION      = "${BAT_VERSION}"
    SHA256_AMD64 = "${BAT_SHA256_AMD64}"
    SHA256_ARM64 = "${BAT_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/bat:${BAT_VERSION}"]
}

target "fzf" {
  inherits   = ["_common"]
  dockerfile = "fzf.Dockerfile"
  args = {
    VERSION      = "${FZF_VERSION}"
    SHA256_AMD64 = "${FZF_SHA256_AMD64}"
    SHA256_ARM64 = "${FZF_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/fzf:${FZF_VERSION}"]
}

target "terraform" {
  inherits   = ["_common"]
  dockerfile = "terraform.Dockerfile"
  args = {
    VERSION      = "${TERRAFORM_VERSION}"
    SHA256_AMD64 = "${TERRAFORM_SHA256_AMD64}"
    SHA256_ARM64 = "${TERRAFORM_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/terraform:${TERRAFORM_VERSION}"]
}

target "kubectl" {
  inherits   = ["_common"]
  dockerfile = "kubectl.Dockerfile"
  args = {
    VERSION      = "${KUBECTL_VERSION}"
    SHA256_AMD64 = "${KUBECTL_SHA256_AMD64}"
    SHA256_ARM64 = "${KUBECTL_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/kubectl:${KUBECTL_VERSION}"]
}

target "helm" {
  inherits   = ["_common"]
  dockerfile = "helm.Dockerfile"
  args = {
    VERSION      = "${HELM_VERSION}"
    SHA256_AMD64 = "${HELM_SHA256_AMD64}"
    SHA256_ARM64 = "${HELM_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/helm:${HELM_VERSION}"]
}

target "uv" {
  inherits   = ["_common"]
  dockerfile = "uv.Dockerfile"
  args = {
    VERSION      = "${UV_VERSION}"
    SHA256_AMD64 = "${UV_SHA256_AMD64}"
    SHA256_ARM64 = "${UV_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/uv:${UV_VERSION}"]
}

target "direnv" {
  inherits   = ["_common"]
  dockerfile = "direnv.Dockerfile"
  args = {
    VERSION      = "${DIRENV_VERSION}"
    SHA256_AMD64 = "${DIRENV_SHA256_AMD64}"
    SHA256_ARM64 = "${DIRENV_SHA256_ARM64}"
  }
  tags = ["${REGISTRY}/direnv:${DIRENV_VERSION}"]
}

target "sandbox" {
  inherits   = ["_common"]
  dockerfile = "sandbox.Dockerfile"
  args       = { OH_MY_ZSH_REF = "${OH_MY_ZSH_REF}" }
  contexts = {
    base      = "target:base"
    ripgrep   = "target:ripgrep"
    fd        = "target:fd"
    python    = "target:python"
    go        = "target:go"
    awscli    = "target:aws-cli"
    node      = "target:node"
    pnpm      = "target:pnpm"
    bun       = "target:bun"
    jq        = "target:jq"
    git       = "target:git"
    gh        = "target:gh"
    claude    = "target:claude"
    codex     = "target:codex"
    bat       = "target:bat"
    fzf       = "target:fzf"
    terraform = "target:terraform"
    kubectl   = "target:kubectl"
    helm      = "target:helm"
    uv        = "target:uv"
    direnv    = "target:direnv"
  }
  tags = ["${REGISTRY}/sandbox:latest"]
}
