# Shared compiler cache

The agent toolchain includes checksum-pinned sccache 0.16.0. Enable it only
for agents belonging to the company that owns the private cache. Keep
`CARGO_TARGET_DIR` on the Job's existing `/runtime-cache` emptyDir; sharing
Cargo target directories mixes mutable build state and locks between Jobs.

Blockcast uses `paperclip-compiler-cache-blockcast`, prefix `rust/`, on the
existing Ceph RGW service. This is agent build state, separate from protected
CI writer buckets. It has a 20 GiB quota and expires compiler objects after
14 days. Incomplete multipart uploads expire after one day. Cache contents
can be regenerated; source, checkouts and job transcripts are outside it.

Configure these adapter environment values for Blockcast's Kubernetes agents:

```text
RUSTC_WRAPPER=/usr/local/bin/paperclip-sccache
CARGO_INCREMENTAL=0
CARGO_HOME=/runtime-cache/cargo
CARGO_TARGET_DIR=/runtime-cache/cargo-target
SCCACHE_BUCKET=paperclip-compiler-cache-blockcast
SCCACHE_ENDPOINT=http://ceph-rgw.kube-system.svc.cluster.local:7480
SCCACHE_REGION=us-east-1
SCCACHE_S3_USE_SSL=false
SCCACHE_S3_KEY_PREFIX=rust
SCCACHE_S3_RW_MODE=READ_WRITE
SCCACHE_IGNORE_SERVER_IO_ERROR=1
```

Bind `SCCACHE_ACCESS_KEY_ID` and
`SCCACHE_SECRET_ACCESS_KEY` to company Secrets. The wrapper exports
AWS credentials only inside sccache; other S3 tools retain their own identity.
The cache writer owns no buckets, has no administrative caps, and can read,
write and list only `rust/`. Anonymous access and other companies are denied.
The bucket-owner bootstrap key is retired after provisioning; only an operator
may change policy, quota or lifecycle.

Before enabling the fleet, run the same offline Cargo library build in two
fresh containers with separate target directories. Require a cold miss/write,
a warm hit, zero cache errors, anonymous read denial, outside-prefix denial,
and denial against another bucket. Inspect `sccache --show-stats --stats-format=json`.
Cargo still compiles uncached work such as linking binaries and procedural
macros. Missing cache credentials and cache-service outages fall back to the compiler.

These fixed Cargo paths refer to separate emptyDirs in each Pod. Registry
dependency source paths then match across jobs; sccache's Rust keys include
the Cargo environment and compiler working directory. Different application
checkout paths can still miss even when their dependencies hit. Runtime policy
permits these two exact Cargo paths for a Pod's ephemeral cache volume.
