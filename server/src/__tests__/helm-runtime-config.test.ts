import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chartDir = join(process.cwd(), "deploy/helm/paperclip");

function readChartFile(relativePath: string): string {
  return readFileSync(join(chartDir, relativePath), "utf8");
}

describe("paperclip Helm runtimeConfig", () => {
  it("declares an enabled runtimeConfig emptyDir for browser XDG config", () => {
    const values = readChartFile("values.yaml");

    expect(values).toContain("runtimeConfig:");
    expect(values).toContain("enabled: true");
    expect(values).toContain("mountPath: /runtime-config");
    expect(values).toContain("browser session source-of-truth is owned by authbot");
  });

  it("wires XDG_CONFIG_HOME and runtime-config into workers and seed", () => {
    const statefulSet = readChartFile("templates/statefulset.yaml");

    expect(statefulSet).toContain("- name: XDG_CONFIG_HOME");
    expect(statefulSet).toContain("value: {{ .Values.runtimeConfig.mountPath | quote }}");
    expect(statefulSet).toContain("- name: runtime-config");
    expect(statefulSet).toContain("mountPath: {{ .Values.runtimeConfig.mountPath | quote }}");
    expect(statefulSet).toContain("emptyDir:\n            sizeLimit: {{ .Values.runtimeConfig.sizeLimit | quote }}");
  });

  it("wires XDG_CONFIG_HOME and runtime-config into the API tier", () => {
    const deployment = readChartFile("templates/deployment-api.yaml");

    expect(deployment).toContain("- name: XDG_CONFIG_HOME");
    expect(deployment).toContain("value: {{ .Values.runtimeConfig.mountPath | quote }}");
    expect(deployment).toContain("- name: runtime-config");
    expect(deployment).toContain("mountPath: {{ .Values.runtimeConfig.mountPath | quote }}");
    expect(deployment).toContain("emptyDir:\n            sizeLimit: {{ .Values.runtimeConfig.sizeLimit | quote }}");
  });
});
