import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CPU_PROFILE_EXTENSION,
  CPU_PROFILE_SENTINEL_BASENAME,
  maybeTakeCpuProfile,
} from "../services/cpu-profile.js";

describe("maybeTakeCpuProfile (BLO-45336)", () => {
  it("does nothing without the sentinel", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    expect(await maybeTakeCpuProfile({ dir, durationMs: 10, keep: 3 })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("consumes the sentinel, writes a parseable profile, and keeps only the newest N", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    for (const old of ["2000-01-01T00-00-00-000Z-pid1", "2000-01-02T00-00-00-000Z-pid1"]) {
      writeFileSync(path.join(dir, old + CPU_PROFILE_EXTENSION), "{}");
    }
    writeFileSync(path.join(dir, "keep-me.heapsnapshot"), "x");
    writeFileSync(path.join(dir, CPU_PROFILE_SENTINEL_BASENAME), "");

    const file = await maybeTakeCpuProfile({ dir, durationMs: 50, keep: 2 });

    expect(file).not.toBeNull();
    const profile = JSON.parse(readFileSync(file!, "utf8"));
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(readdirSync(dir).sort()).toEqual(
      ["2000-01-02T00-00-00-000Z-pid1.cpuprofile", path.basename(file!), "keep-me.heapsnapshot"].sort(),
    );
    // Sentinel consumed: a second poll is a no-op.
    expect(await maybeTakeCpuProfile({ dir, durationMs: 10, keep: 2 })).toBeNull();
  });
});
