import { z } from "zod";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";
import { validateConfiguredBindMode } from "./network-bind.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
});

export const llmConfigSchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().optional(),
});

export const databaseBackupConfigSchema = z.object({
  enabled: z.boolean().prefault(true),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).prefault(60),
  retentionDays: z.number().int().min(1).max(3650).prefault(7),
  dir: z.string().prefault("~/.paperclip/instances/default/data/backups"),
});

export const databaseConfigSchema = z.object({
  mode: z.enum(["embedded-postgres", "postgres"]).prefault("embedded-postgres"),
  connectionString: z.string().optional(),
  embeddedPostgresDataDir: z.string().prefault("~/.paperclip/instances/default/db"),
  embeddedPostgresPort: z.number().int().min(1).max(65535).prefault(54329),
  backup: databaseBackupConfigSchema.prefault({
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 7,
    dir: "~/.paperclip/instances/default/data/backups",
  }),
});

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().prefault("~/.paperclip/instances/default/logs"),
});

export const serverConfigSchema = z.object({
  deploymentMode: z.enum(DEPLOYMENT_MODES).prefault("local_trusted"),
  exposure: z.enum(DEPLOYMENT_EXPOSURES).prefault("private"),
  bind: z.enum(BIND_MODES).optional(),
  customBindHost: z.string().optional(),
  host: z.string().prefault("127.0.0.1"),
  port: z.number().int().min(1).max(65535).prefault(3100),
  allowedHostnames: z.array(z.string().min(1)).prefault([]),
  serveUi: z.boolean().prefault(true),
});

export const authConfigSchema = z.object({
  baseUrlMode: z.enum(AUTH_BASE_URL_MODES).prefault("auto"),
  publicBaseUrl: z.string().url().optional(),
  disableSignUp: z.boolean().prefault(false),
});

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().prefault("~/.paperclip/instances/default/data/storage"),
});

export const storageS3ConfigSchema = z.object({
  bucket: z.string().min(1).prefault("paperclip"),
  region: z.string().min(1).prefault("us-east-1"),
  endpoint: z.string().optional(),
  prefix: z.string().prefault(""),
  forcePathStyle: z.boolean().prefault(false),
});

export const storageConfigSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS).prefault("local_disk"),
  localDisk: storageLocalDiskConfigSchema.prefault({
    baseDir: "~/.paperclip/instances/default/data/storage",
  }),
  s3: storageS3ConfigSchema.prefault({
    bucket: "paperclip",
    region: "us-east-1",
    prefix: "",
    forcePathStyle: false,
  }),
});

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z.string().prefault("~/.paperclip/instances/default/secrets/master.key"),
});

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).prefault("local_encrypted"),
  strictMode: z.boolean().prefault(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.prefault({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
});

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().prefault(true),
}).prefault({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    llm: llmConfigSchema.optional(),
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    auth: authConfigSchema.prefault({
      baseUrlMode: "auto",
      disableSignUp: false,
    }),
    storage: storageConfigSchema.prefault({
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    }),
    secrets: secretsConfigSchema.prefault({
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    }),
  })
  .superRefine((value, ctx) => {
    if (value.server.deploymentMode === "local_trusted" && value.server.exposure !== "private") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server.exposure must be private when deploymentMode is local_trusted",
        path: ["server", "exposure"],
      });
    }

    for (const message of validateConfiguredBindMode({
      deploymentMode: value.server.deploymentMode,
      deploymentExposure: value.server.exposure,
      bind: value.server.bind,
      host: value.server.host,
      customBindHost: value.server.customBindHost,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: message.includes("customBindHost") ? ["server", "customBindHost"] : ["server", "bind"],
      });
    }

    if (value.auth.baseUrlMode === "explicit" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when auth.baseUrlMode is explicit",
        path: ["auth", "publicBaseUrl"],
      });
    }

    if (value.server.exposure === "public" && value.auth.baseUrlMode !== "explicit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.baseUrlMode must be explicit when deploymentMode=authenticated and exposure=public",
        path: ["auth", "baseUrlMode"],
      });
    }

    if (value.server.exposure === "public" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when deploymentMode=authenticated and exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }
  });

export type PaperclipConfig = z.infer<typeof paperclipConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageLocalDiskConfig = z.infer<typeof storageLocalDiskConfigSchema>;
export type StorageS3Config = z.infer<typeof storageS3ConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type SecretsLocalEncryptedConfig = z.infer<typeof secretsLocalEncryptedConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
export type DatabaseBackupConfig = z.infer<typeof databaseBackupConfigSchema>;
