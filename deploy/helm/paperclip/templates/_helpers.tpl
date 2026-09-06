{{/*
Expand the name of the chart.
*/}}
{{- define "paperclip.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "paperclip.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version label.
*/}}
{{- define "paperclip.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "paperclip.labels" -}}
helm.sh/chart: {{ include "paperclip.chart" . }}
{{ include "paperclip.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "paperclip.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paperclip.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Worker tier selector labels. When `api.enabled` is true the workers tier
carries `component: worker` so the Service selector can route HTTP traffic
to the API tier instead. When `api.enabled` is false this is identical to
`selectorLabels` for backwards compatibility with single-pod deploys.
*/}}
{{- define "paperclip.workerSelectorLabels" -}}
{{ include "paperclip.selectorLabels" . }}
{{- if .Values.api.enabled }}
app.kubernetes.io/component: worker
{{- end }}
{{- end }}

{{/*
API tier selector labels. Only meaningful when `api.enabled` is true.
*/}}
{{- define "paperclip.apiSelectorLabels" -}}
{{ include "paperclip.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Service selector — routes HTTP traffic. When `api.enabled`, points at the
API Deployment pods (component=api). Otherwise points at the StatefulSet
(historical behavior).
*/}}
{{- define "paperclip.serviceSelectorLabels" -}}
{{- if .Values.api.enabled }}
{{ include "paperclip.apiSelectorLabels" . }}
{{- else }}
{{ include "paperclip.selectorLabels" . }}
{{- end }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "paperclip.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "paperclip.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name (existing or generated).
*/}}
{{- define "paperclip.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- printf "%s-credentials" (include "paperclip.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Resolved image ref.
*/}}
{{- define "paperclip.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}
{{- end }}

{{/*
Resolved image pull policy.

An explicit `.Values.image.pullPolicy` always wins. When it is left empty the
policy is derived from whether the image is digest-pinned, because the safe
answer differs between the two cases and only the chart knows which one it
rendered:

  digest set   -> IfNotPresent. A digest is content-addressed and cannot be
                  republished, so re-resolving the manifest on every pod start
                  cannot pick up new content — it only adds a mandatory network
                  round-trip to the registry. That registry is
                  harbor.blockcast.net, whose stateful backend runs on the same
                  `workload=paperclip` node pool as paperclip itself, so the
                  round-trip is a correlated failure domain: node churn degrades
                  Harbor, and degraded Harbor then blocks paperclip from
                  restarting. Observed three times — BLO-29180 (api 1/2 for
                  2h06m), BLO-23736 (25-min control-plane outage), BLO-15520
                  (24 pods in ImagePullBackOff). BLO-29306.

  digest unset -> Always. A floating tag CAN be republished under the same name,
                  so the manifest must be re-resolved on every start or a
                  republish silently never lands. Keeping this branch is what
                  makes the derivation safe to apply chart-wide: it preserves
                  mutable-tag semantics for the documented manual
                  `helm upgrade` path, which passes no digest (BLO-21660).
*/}}
{{- define "paperclip.imagePullPolicy" -}}
{{- if .Values.image.pullPolicy }}
{{- .Values.image.pullPolicy }}
{{- else if .Values.image.digest }}
{{- "IfNotPresent" }}
{{- else }}
{{- "Always" }}
{{- end }}
{{- end }}

{{/* Fail rendering instead of silently disabling an enabled review-gate producer. */}}
{{- define "paperclip.validateGithubReviewGate" -}}
{{- if and ((.Values.githubApp).reviewGateEnabled) (not ((.Values.githubApp).reviewGateCaptureEnabled)) -}}
{{- fail "githubApp.reviewGateEnabled requires githubApp.reviewGateCaptureEnabled=true" -}}
{{- end -}}
{{- if (.Values.githubApp).reviewGateCaptureEnabled -}}
{{- if not (.Values.githubApp).enabled -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires githubApp.enabled=true" -}}
{{- end -}}
{{- if not (gt (len ((.Values.githubApp).reviewGateRepositories)) 0) -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires at least one githubApp.reviewGateRepositories entry" -}}
{{- end -}}
{{- if not (regexMatch "^[0-9]+$" (toString ((.Values.githubApp).reviewGateExpectedAppId))) -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires a numeric githubApp.reviewGateExpectedAppId" -}}
{{- end -}}
{{- if not (regexMatch "^[0-9]+$" (toString ((.Values.githubApp).reviewGateExpectedInstallationId))) -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires a numeric githubApp.reviewGateExpectedInstallationId" -}}
{{- end -}}
{{- if empty ((.Values.githubApp).prReviewGateStatusContext) -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires githubApp.prReviewGateStatusContext" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The directories the seed init container publishes the GitHub egress wrappers
into, in the order they must appear on PATH. Derived from persistence.mountPath
because the seed derives them the same way (`BASE={{ .Values.persistence.mountPath }}`);
a hardcoded /paperclip would silently miss every deployment that relocates the PVC.
*/}}
{{- define "paperclip.wrapperBinDirs" -}}
{{- $base := .Values.persistence.mountPath | trimSuffix "/" -}}
{{- printf "%s/.local/bin,%s/bin" $base $base -}}
{{- end }}

{{/*
PATH for containers that run agent tooling.

PEN-2527/PEN-2526: agent-authored GitHub content is scrubbed of credential-shaped
material by wrapper binaries the seed init container publishes into
`<mountPath>/.local/bin` and `<mountPath>/bin`. The scrubber only sits on the
traffic path if those directories precede /usr/bin, where the unscrubbed image
`gh` lives. `.local/bin` is prepended by the PVC's `.profile`/`.bashrc`, which
only a *login* shell sources; agent tool harnesses spawn non-login shells. So the
PATH the container itself carries is the only thing that reaches the scrubber,
which makes it a chart-level invariant rather than one operator's values file.

Override with `env.path`. The override is validated rather than trusted: it must
keep both wrapper directories ahead of /usr/bin or the render fails, because the
failure mode being prevented is an agent that looks healthy while publishing
unscrubbed.
*/}}
{{- define "paperclip.runtimePath" -}}
{{- $wrapperDirs := splitList "," (include "paperclip.wrapperBinDirs" .) -}}
{{- range $entry := .Values.env.extra -}}
{{- if eq ($entry.name | toString) "PATH" -}}
{{- fail "env.extra must not define PATH: a duplicate env var would silently override the chart-managed PATH that keeps the GitHub egress scrubber (PEN-2527) ahead of /usr/bin. Set env.path instead, which is validated." -}}
{{- end -}}
{{- end -}}
{{- $path := .Values.env.path | default (printf "%s:%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" (index $wrapperDirs 0) (index $wrapperDirs 1)) -}}
{{- $entries := splitList ":" $path -}}
{{- $systemIdx := -1 -}}
{{- range $i, $entry := $entries -}}
{{- if and (eq $entry "/usr/bin") (lt $systemIdx 0) -}}
{{- $systemIdx = $i -}}
{{- end -}}
{{- end -}}
{{- range $dir := $wrapperDirs -}}
{{- $idx := -1 -}}
{{- range $i, $entry := $entries -}}
{{- if and (eq $entry $dir) (lt $idx 0) -}}
{{- $idx = $i -}}
{{- end -}}
{{- end -}}
{{- if lt $idx 0 -}}
{{- fail (printf "env.path must include the Paperclip GitHub egress wrapper directory %q, or agent `gh` resolves to the unscrubbed image CLI (PEN-2527)" $dir) -}}
{{- end -}}
{{- if and (ge $systemIdx 0) (gt $idx $systemIdx) -}}
{{- fail (printf "env.path must place the Paperclip GitHub egress wrapper directory %q before /usr/bin, or agent `gh` resolves to the unscrubbed image CLI (PEN-2527)" $dir) -}}
{{- end -}}
{{- end -}}
{{- $path -}}
{{- end }}
