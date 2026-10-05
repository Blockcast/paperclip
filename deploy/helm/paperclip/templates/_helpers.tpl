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
{{- $hasWebhookSecret := false -}}
{{/* A literal empty value renders fine and then throws in config.ts at boot, so
it does not count as bound. A valueFrom entry carries no literal here and is not
checkable from a template, so secretKeyRef bindings keep passing. Assign on every
match rather than latching true: env is a list, the kubelet takes the last entry
for a duplicated name, so an empty override after a valid entry is what actually
reaches the container. */}}
{{- range $entry := (.Values.env).extra -}}
{{- if eq (toString ($entry.name | default "")) "GITHUB_WEBHOOK_SECRET" -}}
{{- $hasWebhookSecret = not (and (hasKey $entry "value") (empty (toString ($entry.value | default "")))) -}}
{{- end -}}
{{- end -}}
{{- if not $hasWebhookSecret -}}
{{- fail "githubApp.reviewGateCaptureEnabled requires a non-empty GITHUB_WEBHOOK_SECRET entry in env.extra" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The API tier must not receive the Penstock org credential. `env.extra` is
shared by both tiers, so a credential-shaped entry there is a configuration
error rather than a convenient shortcut. The worker-only `extraEnv` block is
the reviewed boundary for this binding.
*/}}
{{- define "paperclip.validateSharedEnvExtra" -}}
{{- range $entry := .Values.env.extra -}}
{{- if eq (toString ($entry.name | default "")) "PENSTOCK_API_KEY" -}}
{{- fail "env.extra must not define PENSTOCK_API_KEY: bind the Penstock credential through worker.extraEnv so API pods do not receive it" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/* Validate the exact Secret-backed Penstock binding when configured. */}}
{{- define "paperclip.validateWorkerExtraEnv" -}}
{{- range $entry := .Values.worker.extraEnv -}}
{{- if eq (toString ($entry.name | default "")) "PENSTOCK_API_KEY" -}}
{{- if hasKey $entry "value" -}}
{{- fail "worker.extraEnv PENSTOCK_API_KEY must use valueFrom.secretKeyRef, not a literal value" -}}
{{- end -}}
{{- $valueFrom := (get $entry "valueFrom") | default dict -}}
{{- $secretKeyRef := (get $valueFrom "secretKeyRef") | default dict -}}
{{- $_ := required "worker.extraEnv PENSTOCK_API_KEY requires valueFrom.secretKeyRef.name" (get $secretKeyRef "name") -}}
{{- $_ := required "worker.extraEnv PENSTOCK_API_KEY requires valueFrom.secretKeyRef.key" (get $secretKeyRef "key") -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The image directory holding the root-owned GitHub egress wrappers (PEN-3713).

Hardcoded on purpose, unlike the PVC directories below: this one is a path
inside the image, fixed by the Dockerfile `COPY` that installs it, so deriving
it from a value would let an operator point PATH at a directory no image has.
*/}}
{{- define "paperclip.imageWrapperBinDir" -}}
/usr/local/libexec/paperclip/bin
{{- end }}

{{/*
The directories holding the GitHub egress wrappers, in the order they must
appear on PATH.

First the root-owned image directory (PEN-3713), which is where the wrappers
now actually come from. Then the two PVC directories the seed init container
still publishes into, derived from persistence.mountPath because the seed
derives them the same way (`BASE={{ .Values.persistence.mountPath }}`); a
hardcoded /paperclip would silently miss every deployment that relocates the
PVC.

Both generations are listed deliberately, and the ordering is the whole
migration plan. A chart that rolls before the images would otherwise resolve
`gh` past an image directory that does not exist yet and land on the
unscrubbed /usr/bin/gh — a silent PEN-2527 regression. With the PVC entries
retained behind it, an old image falls back to the copies it already has and
a new image wins outright, so neither rollout order has a window. Dropping the
PVC entries is the follow-up, once the fleet is known to be on new images.
*/}}
{{- define "paperclip.wrapperBinDirs" -}}
{{- $base := .Values.persistence.mountPath | trimSuffix "/" -}}
{{- printf "%s,%s/.local/bin,%s/bin" (include "paperclip.imageWrapperBinDir" .) $base $base -}}
{{- end }}

