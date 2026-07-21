import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL =
  process.env.PAPERCLIP_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@paperclip.local";
const ADMIN_PASSWORD =
  process.env.PAPERCLIP_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "paperclip-smoke-password";

const COMPANY_NAME = `Release-Smoke-${Date.now()}`;
const AGENT_NAME = "CEO";
const MISSION = "Verify the published Docker package completes authenticated onboarding.";
const TASK_TITLE = "Hire your first engineer and create a hiring plan";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);

  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function openOnboarding(page: Page) {
  await page.goto("/onboarding");
  const wizardHeading = page.locator("h3", { hasText: "Name your company" });
  const startButton = page.getByRole("button", {
    name: /Start Onboarding|New Company|Add Agent/,
  });
  const createButton = page.getByRole("button", { name: /Build a new company/ });

  await expect(wizardHeading.or(startButton).or(createButton)).toBeVisible({ timeout: 20_000 });

  if (await startButton.isVisible()) {
    await startButton.click();
  }
  if (await createButton.isVisible()) {
    await createButton.click();
  }

  await expect(wizardHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and triggers the first CEO run", async ({
    page,
  }) => {
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );
    await page.route("**/agent-hires", async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as {
        name: string;
        role: string;
        runtimeConfig?: Record<string, unknown>;
      };
      await route.continue({
        postData: JSON.stringify({
          name: body.name,
          role: body.role,
          adapterType: "http",
          adapterConfig: { url: "http://127.0.0.1:1/release-smoke" },
          runtimeConfig: body.runtimeConfig,
        }),
      });
    });

    await signIn(page);
    await openOnboarding(page);

    await page.locator('input[placeholder="Acme Corp"]').fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("heading", { name: "Define your mission" })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByPlaceholder("What is your team trying to achieve?").fill(MISSION);
    await page.getByRole("button", { name: /Confirm mission/ }).click();

    await expect(page.getByRole("heading", { name: "Create your team lead" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByPlaceholder("Chief of staff").fill(AGENT_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /Give it a heartbeat/ }).click();

    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(MISSION)).toBeVisible();

    await page.getByRole("button", { name: /Get started/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const baseUrl = new URL(page.url()).origin;

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{ id: string; name: string }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = (await agentsRes.json()) as Array<{
      id: string;
      name: string;
      role: string;
      adapterType: string;
    }>;
    const ceoAgent = agents.find((entry) => entry.name === AGENT_NAME);
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent!.role).toBe("ceo");
    expect(ceoAgent!.adapterType).toBe("http");

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = (await issuesRes.json()) as Array<{
      id: string;
      title: string;
      assigneeAgentId: string | null;
    }>;
    const issue = issues.find((entry) => entry.title === TASK_TITLE);
    expect(issue).toBeTruthy();
    expect(issue!.assigneeAgentId).toBe(ceoAgent!.id);

    await expect.poll(
      async () => {
        const runsRes = await page.request.get(
          `${baseUrl}/api/companies/${company!.id}/heartbeat-runs?agentId=${ceoAgent!.id}`
        );
        expect(runsRes.ok()).toBe(true);
        const runs = (await runsRes.json()) as Array<{
          agentId: string;
          invocationSource: string;
          status: string;
        }>;
        const latestRun = runs.find((entry) => entry.agentId === ceoAgent!.id);
        return latestRun
          ? {
              invocationSource: latestRun.invocationSource,
              status: latestRun.status,
            }
          : null;
      },
      {
        timeout: 30_000,
        intervals: [1_000, 2_000, 5_000],
      }
    ).toEqual(
      expect.objectContaining({
        invocationSource: "assignment",
        status: expect.stringMatching(/^(queued|running|succeeded|failed)$/),
      })
    );
  });
});
