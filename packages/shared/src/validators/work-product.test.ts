import { describe, expect, it } from "vitest";
import {
  attachmentArtifactWorkProductMetadataSchema,
  workProductExternalIdMatchKey,
  workProductExternalIdMatchMode,
} from "./work-product.js";

describe("attachmentArtifactWorkProductMetadataSchema", () => {
  it("accepts the attachment-backed artifact metadata contract", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      openPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content?download=1",
      originalFilename: "demo.mp4",
    });

    expect(parsed.contentType).toBe("video/mp4");
    expect(parsed.downloadPath).toContain("download=1");
  });

  it("rejects off-route or scriptable paths", () => {
    const parsed = attachmentArtifactWorkProductMetadataSchema.safeParse({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      byteSize: 1234,
      contentPath: "https://evil.example/video.mp4",
      openPath: "javascript:alert(1)",
      downloadPath: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
      originalFilename: "demo.mp4",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected invalid attachment artifact metadata");
    }
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "contentPath",
      "openPath",
      "downloadPath",
    ]);
  });
});

// PEN-6056. The fold is decided here and applied in two places that must agree:
// the query predicate in `listOwnersByExternalId` and the `lower(external_id)`
// index expression (migration 0279). A drift between them reintroduces the
// original defect silently, because a lookup that matches nothing is
// byte-identical to an artifact nobody owns.
describe("workProductExternalIdMatchMode", () => {
  it("folds a GitHub pull-request key, which GitHub itself treats case-insensitively", () => {
    expect(workProductExternalIdMatchMode("github", "pull_request")).toBe("case_insensitive");
    expect(workProductExternalIdMatchKey("github", "pull_request", "Blockcast/Paperclip#3205"))
      .toBe("blockcast/paperclip#3205");
  });

  // The number must survive the fold. Folding the whole canonical string is only
  // safe because digits cannot change case.
  it("leaves the pull-request number exact", () => {
    expect(workProductExternalIdMatchKey("github", "pull_request", "Blockcast/Paperclip#3205"))
      .toMatch(/#3205$/);
  });

  // NOT "external ids are case-insensitive". A branch key names a git ref and refs
  // ARE case-sensitive: `feature/Foo` and `feature/foo` are two branches, so
  // folding them would merge two real artifacts into one.
  it("leaves every other artifact kind matching byte-exactly", () => {
    for (const type of ["branch", "commit", "preview_url", "artifact", "document"]) {
      expect(workProductExternalIdMatchMode("github", type)).toBe("exact");
      expect(workProductExternalIdMatchKey("github", type, "feature/Foo")).toBe("feature/Foo");
    }
  });

  // The fold is a property of the PROVIDER, not of the key's shape: another
  // provider's `pull_request` has made no such promise.
  it("leaves another provider's pull request matching byte-exactly", () => {
    expect(workProductExternalIdMatchMode("gitlab", "pull_request")).toBe("exact");
  });

  // The mode this function returns is REPORTED to the caller as `externalIdMatch`,
  // and `listOwnersByExternalId` filters the provider column with a plain `eq`.
  // So the provider must be compared here the way it is compared there. Folding it
  // here alone made `provider=GitHub` return no row -- the stored value is
  // `github` -- while announcing that the casing had been folded, which is this
  // row's own defect reappearing one field over, now with a signal that denies it.
  it("decides the provider the way the query does, so the reported mode is true", () => {
    expect(workProductExternalIdMatchMode("GitHub", "pull_request")).toBe("exact");
    expect(workProductExternalIdMatchKey("GitHub", "pull_request", "Blockcast/Paperclip#3205"))
      .toBe("Blockcast/Paperclip#3205");
  });
});
