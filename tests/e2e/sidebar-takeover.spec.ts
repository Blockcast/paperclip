import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

/**
 * E2E: Sidebar takeover model (PAP-10695).
 *
 * Takeover routes (company settings, plugin `routeSidebar`) no longer *replace*
 * the main app sidebar. Instead the host collapses the app `<Sidebar/>` to its
 * 64px rail (still peek-able) and renders the contextual sidebar in a second
 * pane → `[ app rail ][ secondary ~240px ][ content ]`.
 *
 * These specs assert the rail + secondary pane coexist on a company settings
 * route, and that an explicit user pin (expanded) wins over the route-driven
 * collapse (pin precedence).
 *
 * The plugin `routeSidebar` half of this behavior shares the exact same Layout
 * code path (one `secondarySidebar`/`hasSecondarySidebar` resolver drives both
 * company-settings and plugin routes) and is covered by the unit tests in
 * `ui/src/components/Layout.test.tsx`. A live plugin-route e2e requires the
 * `plugin-llm-wiki` plugin to be installed in the throwaway e2e instance, which
 * is out of scope for this default local_trusted run; visual QA of both panes
 * is delegated to the QA child issue.
 */

const FALLBACK_PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const FALLBACK_BASE_URL = `http://127.0.0.1:${FALLBACK_PORT}`;
const COMPANY_NAME_PREFIX = "E2E-SidebarTakeover";
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";

// The sidebar header's "Open search" control only renders when the app sidebar
// is expanded (pinned or peeking); in the collapsed rail it is hidden to fit
// the 64px width. Its presence/absence is therefore a stable proxy for the
// app sidebar's collapsed state (see Sidebar.tsx).
const APP_SIDEBAR_EXPANDED_MARKER = "Open search";

// `page.goto` resolves on the document `load` event, but the board is a
// client-rendered SPA: React mounts and paints *after* that. Every assertion in
// this file reads `Layout`'s output, and `Layout` emits `#main-content` and
// `[data-secondary-sidebar]` in the same render commit — `hasSecondarySidebar`
// is derived synchronously from `location.pathname`, with no data dependency —
// so the secondary pane can never lag the app shell. A missing pane therefore
// always means "the app has not rendered yet", never "the takeover model broke".
//
// Charging that cold-boot latency to the default 5s `expect` budget is what made
// this file flaky (BLO-33478): on a loaded CI runner, first render after `load`
// routinely exceeds 5s. Measured on run 35566266808, this spec's tests took
// 9-17s each where the same tests take 2-3s on an unloaded runner. Waiting for
// the shell here absorbs boot latency in a precondition with a generous budget
// and leaves the behavioral assertions on the default 5s, so a genuine takeover
// regression still fails fast instead of hiding behind a lengthened wait.
//
// It also closes a false *positive*: `expect(secondary).toHaveCount(0)` after
// navigating off a takeover route is satisfied by a blank page, so without this
// gate those assertions could pass while the app had rendered nothing at all.
const APP_SHELL_READY_TIMEOUT = 30_000;

async function gotoAppRoute(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("#main-content")).toBeAttached({
    timeout: APP_SHELL_READY_TIMEOUT,
  });
}

