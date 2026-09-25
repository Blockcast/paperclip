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

    await clients.core.replaceNamespacedSecret({
      namespace: input.namespace,
      name: input.secretName,
      body: {
        ...body,
        metadata: {
          ...body.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        },
      },
    });
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
