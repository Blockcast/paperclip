import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

/**
 * Ajv runs in strict mode, which throws on an unknown keyword rather than
 * ignoring it. The Paperclip annotation keywords are therefore not free: a
 * manifest using one would fail to compile, and every config save and test for
 * that plugin would 500 (BLO-20871).
 */
describe("validateInstanceConfig — Paperclip annotation keywords", () => {
  it("compiles a schema marking a field secret-bearing", () => {
    expect(() =>
      validateInstanceConfig(
        { token: "value" },
        { type: "object", properties: { token: { type: "string", "x-paperclip-secret": true } } },
      ),
    ).not.toThrow();
  });

  it("compiles a schema opting a field out of the name heuristic", () => {
    const result = validateInstanceConfig(
      { token: "value" },
      { type: "object", properties: { token: { type: "string", "x-paperclip-secret": false } } },
    );

    expect(result.valid).toBe(true);
  });

  it("compiles a schema marking a secret-bearing object", () => {
    const result = validateInstanceConfig(
      { auth: { user: "svc", password: "live" } },
      {
        type: "object",
        properties: {
          auth: {
            type: "object",
            "x-paperclip-secret": true,
            properties: { user: { type: "string" }, password: { type: "string" } },
          },
        },
      },
    );

    expect(result.valid).toBe(true);
  });

  it("compiles a schema designating an array entry identity", () => {
    const result = validateInstanceConfig(
      { targets: [{ name: "alpha", token: "live" }] },
      {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              "x-paperclip-identity": "name",
              properties: { name: { type: "string" }, token: { type: "string" } },
            },
          },
        },
      },
    );

    expect(result.valid).toBe(true);
  });

  it("still reports genuine validation errors alongside the annotations", () => {
    const result = validateInstanceConfig(
      { token: 42 },
      {
        type: "object",
        properties: { token: { type: "string", "x-paperclip-secret": true } },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.field).toBe("/token");
  });
});
