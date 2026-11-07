import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { costsApi } from "@/api/costs";
import {
  __resetRememberedCapDays,
  capRefusalNotice,
  clampNotice,
  clampWindowToCap,
  fetchByProjectWithinCap,
  getRememberedCapDays,
  isClamped,
  readWindowCapDays,
} from "./by-project-window";

vi.mock("@/api/costs", () => ({
  costsApi: { byProject: vi.fn() },
}));

const byProject = vi.mocked(costsApi.byProject);

const NOW = new Date("2026-11-07T20:00:00.000Z");
const daysBefore = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

/** The shape `assertByProjectWindowWithinCap` actually returns (PEN-5591). */
function capRefusal(code: "window_too_wide" | "window_unbounded", maxWindowDays = 5) {
  return new ApiError("costs/by-project window is 30.0 days; the maximum is 5.", 400, {
    error: "costs/by-project window is 30.0 days; the maximum is 5.",
    details: { code, maxWindowDays, issue: "PEN-5591" },
  });
}

beforeEach(() => {
  __resetRememberedCapDays();
  byProject.mockReset();
});

describe("readWindowCapDays", () => {
  it("reads the cap out of a window_too_wide refusal", () => {
    expect(readWindowCapDays(capRefusal("window_too_wide"))).toBe(5);
  });

  it("reads the cap out of a window_unbounded refusal", () => {
    expect(readWindowCapDays(capRefusal("window_unbounded"))).toBe(5);
  });

  // The whole point of done-when 2: the UI must not carry the literal, so a
  // retune of the one server constant has to flow through unchanged.
  it("reports whatever the server says, not a value of its own", () => {
    expect(readWindowCapDays(capRefusal("window_too_wide", 12))).toBe(12);
  });

  // A refusal we cannot act on must stay an error rather than being retried
  // against some window we invented.
  it("ignores a 400 that is not a window refusal", () => {
    const err = new ApiError("invalid 'from' date", 400, {
      error: "invalid 'from' date",
      details: { code: "invalid_date" },
    });
    expect(readWindowCapDays(err)).toBeNull();
  });

  it("ignores a cap refusal with no usable maxWindowDays", () => {
    const err = new ApiError("refused", 400, {
      details: { code: "window_too_wide", maxWindowDays: "five" },
    });
    expect(readWindowCapDays(err)).toBeNull();
  });

  it("ignores non-API errors", () => {
    expect(readWindowCapDays(new Error("network down"))).toBeNull();
    expect(readWindowCapDays(null)).toBeNull();
  });
});

describe("clampWindowToCap", () => {
  it("narrows a wide selection to the trailing cap window", () => {
    const window = clampWindowToCap(daysBefore(30), NOW.toISOString(), 5, NOW);
    expect(window.from).toBe(daysBefore(5));
    expect(window.to).toBe(NOW.toISOString());
  });

  // `all` and an unfilled custom range both arrive as empty strings, and an
  // empty `from` is the full-history scan the cap exists to refuse.
  it("bounds an unbounded selection", () => {
    const window = clampWindowToCap("", "", 5, NOW);
    expect(window.from).toBe(daysBefore(5));
    expect(window.to).toBe(NOW.toISOString());
  });

  it("leaves a selection already inside the cap alone", () => {
    const from = daysBefore(2);
    const window = clampWindowToCap(from, NOW.toISOString(), 5, NOW);
    expect(window.from).toBe(from);
  });

  it("clamps relative to the selection's upper bound, not to now", () => {
    const to = daysBefore(10);
    const window = clampWindowToCap(daysBefore(40), to, 5, NOW);
    expect(window.to).toBe(to);
    expect(window.from).toBe(daysBefore(15));
  });
});

describe("isClamped", () => {
  it("is true when the lower bound moved", () => {
    expect(isClamped(daysBefore(30), { from: daysBefore(5), to: NOW.toISOString() })).toBe(true);
  });

  it("is true for a selection that had no lower bound", () => {
    expect(isClamped("", { from: daysBefore(5), to: NOW.toISOString() })).toBe(true);
  });

  it("is false when the selection already fit", () => {
    const from = daysBefore(2);
    expect(isClamped(from, { from, to: NOW.toISOString() })).toBe(false);
  });
});

