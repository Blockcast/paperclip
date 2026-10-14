# BLO-32734 Phase 2a — hide the instance root behind a per-pod overlay

Tracking: [BLO-32734](https://paperclip.blockcast.net/BLO/issues/BLO-32734)

**Files:** `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`

The read-only `data` mount closed cross-tenant write but not read: every pod runs as the uid that owns the volume, so a narrowed pod could still read every foreign company's `run-logs/`, `projects/`, `companies/` and `k8s-isolation/` trees, plus `secrets/master.key` (the live `local_encrypted` key, confirmed by the CTO) next to plaintext DB dumps in `data/backups/`. On narrowed runs an `emptyDir` (`instance-overlay`, 16Mi) is now mounted over `instances/default` in both containers, right after the read-only parent and before every subPath bind, so the run's own binds are re-applied on top of it. The company's skills tree (`skills/<companyId>`) is re-exposed read-only, because prompt-bundle skill links point there, and it is added to `scopedWritableDirs` so the kubelet never creates it `root:root`. Broad-mount runs are unchanged. Root-level tenant data outside `instances/` is the stated Phase 2b residual. Tests mutation-checked: dropping the overlay (either container), the skills bind, its `readOnly`, or its pre-create each fails the suite.
