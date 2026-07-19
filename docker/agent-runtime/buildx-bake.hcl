group "default" {
  targets = ["base", "claude", "codex", "gemini", "opencode", "pi", "hermes"]
}

variable "VERSION" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/paperclipai" }

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
  # Harbor is the durable on-prem cache; GHA is a secondary warm cache for
  # cross-run reuse. A failure in either exporter must not fail image publish.
  cache-from = [
    "type=registry,ref=${REGISTRY}/agent-runtime-base:buildcache-v1",
    "type=gha,scope=agent-runtime-base",
  ]
  cache-to = [
    "type=registry,ref=${REGISTRY}/agent-runtime-base:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true",
    "type=gha,scope=agent-runtime-base,mode=max,ignore-error=true",
  ]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-claude:buildcache-v1", "type=gha,scope=agent-runtime-claude"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-claude:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-claude,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-codex:buildcache-v1", "type=gha,scope=agent-runtime-codex"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-codex:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-codex,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-gemini:buildcache-v1", "type=gha,scope=agent-runtime-gemini"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-gemini:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-gemini,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "acpx" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.acpx"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-acpx:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-acpx:buildcache-v1", "type=gha,scope=agent-runtime-acpx"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-acpx:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-acpx,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-opencode:buildcache-v1", "type=gha,scope=agent-runtime-opencode"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-opencode:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-opencode,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-pi:buildcache-v1", "type=gha,scope=agent-runtime-pi"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-pi:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-pi,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}

target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  cache-from = ["type=registry,ref=${REGISTRY}/agent-runtime-hermes:buildcache-v1", "type=gha,scope=agent-runtime-hermes"]
  cache-to = ["type=registry,ref=${REGISTRY}/agent-runtime-hermes:buildcache-v1,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true", "type=gha,scope=agent-runtime-hermes,mode=min,ignore-error=true"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
