import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as decisionRecords from "./security-decision-records.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * PEN-6158: the pointers in `security-decision-records.ts` were asserted by
 * SHAPE and never by TARGET.
 *
 * PEN-4939 moved two refusal messages off repo-relative doc paths and onto
 * absolute URLs, and shipped two guards with them: `relativeDocsPointers`, which
 * asserts no emitted pointer is repo-relative, and a `/^https:\/\//` match on
 * each constant. Both describe the FORM of the pointer. Neither opens it. So
 * renaming or moving either record left both guards green while the refusal
 * handed its reader a dead end again - the same unactionable refusal PEN-4939
 * was filed for, relocated from a 404 in the reader's repository to a 404 on
 * github.com.
 *
 * The absolute form fails more quietly than the relative one did, which is why
 * this is worth a guard rather than a convention: `docs/security/...` at least
 * looks repo-relative, so a reader can reason about why it missed, whereas
 * `https://github.com/Blockcast/paperclip/blob/master/docs/security/...` reads
 * authoritative right up to the 404.
 *
 * The check is offline and needs no network: these URLs name files in THIS
 * repository, so the working tree answers the question a fetch would.
 */

/** `https://github.com/<owner>/<repo>/blob/<ref>/<path>` */
const BLOB_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/;
/** `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` */
const RAW_URL = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/;

/**
 * The repository-relative path a decision-record URL names, or `null` if the
 * URL is not in a form whose target this guard can locate.
 *
 * `null` is a FAILURE below, never a skip. An unrecognised shape is exactly the
 * case where nobody has checked the target, so reading it as "not applicable"
 * would make the guard mute on the one input it exists for.
 */
const repoRelativeTarget = (url: string): string | null => {
  const match = BLOB_URL.exec(url) ?? RAW_URL.exec(url);
  if (!match) return null;
  // Strip a fragment: `...md#section-5` names the same file.
  return decodeURIComponent(match[1].split("#")[0]);
};

const urlExports = Object.entries(decisionRecords)
  .filter(([name, value]) => name.endsWith("_URL") && typeof value === "string")
  .map(([name, value]) => [name, value as string] as const);

describe("security decision records", () => {
  // The guard below is written over whatever the module exports, so that a
  // third record added later is covered without anybody remembering to add it
  // here - the module's own header comment tells authors to add records there.
  // That enumeration is also what can make this file mute: rename the exports
  // to `*_LINK` and `it.each` iterates an empty list and reports green over
  // nothing. This is the control for that.
  it("exports decision-record URLs for the guard below to enumerate", () => {
    expect(urlExports.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "IDENTIFIER_CLASS_DECISION_URL",
        "EGRESS_ENFORCEMENT_BOUNDARY_DECISION_URL",
      ]),
    );
  });

  it.each(urlExports)("%s points at a record that exists in this repository", (name, url) => {
    const target = repoRelativeTarget(url);
    // Fail closed on a shape this guard cannot resolve, naming the constant and
    // the value, so the next author sees what to teach it rather than a silent
    // pass.
    expect(target, `${name} is not a GitHub blob or raw URL whose target this guard can locate: ${url}`).not.toBeNull();

    const onDisk = path.join(repoRoot, target as string);
    expect(
      existsSync(onDisk),
      `${name} points at ${url}, whose target ${target} does not exist in this repository. ` +
        "Renaming or moving a decision record without updating this constant restores the " +
        "PEN-4939 dead end: the refusal that cites it hands its reader a 404.",
    ).toBe(true);
  });
});