describe("card copy", () => {
  // Done-when 3: a refused window has to read as an explanation naming the
  // limit, never as a raw error string.
  it("names the limit and the window actually covered when clamped", () => {
    const notice = clampNotice({
      rows: [],
      window: { from: daysBefore(5), to: NOW.toISOString() },
      capDays: 5,
      clamped: true,
    });
    expect(notice).toMatch(/limited to 5 days/);
    expect(notice).toMatch(/rather than the range selected above/);
  });

  it("says nothing when the selection already fit", () => {
    expect(clampNotice({
      rows: [],
      window: { from: daysBefore(2), to: NOW.toISOString() },
      capDays: 5,
      clamped: false,
    })).toBeNull();
    expect(clampNotice(undefined)).toBeNull();
  });

  // Done-when 2 again, on the copy itself: the number is the server's.
  it("quotes the server's cap rather than a number of its own", () => {
    const notice = clampNotice({
      rows: [],
      window: { from: daysBefore(12), to: NOW.toISOString() },
      capDays: 12,
      clamped: true,
    });
    expect(notice).toMatch(/limited to 12 days/);
    expect(notice).not.toMatch(/5 days/);
  });

  it("explains a refusal that reaches the card, naming the limit", () => {
    expect(capRefusalNotice(capRefusal("window_too_wide"))).toMatch(
      /limited to 5 days\. Pick a shorter range/,
    );
  });

  // A 500 must stay an error rather than being dressed up as a window problem.
  it("declines to explain an error that is not a cap refusal", () => {
    expect(capRefusalNotice(new ApiError("boom", 500, null))).toBeNull();
    expect(capRefusalNotice(undefined)).toBeNull();
  });
});

describe("fetchByProjectWithinCap", () => {
  it("passes a within-cap selection straight through, unclamped", async () => {
    byProject.mockResolvedValue([]);
    const result = await fetchByProjectWithinCap("c1", daysBefore(2), NOW.toISOString(), NOW);

    expect(byProject).toHaveBeenCalledTimes(1);
    expect(byProject).toHaveBeenCalledWith("c1", daysBefore(2), NOW.toISOString());
    expect(result.clamped).toBe(false);
    expect(result.capDays).toBeNull();
  });

  // The discovery handshake: one refused probe teaches the UI the cap, and the
  // retry is the request that actually answers.
  it("learns the cap from a refusal and retries clamped", async () => {
    byProject
      .mockRejectedValueOnce(capRefusal("window_too_wide"))
      .mockResolvedValueOnce([]);

    const result = await fetchByProjectWithinCap("c1", daysBefore(30), NOW.toISOString(), NOW);

    expect(byProject).toHaveBeenNthCalledWith(1, "c1", daysBefore(30), NOW.toISOString());
    expect(byProject).toHaveBeenNthCalledWith(2, "c1", daysBefore(5), NOW.toISOString());
    expect(result.clamped).toBe(true);
    expect(result.capDays).toBe(5);
    expect(result.window.from).toBe(daysBefore(5));
  });

  it("learns the cap from an unbounded refusal", async () => {
    byProject
      .mockRejectedValueOnce(capRefusal("window_unbounded"))
      .mockResolvedValueOnce([]);

    const result = await fetchByProjectWithinCap("c1", "", "", NOW);

    expect(byProject).toHaveBeenNthCalledWith(1, "c1", undefined, undefined);
    expect(byProject).toHaveBeenNthCalledWith(2, "c1", daysBefore(5), NOW.toISOString());
    expect(result.clamped).toBe(true);
  });

  // The probe is cheap but not free, and `by-project` refetches on a timer --
  // paying it once per tab rather than once per tick is the difference.
  it("clamps up front on a later call, without probing again", async () => {
    byProject
      .mockRejectedValueOnce(capRefusal("window_too_wide"))
      .mockResolvedValue([]);
    await fetchByProjectWithinCap("c1", daysBefore(30), NOW.toISOString(), NOW);
    expect(getRememberedCapDays()).toBe(5);

    byProject.mockClear();
    const result = await fetchByProjectWithinCap("c1", daysBefore(30), NOW.toISOString(), NOW);

    expect(byProject).toHaveBeenCalledTimes(1);
    expect(byProject).toHaveBeenCalledWith("c1", daysBefore(5), NOW.toISOString());
    expect(result.clamped).toBe(true);
  });

  // If the server constant is retuned DOWN, the remembered cap is stale and the
  // clamped request is refused in turn. One retry is the bound -- re-learning
  // without one would loop against a server that refuses everything.
  it("surfaces a refusal of the already-clamped window instead of looping", async () => {
    byProject.mockRejectedValue(capRefusal("window_too_wide", 5));

    await expect(
      fetchByProjectWithinCap("c1", daysBefore(30), NOW.toISOString(), NOW),
    ).rejects.toThrow(/the maximum is/);
    expect(byProject).toHaveBeenCalledTimes(2);
  });

  // A refused window is the one failure this handles. Everything else has to
  // keep reaching the card as an error.
  it("propagates a non-cap error without retrying", async () => {
    byProject.mockRejectedValue(new ApiError("boom", 500, null));

    await expect(
      fetchByProjectWithinCap("c1", daysBefore(30), NOW.toISOString(), NOW),
    ).rejects.toThrow("boom");
    expect(byProject).toHaveBeenCalledTimes(1);
    expect(getRememberedCapDays()).toBeNull();
  });
});