async function createCompany(board: APIRequestContext): Promise<{ id: string; prefix: string }> {
  const healthRes = await board.get("/api/health");
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  expect(health.deploymentMode).toBe("local_trusted");

  const companyRes = await board.post("/api/companies", {
    data: { name: `${COMPANY_NAME_PREFIX}-${Date.now()}` },
  });
  if (!companyRes.ok()) {
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`);
  }
  const company = await companyRes.json();
  return {
    id: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

test.describe("Sidebar takeover (collapse + secondary pane)", () => {
  // Last spec in this suite still on the bare 60s default. It is normally far
  // inside that budget -- 96 observations across 24 post-#1880 runs peaked at
  // 9.8s -- but under load it has blown the cap outright: on run 34745075160
  // ":151" failed both attempts on a bare 60s timeout and ":102" went flaky on
  // the same cap, in the same job. Take the ceiling its five siblings already
  // take so a slow runner costs wall-time instead of a red merge gate
  // (BLO-33320).
  test.setTimeout(180_000);

  let board: APIRequestContext;
  let baseUrl: string;
  let companyId: string;
  let prefix: string;

  test.beforeAll(async ({ baseURL }) => {
    baseUrl = baseURL ?? FALLBACK_BASE_URL;
    board = await pwRequest.newContext({ baseURL: baseUrl });
    const company = await createCompany(board);
    companyId = company.id;
    prefix = company.prefix;
  });

  test.afterAll(async () => {
    await board.delete(`/api/companies/${companyId}`).catch(() => {});
    await board.dispose();
  });

  test.beforeEach(async ({ page }) => {
    // Start each test from a clean (unpinned) sidebar state so the route-driven
    // collapse is the only thing acting on it.
    await page.addInitScript((key) => {
      window.localStorage.removeItem(key);
    }, COLLAPSED_STORAGE_KEY);
  });

  test("collapses the app sidebar to its rail and shows the settings sidebar beside it", async ({ page }) => {
    await gotoAppRoute(page, `${baseUrl}/${prefix}/company/settings`);

    // The contextual (secondary) pane is present...
    const secondary = page.locator("[data-secondary-sidebar]");
    await expect(secondary).toBeVisible();
    await expect(secondary).toHaveCount(1);

    // ...and it is ~240px wide (w-60), distinct from the 64px app rail.
    const secondaryBox = await secondary.boundingBox();
    expect(secondaryBox).not.toBeNull();
    expect(secondaryBox!.width).toBeGreaterThan(180);

    // The app sidebar is NOT replaced — its company nav still renders...
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

    // ...but it is collapsed to its rail: the expanded-only "Open search"
    // header control is hidden.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);
  });

  test("renders the secondary pane nav labels at full width despite the app rail collapse", async ({ page }) => {
    // Regression (PAP-10700): the secondary pane is 240px wide, but its
    // SidebarNavItem children read the *global* collapsed state and used to
    // render icon-only (label `w-0 text-transparent`), making the settings nav
    // unreadable in the default takeover state. The pane must force full labels.
    await gotoAppRoute(page, `${baseUrl}/${prefix}/company/settings`);

    const secondary = page.locator("[data-secondary-sidebar]");
    await expect(secondary).toBeVisible();

    // App sidebar is collapsed to its rail (default unpinned takeover state)...
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    // ...yet a settings nav label renders at its full text width, not clipped to
    // zero. "Environments" is unique to the company-settings nav.
    const envLabel = secondary.getByText("Environments", { exact: true });
    await expect(envLabel).toBeVisible();
    const labelBox = await envLabel.boundingBox();
    expect(labelBox).not.toBeNull();
    expect(labelBox!.width).toBeGreaterThan(20);
  });

  test("settings force-collapse overrides an expanded pin without mutating it", async ({ page }) => {
    // User has pinned the sidebar expanded ("0"). Company settings is a hard
    // secondary-sidebar takeover route, so forceCollapsed wins while the route is
    // active (force > pin > route request > default) but must not mutate the pin.
    await page.addInitScript(
      ({ key }) => {
        window.localStorage.setItem(key, "0");
      },
      { key: COLLAPSED_STORAGE_KEY },
    );

    await gotoAppRoute(page, `${baseUrl}/${prefix}/company/settings`);

    // Secondary pane still shows on the takeover route.
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();

    // The app sidebar is hard-collapsed despite the stored expanded pin.
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    await gotoAppRoute(page, `${baseUrl}/${prefix}/dashboard`);

    // Leaving the takeover route clears the force and restores the user's
    // persisted expanded pin.
    await expect(page.locator("[data-secondary-sidebar]")).toHaveCount(0);
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });

  test("leaving the takeover route removes the secondary pane and restores the sidebar", async ({ page }) => {
    await gotoAppRoute(page, `${baseUrl}/${prefix}/company/settings`);
    await expect(page.locator("[data-secondary-sidebar]")).toBeVisible();
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toHaveCount(0);

    // Navigate to a plain (non-takeover) route.
    await gotoAppRoute(page, `${baseUrl}/${prefix}/dashboard`);

    // No secondary pane, and the app sidebar is no longer force-collapsed.
    await expect(page.locator("[data-secondary-sidebar]")).toHaveCount(0);
    await expect(page.getByLabel(APP_SIDEBAR_EXPANDED_MARKER)).toBeVisible();
  });
});