{{/*
PATH for containers that run agent tooling.

PEN-2527/PEN-2526: agent-authored GitHub content is scrubbed of credential-shaped
material by wrapper binaries in `paperclip.wrapperBinDirs`. The scrubber only sits
on the traffic path if those directories precede /usr/bin, where the unscrubbed
image `gh` lives. The PVC's `.local/bin` is prepended by its `.profile`/`.bashrc`,
which only a *login* shell sources; agent tool harnesses spawn non-login shells. So
the PATH the container itself carries is the only thing that reaches the scrubber,
which makes it a chart-level invariant rather than one operator's values file.

PEN-3713: the root-owned image directory leads, so the wrappers that execute are
the ones uid 1000 cannot rewrite.

Override with `env.path`. The override is validated rather than trusted: it must
keep every wrapper directory ahead of /usr/bin, and must keep them in the order
this chart declares them, or the render fails. Both halves matter, and the
second is not implied by the first: an override that lists the agent-writable
PVC directories ahead of the root-owned image directory satisfies every
per-directory check — each one is present, each one precedes /usr/bin — while
resolving `gh` to exactly the copy uid 1000 can rewrite. The failure mode being
prevented is an agent that looks healthy while publishing unscrubbed, so a
reordering that reinstates it must fail as loudly as an omission.
*/}}
{{- define "paperclip.runtimePath" -}}
{{- $wrapperDirs := splitList "," (include "paperclip.wrapperBinDirs" .) -}}
{{- range $entry := .Values.env.extra -}}
{{- if eq ($entry.name | toString) "PATH" -}}
{{- fail "env.extra must not define PATH: a duplicate env var would silently override the chart-managed PATH that keeps the GitHub egress scrubber (PEN-2527) ahead of /usr/bin. Set env.path instead, which is validated." -}}
{{- end -}}
{{- end -}}
{{- $path := .Values.env.path | default (printf "%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" (join ":" $wrapperDirs)) -}}
{{- $entries := splitList ":" $path -}}
{{- $systemIdx := -1 -}}
{{- range $i, $entry := $entries -}}
{{- if and (eq $entry "/usr/bin") (lt $systemIdx 0) -}}
{{- $systemIdx = $i -}}
{{- end -}}
{{- end -}}
{{- /* `paperclip.wrapperBinDirs` is an ordered list, not a set: it names the
       root-owned image directory first and the agent-writable PVC directories
       behind it, and that order IS the PEN-3713 fix. So the override is checked
       for relative order as well as presence — `$prevIdx` carries the previous
       declared directory's position and each one must land after it. Without
       this the two checks below pass per-directory on a PATH that resolves `gh`
       to the PVC copy. */ -}}
{{- $prevIdx := -1 -}}
{{- $prevDir := "" -}}
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
{{- if and (ge $prevIdx 0) (lt $idx $prevIdx) -}}
{{- fail (printf "env.path must keep the Paperclip GitHub egress wrapper directories in the order this chart declares them: %q must precede %q. Both are ahead of /usr/bin, so every per-directory check passes, but `gh` resolves to the first match — and %q is the agent-writable PVC copy that uid 1000 can rewrite, which is the defect PEN-3713 fixed." $prevDir $dir $dir) -}}
{{- end -}}
{{- $prevIdx = $idx -}}
{{- $prevDir = $dir -}}
{{- end -}}
{{- $path -}}
{{- end }}

{{/*
Render evidenceGate.unlabeledTruthBlock, failing loudly on anything but "0"/"1".

The server reads this env var as `=== "1"` (server/src/config.ts), so a YAML bool
— `unlabeledTruthBlock: true`, the most natural thing to write for a rollout
flag — renders "true" and reads as OFF. It fails safe and it fails SILENTLY,
which is the wrong shape for a flag whose entire purpose is a measured flip: the
operator would read seven days of zero blocks as "the gate is quiet" rather than
"the gate is off". Quote your values.
*/}}
{{- define "paperclip.evidenceGateUnlabeledTruthBlock" -}}
{{- $raw := ((.Values.evidenceGate).unlabeledTruthBlock) -}}
{{- /* Only a genuinely absent key defaults; everything else is validated.
       `kindIs "invalid"` is the nil test, and it is deliberately NOT `empty`
       or `default`: Go templates count boolean `false` as empty, so both of
       those collapse `unlabeledTruthBlock: false` to "0" silently while
       `true` fails loudly — the same unquoted-bool trap this helper exists to
       catch, one level down. Both bools are now the same class of mistake and
       both say so. */ -}}
{{- $v := (kindIs "invalid" $raw | ternary "0" ($raw | toString)) -}}
{{- if not (has $v (list "0" "1")) -}}
{{- fail (printf "evidenceGate.unlabeledTruthBlock must be the string \"0\" or \"1\", got %q (note: an unquoted YAML bool renders \"true\"/\"false\" and the server reads either as off) — docs/runbooks/evidence-gate-unlabeled-block.md" $v) -}}
{{- end -}}
{{- $v | quote -}}
{{- end }}
