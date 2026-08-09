#!/usr/bin/env bash
# Trusted Helm post-renderer for the production Paperclip API approval marker.

set -euo pipefail

marker="${PAPERCLIP_APPROVAL_PLAN_SHA256:-}"
if [[ ! "$marker" =~ ^[0-9a-f]{64}$ ]]; then
  echo "PAPERCLIP_APPROVAL_PLAN_SHA256 must be 64 lowercase hex characters" >&2
  exit 2
fi
deployed_commit="${PAPERCLIP_DEPLOYED_COMMIT:-}"
if [[ -n "$deployed_commit" && ! "$deployed_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "PAPERCLIP_DEPLOYED_COMMIT must be 40 lowercase hex characters when set" >&2
  exit 2
fi

for dependency in ruby kubectl jq sha256sum; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "required command not found: ${dependency}" >&2
    exit 2
  fi
done

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
rendered="$workdir/rendered.yaml"
unstamped="$workdir/paperclip-api-unstamped.yaml"
cat >"$rendered"

EXTRACT_UNSTAMPED_RUBY_CODE='
marker = ARGV.fetch(0)
deployed_commit = ARGV.fetch(2)
docs = YAML.load_stream(File.read(ARGV.fetch(1))).compact
matches = docs.select do |doc|
  doc.is_a?(Hash) &&
    doc["apiVersion"] == "apps/v1" &&
    doc["kind"] == "Deployment" &&
    doc.dig("metadata", "name") == "paperclip-api"
end
abort "expected exactly one apps/v1 Deployment/paperclip-api, got #{matches.length}" unless matches.length == 1

deployment = matches.fetch(0)
template_metadata = deployment.dig("spec", "template", "metadata")
abort "Deployment/paperclip-api has no pod-template metadata" unless template_metadata.is_a?(Hash)
annotations = template_metadata["annotations"]
if annotations
  existing = annotations["paperclip.blockcast.net/approval-plan-sha256"]
  if existing && existing != marker
    abort "Deployment/paperclip-api already carries a different approval-plan marker"
  end
  annotations.delete("paperclip.blockcast.net/approval-plan-sha256")
  existing_commit = annotations["paperclip.blockcast.net/deployed-commit"]
  if !deployed_commit.empty? && existing_commit && existing_commit != deployed_commit
    abort "Deployment/paperclip-api already carries a different deployed-commit annotation"
  end
end
if !deployed_commit.empty?
  annotations = (template_metadata["annotations"] ||= {})
  annotations["paperclip.blockcast.net/deployed-commit"] = deployed_commit
else
  template_metadata.delete("annotations") if annotations&.empty?
end
deployment.dig("spec", "template").delete("metadata") if template_metadata.empty?
puts YAML.dump(deployment)
'
ruby -ryaml -e "$EXTRACT_UNSTAMPED_RUBY_CODE" "$marker" "$rendered" "$deployed_commit" >"$unstamped"

kubectl_args=(create --dry-run=client -o json -f "$unstamped")
if [[ -n "${PAPERCLIP_DEPLOY_NAMESPACE:-}" ]]; then
  kubectl_args+=(--namespace "$PAPERCLIP_DEPLOY_NAMESPACE")
fi

canonical_unstamped="$(
  kubectl "${kubectl_args[@]}" |
    jq -cS --arg key "paperclip.blockcast.net/approval-plan-sha256" '
      del(.spec.template.metadata.annotations[$key])
      | if ((.spec.template.metadata.annotations // {}) | length) == 0
        then del(.spec.template.metadata.annotations)
        else .
        end
      | if ((.spec.template.metadata // {}) | length) == 0
        then del(.spec.template.metadata)
        else .
        end
    '
)"
rendered_sha256="$(printf '%s' "$canonical_unstamped" | sha256sum | awk '{print $1}')"
if [[ "$rendered_sha256" != "$marker" ]]; then
  echo "Deployment/paperclip-api does not match approved plan ${marker}; rendered ${rendered_sha256}" >&2
  exit 1
fi

STAMP_RUBY_CODE='
marker = ARGV.fetch(0)
deployed_commit = ARGV.fetch(2)
docs = YAML.load_stream(File.read(ARGV.fetch(1))).compact
matches = docs.select do |doc|
  doc.is_a?(Hash) &&
    doc["apiVersion"] == "apps/v1" &&
    doc["kind"] == "Deployment" &&
    doc.dig("metadata", "name") == "paperclip-api"
end
abort "expected exactly one apps/v1 Deployment/paperclip-api, got #{matches.length}" unless matches.length == 1

deployment = matches.fetch(0)
template_metadata = deployment.dig("spec", "template", "metadata")
abort "Deployment/paperclip-api has no pod-template metadata" unless template_metadata.is_a?(Hash)
annotations = (template_metadata["annotations"] ||= {})
existing = annotations["paperclip.blockcast.net/approval-plan-sha256"]
if existing && existing != marker
  abort "Deployment/paperclip-api already carries a different approval-plan marker"
end
existing_commit = annotations["paperclip.blockcast.net/deployed-commit"]
if !deployed_commit.empty? && existing_commit && existing_commit != deployed_commit
  abort "Deployment/paperclip-api already carries a different deployed-commit annotation"
end
annotations["paperclip.blockcast.net/approval-plan-sha256"] = marker
annotations["paperclip.blockcast.net/deployed-commit"] = deployed_commit unless deployed_commit.empty?

docs.each { |doc| puts YAML.dump(doc) }
'
ruby -ryaml -e "$STAMP_RUBY_CODE" "$marker" "$rendered" "$deployed_commit"
