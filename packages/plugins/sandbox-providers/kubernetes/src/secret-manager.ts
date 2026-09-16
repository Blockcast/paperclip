import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type { KubeClients } from "./kube-client.js";

export interface CreatePerRunSecretInput {
  namespace: string;
  secretName: string;
  runId: string;
  ownerKind: string;
  ownerApiVersion: string;
  ownerName: string;
  ownerUid: string;
  bootstrapToken: string;
  adapterEnv: Record<string, string>;
}

type SecretResource = {
  apiVersion: "v1";
  kind: "Secret";
  type: "Opaque";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    ownerReferences: {
      apiVersion: string;
      kind: string;
      name: string;
      uid: string;
      controller: boolean;
      blockOwnerDeletion: boolean;
    }[];
  };
  stringData: Record<string, string>;
};

type ExistingSecret = {
  metadata?: {
    resourceVersion?: string;
    labels?: Record<string, string>;
  };
};

export async function createPerRunSecret(clients: KubeClients, input: CreatePerRunSecretInput): Promise<void> {
  if (!input.ownerUid) {
    throw new Error("createPerRunSecret requires a non-empty ownerUid");
  }
  if ("BOOTSTRAP_TOKEN" in input.adapterEnv) {
    throw new Error("adapterEnv must not contain BOOTSTRAP_TOKEN (reserved key)");
  }

  const body: SecretResource = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: input.secretName,
      namespace: input.namespace,
      labels: {
        "paperclip.io/run-id": input.runId,
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
      },
      ownerReferences: [
        {
          apiVersion: input.ownerApiVersion,
          kind: input.ownerKind,
          name: input.ownerName,
          uid: input.ownerUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    stringData: {
      BOOTSTRAP_TOKEN: input.bootstrapToken,
      ...input.adapterEnv,
    },
  };

  try {
    await clients.core.createNamespacedSecret({
      namespace: input.namespace,
      body,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;

    // A retry of the same run can collide with the Secret left by its first
    // attempt. Adopt it only after verifying the immutable Paperclip identity;
    // never overwrite another run's Secret just because the name collided.
    let existing: ExistingSecret;
    try {
      existing = (await clients.core.readNamespacedSecret({
        namespace: input.namespace,
        name: input.secretName,
      })) as ExistingSecret;
    } catch (readErr) {
      if (isNotFound(readErr)) throw err;
      throw new Error(`Secret ${input.namespace}/${input.secretName} already exists and could not be read`, { cause: readErr });
    }

    const labels = existing.metadata?.labels;
    if (
      labels?.["paperclip.io/run-id"] !== input.runId ||
      labels?.["paperclip.io/managed-by"] !== "paperclip-k8s-plugin"
    ) {
      throw new Error(`Secret ${input.namespace}/${input.secretName} already exists with unexpected Paperclip identity`);
    }

    // A merge PATCH, not `replaceNamespacedSecret`. A replace is a PUT, i.e.
    // the `update` verb; `patch` is the narrower verb for the same effect and
    // there is no reason for an adoption write to ask for the wider one.
    //
    // Do NOT read the sibling's RBAC argument onto this call. The vendored
    // claude_k8s adapter writes into the release namespace, which
    // `deploy/helm/paperclip/templates/role.yaml` governs; this plugin writes
    // into per-tenant namespaces (`deriveTenantNamespace`, plugin.ts), and
    // nothing in-tree grants the server's service account secrets there at
    // all. Measured 2026-09-16 by SSAR as
    // `system:serviceaccount:paperclip:paperclip`: in ns `paperclip`
    // create/get/patch/update/delete are all allowed, while in a tenant
    // namespace every one of them is denied — including `create`. So this
    // verb change cannot introduce a 403 that did not already exist: the
    // `createNamespacedSecret` above fails first and this line is
    // unreachable. The tenant-namespace RBAC gap is real and is a separate
    // defect (the Role `ensureTenantNamespace` provisions grants only
    // `pods/log: get`, and to the tenant SA, not to ours); it is not created
    // or worsened here.
    //
    // `resourceVersion` is still carried, so a concurrent writer still
    // surfaces as a 409 rather than being silently clobbered.
    await clients.core.patchNamespacedSecret(
      {
        namespace: input.namespace,
        name: input.secretName,
        body: {
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: existing.metadata?.resourceVersion,
          },
        },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  }
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 409 || e.statusCode === 409;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}
