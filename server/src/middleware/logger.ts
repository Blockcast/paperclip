import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { createHttpLogger } from "./http-log-policy.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  redact: ["req.headers.authorization"],
  // Pino only applies its Error serializer to the `err` key. ~35 call sites in
  // this repo log `{ error }` instead, and an Error's own `message`/`stack` are
  // non-enumerable -- so those lines render the diagnostic as an empty object
  // and carry nothing at all. Merged over pino's defaults, so `err` keeps
  // working; non-Error values (`error: String(e)`) pass through untouched.
  serializers: { error: pino.stdSerializers.err },
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = createHttpLogger(logger);
