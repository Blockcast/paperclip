#!/usr/bin/env bash
# Trusted Helm post-renderer for the production Paperclip API approval marker.

set -euo pipefail

marker="${PAPERCLIP_APPROVAL_PLAN_SHA256:-}"
if [[ ! "$marker" =~ ^[0-9a-f]{64}$ ]]; then
  echo "PAPERCLIP_APPROVAL_PLAN_SHA256 must be 64 lowercase hex characters" >&2
  exit 2
fi

RUBY_CODE='
marker = ARGV.fetch(0)
docs = YAML.load_stream($stdin.read).compact
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
annotations["paperclip.blockcast.net/approval-plan-sha256"] = marker

docs.each { |doc| puts YAML.dump(doc) }
'
ruby -ryaml -e "$RUBY_CODE" "$marker"
