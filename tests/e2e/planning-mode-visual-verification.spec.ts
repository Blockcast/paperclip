import { expect, test, type APIResponse, type Page } from "@playwright/test";

const TASK_TITLE = "Hire your first engineer and create a hiring plan";

test.setTimeout(240_000);

async function expectApiOk(response: APIResponse, label: string) {
  if (response.ok()) return;
  throw new Error(`${label} failed with ${response.status()}: ${await response.text()}`);
}

async function seedPlanningModeIssue(page: Page, companyName: string) {
  const companyRes = await page.request.post("/api/companies", {
    data: { name: companyName },
  });
  await expectApiOk(companyRes, "POST /api/companies");
  const company = await companyRes.json();

  const goalRes = await page.request.post(`/api/companies/${company.id}/goals`, {
    data: {
      title: "Capture planning mode visual evidence",
      description: "Seeded by the planning mode visual verification e2e test.",
      level: "company",
      status: "active",
    },
  });
  await expectApiOk(goalRes, "POST /api/companies/:companyId/goals");
  const goal = await goalRes.json();

  const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
    data: {
      title: TASK_TITLE,
      description: "Seeded by the planning mode visual verification e2e test.",
      goalId: goal.id,
      status: "todo",
      workMode: "standard",
      allowDuplicate: true,
    },
  });
  await expectApiOk(issueRes, "POST /api/companies/:companyId/issues");
  const issue = await issueRes.json();

  return { company, issue };
}

test("captures planning mode UI for desktop and mobile", async ({ page }) => {
  const timestamp = Date.now();
  const companyName = `PAP-3413-${timestamp}`;
  const screenshotDir = "test-results/planning-mode";
  // This spec captures the CLASSIC (flag-off) issue detail + composer; pin the
  // experimental flag off in case an earlier spec on this shared instance
  // turned it on (the NUX specs do).
  const flagRes = await page.request.patch("/api/instance/settings/experimental", {
    data: { enableConferenceRoomChat: false },
  });
  expect(flagRes.ok()).toBe(true);

  const { company, issue } = await seedPlanningModeIssue(page, companyName);
  const issueIdentifier = issue.identifier ?? issue.id;
  const issuePath = `/${company.issuePrefix ?? company.id}/issues/${issueIdentifier}`;
  const companyPrefix = company.issuePrefix ?? company.id;
  const issueLinkSelector = `a[href$="/issues/${issueIdentifier}"]`;

  const setMode = async (mode: "standard" | "planning") => {
    const patchRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { workMode: mode },
    });
    expect(patchRes.ok()).toBe(true);
    await expect
      .poll(async () => {
        const currentRes = await page.request.get(`/api/issues/${issue.id}`);
        expect(currentRes.ok()).toBe(true);
        const current = await currentRes.json();
        return current.workMode;
      }, { timeout: 10_000 })
      .toBe(mode);
  };

  const toggleComposerWorkMode = async () => {
    await page.getByTestId("issue-chat-composer-work-mode-toggle").click();
    await page.getByTestId("issue-chat-composer-work-mode-menu-standard").click();
  };

  await setMode("planning");

  await page.goto(issuePath);
  await expect(page.getByText("Plan mode").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "planning");
  const desktopPlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(desktopPlanningToggle).toBeVisible();
  await expect(desktopPlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");

  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  await expect(page.locator(issueLinkSelector)).not.toContainText("Plan mode");
  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-row-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(issuePath);
  await toggleComposerWorkMode();
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "standard");
  const standardWorkModeToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  if (await standardWorkModeToggle.isVisible()) {
    await expect(standardWorkModeToggle).toHaveAttribute("data-pending-work-mode", "standard");
  } else {
    await expect(standardWorkModeToggle).toBeHidden();
  }
  await page.screenshot({
    path: `${screenshotDir}/desktop-standard-toggle-${timestamp}.png`,
    fullPage: true,
  });

  await setMode("planning");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(issuePath);
  await expect(page.getByText("Plan mode").first()).toBeVisible();
  const mobilePlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(mobilePlanningToggle).toBeVisible();
  await expect(mobilePlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  await expect(page.locator(issueLinkSelector)).not.toContainText("Plan mode");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-row-${timestamp}.png`,
    fullPage: true,
  });
});
