/**
 * Real-process fixture for the final graceful-shutdown breadcrumb. The initial
 * write pressures piped stderr; awaiting the final write must preserve stream
 * ordering before the forced exit.
 */

import { writeShutdownBreadcrumbsBounded } from "../../shutdown-log.js";

const accepted = process.stderr.write("P".repeat(200_000));
process.stdout.write(accepted ? "NO_BACKPRESSURE\n" : "BACKPRESSURE\n");

await writeShutdownBreadcrumbsBounded(["handler complete; exiting (signal=SIGTERM)"]);
process.exit(0);
