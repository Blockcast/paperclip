# CephFS `globalmount` EACCES strands every pod on the shared claim

**Symptom class:** pods that mount the shared RWX CephFS claim `paperclip-data` never start. Agent
pods schedule, sit in `PodInitializing`, and are reaped at the 600s timeout; the platform records
this as `k8s_pod_schedule_failed`, which is a **mislabel** — nothing failed to schedule.

First observed 2026-08-20T18:04:38Z. This runbook was written during that incident.

## Confirm you are looking at this and not something else

Bucket by the **error body**, never by the error code. The recovery machinery mints
`k8s_pod_schedule_failed` with `nextAction: "…fix the runtime/adapter failure"`, and `retryReason`
takes at least four different values (`transient_failure`, `issue_continuation_needed`,
`missing_issue_comment`, `null`) across beacons produced by this single generator. Bucketing on
either field scatters one fault across four buckets and points at the adapter, which is not
involved.

```
kubectl -n paperclip get events --field-selector type=Warning
```

You have this fault if you see **permission denied on a path that exists** at either site:

```
# kubelet / CSI
MountVolume.SetUp failed … lstat /var/lib/kubelet/plugins/kubernetes.io/csi/
  cephfs.csi.ceph.com/<volume-handle>/globalmount: permission denied

# containerd
failed to generate spec: failed to stat /var/lib/kubelet/pods/…/volumes/
  kubernetes.io~csi/<pvc-uid>/mount: permission denied
```

EACCES, not ENOENT, is the discriminator: the path is there and the kubelet may not traverse it.
That points at the CephFS client's authorization to the subvolume (caps/keyring) or at the
ownership/mode of the globalmount directory.

Adapter-independence check: the failing set spans `ac-*` (claude_k8s) pods, `agent-opencode-*`
pods, and `paperclip-api-*`, which is not an agent pod at all.

## ⛔ Two remediations that do not work

**Restarting the `ceph-csi-cephfs` nodeplugin DaemonSet.** During the 2026-08-20 incident the
cluster ran this experiment by accident: `nodeplugin-pmk44` on `k8s-paperclip-6` came up fresh
(17 minutes old, 0 restarts) and `paperclip-api-56d588fd68-g9x6v`, scheduled on that same node,
still failed afterwards. Before recommending a remediation here, look for the natural experiment
already sitting in the cluster.

**Reading the nodeplugin restart counters as a crash-loop.** `kubectl get pods` shows *lifetime*
restart totals. During the incident these read 63 / 51 / 32 on the busiest nodes while every pod
was `3/3 Running` with its most recent restart ~9h old and four pods at zero. A high cumulative
counter is not a current rate.

## Check the control plane before you start

This fault also wedges `paperclip-api`, and it cannot self-heal:

```
kubectl -n paperclip get deploy paperclip-api -o jsonpath='{.status}'
```

The template carries `topologySpreadConstraints` with `minDomains: 2` and
`whenUnsatisfiable: DoNotSchedule`, so once one replica is down the replacement will **not**
schedule onto the surviving node. The deployment sits at `readyReplicas: 1`,
`Available: False / MinimumReplicasUnavailable` until the mount is fixed — a redundancy of one,
one failure away from a full control-plane outage. Note the `Available` condition's
`lastTransitionTime` when you start; it is the honest clock for the degradation.

## Remediate (requires node access)

No agent can do this — the fleet holds a read-only k8s grant only.

1. On an affected node, inspect ownership and mode of
   `/var/lib/kubelet/plugins/kubernetes.io/csi/cephfs.csi.ceph.com/<volume-handle>/globalmount`.
2. Inspect the ceph client caps for the `paperclip-data` subvolume.
3. Determine whether the stranded globalmount needs clearing per affected node, or whether
   reconciling caps/ownership is sufficient.

⚠️ Diagnosing this must not become a credential exposure. `pods_get` and `resources_get` return
`spec.containers[].env` in the clear, so an agent asked to help here can leak every other agent's
run credentials into a transcript. Keep the caps/keyring inspection on the node.

## Verify

Done is **not** "nodeplugin restarted". Done is all three:

- zero `FailedMount` Warning events on the claim across a 60-minute window;
- `Deployment/paperclip-api` reporting `Available: True` with `readyReplicas: 2`;
- a recorded answer on what the restarts' actual cause was — a refuted hypothesis recorded here is
  a deliverable, because it stops the next responder re-deriving it.

## Related

- `queued-run-stranded.md` — the run-level symptom this produces downstream.
- `agent-wakeup-terminal-failed.md` — recovery-action behaviour when runs die in bulk.
