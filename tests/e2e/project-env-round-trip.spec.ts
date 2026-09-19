import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { REDACTED_SENTINEL } from "@paperclipai/shared";

/**
 * PEN-3033 — the project `env` read-mask + write-merge round trip, driven in the running app.
 *
 * The fix has two halves that only make sense together, and until this spec each half was proven
 * only at the seam of a mock:
 *
 * - `server/src/__tests__/project-env-response-boundary.test.ts` asserts the merge (an untouched
 *   masked row keeps its stored value) against a mocked `secretService`/`projectService` with no
 *   database at all.
 * - `ui/src/components/environment-variables-editor/EnvironmentVariablesEditor.test.tsx` asserts
 *   the payload the editor emits, with no network at all.
 *
 * So the one thing nothing covered is the span between them: that the payload the REAL editor puts
 * on the wire — travelling `ProjectProperties` → `ProjectDetail.updateProjectField` →
 * `projectsApi.update` → `api.patch` → `fetch` → route → `restoreMaskedEnvBindings` →
 * `normalizeEnvBindingsForPersistence` → Postgres — is the payload the boundary test hand-builds,
 * and that the real normalizer accepts it. That span is what this spec exercises, against the
 * throwaway instance with embedded PostgreSQL that `playwright.config.ts` boots.
 *
 * ## What this spec can and cannot observe, stated rather than implied
 *
 * The mask is deliberately unconditional and not entitlement-gated (see the header of
 * `server/src/routes/project-env-response.ts`), so there is no HTTP surface anywhere that returns a
 * stored plain value — that is the whole point of the fix. A direct "the stored value is still
 * `keep-me-…`" read would therefore have to bypass the server and open the embedded cluster
 * directly, which this suite cannot do soundly: `playwright.config.ts` derives `PAPERCLIP_HOME`
 * from `fs.mkdtempSync` at config-module scope, and a worker process re-evaluating that module
 * computes a DIFFERENT temp dir than the one the server was handed. Making it knowable means
 * changing shared config that all ~40 specs boot from.
 *
 * So the untouched binding's survival is established by mechanism instead, and the mechanism is
 * exact rather than circumstantial — see `savesAgain` at the end of the test.
 */

const SENTINEL = REDACTED_SENTINEL;

// Neither key matches `SENSITIVE_ENV_KEY_RE` (`packages/shared/src/sensitive-env.ts`). That is
// deliberate: a sensitive-looking key flips the value input to `type="password"` and renders the
// "store as a secret" affordance, which is a different editor path than the one under test here.
const KEEP_KEY = "PEN3033_KEEP";
const EDIT_KEY = "PEN3033_EDIT";

type Seed = {
  projectId: string;
  prefix: string;
  keepValue: string;
  editValue: string;
};

async function seedProject(request: APIRequestContext): Promise<Seed> {
  const nonce = `${Date.now().toString(36)}`;
  const keepValue = `keep-me-untouched-${nonce}`;
  const editValue = `original-${nonce}`;

  const companyRes = await request.post("/api/companies", {
    data: { name: `pen3033 env round trip ${nonce}` },
  });
  expect(
    companyRes.ok(),
    `create company failed ${companyRes.status()}: ${await companyRes.text()}`,
  ).toBe(true);
  const company = await companyRes.json();

  const projectRes = await request.post(`/api/companies/${company.id}/projects`, {
    data: {
      name: `env round trip ${nonce}`,
      env: {
        [KEEP_KEY]: { type: "plain", value: keepValue },
        [EDIT_KEY]: { type: "plain", value: editValue },
      },
    },
  });
  expect(
    projectRes.status(),
    `create project failed: ${await projectRes.text()}`,
  ).toBe(201);
  const created = await projectRes.json();

  // Exit 1 of 3 — `POST /companies/:companyId/projects`. Asserted on the create response itself,
  // not re-read, because this exit answers with its own projection.
  expectMaskedBoth(created.env, "create response");
  // The negative half matters more than the positive one: a mask that emitted the sentinel while
  // ALSO leaving the real value somewhere in the body would satisfy the assertion above.
  expect(JSON.stringify(created)).not.toContain(keepValue);
  expect(JSON.stringify(created)).not.toContain(editValue);

  return {
    projectId: created.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
    keepValue,
    editValue,
  };
}

function expectMaskedBoth(env: unknown, where: string) {
  expect(env, `${where}: env missing`).toBeTruthy();
  const bindings = env as Record<string, { type?: string; value?: string }>;
  for (const key of [KEEP_KEY, EDIT_KEY]) {
    expect(bindings[key], `${where}: ${key} missing`).toBeTruthy();
    expect(bindings[key], `${where}: ${key} not masked`).toMatchObject({
      type: "plain",
      value: SENTINEL,
    });
  }
}

/**
 * Resolves a row's value input by first asserting the name input beside it, so a change in row
 * ordering fails loudly here instead of silently editing the wrong row further down.
 */
async function valueInputFor(page: Page, editor: Locator, key: string): Promise<Locator> {
  const names = editor.getByLabel("Variable name");
  const count = await names.count();
  for (let i = 0; i < count; i += 1) {
    if ((await names.nth(i).inputValue()) === key) {
      return editor.getByLabel("Variable value").nth(i);
    }
  }
  const seen: string[] = [];
  for (let i = 0; i < count; i += 1) seen.push(await names.nth(i).inputValue());
  throw new Error(`no env row named ${key}; rows present: ${JSON.stringify(seen)}`);
}

test("project env: editing one binding in the UI saves without 422 and leaves the others intact", async ({
  page,
  request,
}) => {
  const seed = await seedProject(request);

  // Exit 2 of 3 — `GET /projects/:id`.
  const getRes = await request.get(`/api/projects/${seed.projectId}`);
  expect(getRes.ok(), `get project failed ${getRes.status()}`).toBe(true);
  const fetched = await getRes.json();
  expectMaskedBoth(fetched.env, "get response");

  await page.goto(`/${seed.prefix}/projects/${seed.projectId}/configuration`);

  const editor = page.locator('div[class*="container/env"]');
  await expect(editor).toHaveCount(1);
  await expect(editor.getByLabel("Variable name")).toHaveCount(2);
  // `valueInputFor` pairs a name input with the value input at the SAME index, which only holds
  // while every row is a text row (a secret_ref row renders no value input and would shift the
  // rest). Both fixture rows are plain, and this pins that precondition instead of assuming it.
  await expect(editor.getByLabel("Variable value")).toHaveCount(2);

  // The disclosure assertion, made where it actually matters: at the rendered app, on the value a
  // human sees. Both plain values must arrive masked — the editor holds the sentinel in
  // `textValue` on purpose so the save can re-emit it for the merge to match.
  const keepInput = await valueInputFor(page, editor, KEEP_KEY);
  const editInput = await valueInputFor(page, editor, EDIT_KEY);
  await expect(keepInput).toHaveValue(SENTINEL);
  await expect(editInput).toHaveValue(SENTINEL);
  // Secondary net only, and worth naming as such: React holds a controlled input's value as a DOM
  // property rather than an attribute, so a leaked value would NOT show up in serialized HTML. The
  // two `toHaveValue` assertions above are the load-bearing ones for the editor; this one catches a
  // plaintext that reached the page by some other route (a title, a tooltip, an embedded payload).
  expect(await page.content()).not.toContain(seed.keepValue);
  expect(await page.content()).not.toContain(seed.editValue);

  // Scoped to the editor: `ProjectProperties` renders a second, unrelated Save in the Codebase
  // section, and an unscoped role lookup would be ambiguous the moment the page grows a third.
  const save = editor.getByRole("button", { name: "Save" });

  async function editAndSave(nextValue: string): Promise<{ status: number; body: string }> {
    const input = await valueInputFor(page, editor, EDIT_KEY);
    await input.fill(nextValue);
    await expect(save).toHaveCount(1);
    await expect(save).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/api/projects/${seed.projectId}`) && res.request().method() === "PATCH",
      ),
      save.click(),
    ]);
    return { status: response.status(), body: await response.text() };
  }

  // The criterion. Before the write-merge half landed, this PATCH carried `***REDACTED***` for the
  // untouched KEEP row and `normalizeEnvConfig` refused the whole body — 422, every other edit in
  // the save lost with it.
  const first = await editAndSave(`edited-once-${Date.now().toString(36)}`);
  expect(first.status, `first save must not 422: ${first.body}`).toBe(200);

  // Exit 3 of 3 — `PATCH /projects/:id`, asserted on the body of the save the UI actually
  // performed rather than on a re-read, so this covers the exit itself.
  expectMaskedBoth(JSON.parse(first.body).env, "patch response");
  expect(first.body).not.toContain(seed.keepValue);

  // Nothing was dropped on the way through.
  const afterFirst = await request.get(`/api/projects/${seed.projectId}`);
  expect(afterFirst.ok()).toBe(true);
  const afterFirstBody = await afterFirst.json();
  expect(Object.keys(afterFirstBody.env).sort()).toEqual([EDIT_KEY, KEEP_KEY].sort());
  expectMaskedBoth(afterFirstBody.env, "after first save");

  // Reload rather than assert on the post-save editor state. The editor deliberately KEEPS the
  // value the user just typed once the save lands — it does not re-adopt the masked response and
  // blank out the field under them — so reading the live rows here would assert editor-local text,
  // not anything the server said. A reload rebuilds the rows from a fresh `GET`, which both gives
  // the second edit a clean starting point (no refetch can land mid-fill and discard it) and
  // asserts the thing that actually matters: the value just saved comes back masked.
  await page.reload();
  await expect(editor.getByLabel("Variable value")).toHaveCount(2);
  await expect(await valueInputFor(page, editor, KEEP_KEY)).toHaveValue(SENTINEL);
  await expect(await valueInputFor(page, editor, EDIT_KEY)).toHaveValue(SENTINEL);

  /**
   * `savesAgain` — this is what stands in for a direct read of the stored KEEP value, and it is a
   * proof by mechanism rather than a second helping of the same assertion.
   *
   * A second save re-emits `KEEP: { type: "plain", value: "***REDACTED***" }` exactly as the first
   * one did. `restoreMaskedEnvBindings` replaces that with whatever is STORED under `KEEP`, and
   * `normalizeEnvConfig` (`services/secrets.ts`) refuses to persist the sentinel. So if the first
   * save had written the literal placeholder into KEEP — the precise destructive outcome the
   * write-merge exists to prevent, and the one a read-mask alone would produce — the restore would
   * hand the sentinel straight back to the normalizer and THIS save would 422.
   *
   * It therefore discriminates the two outcomes a masked response cannot tell apart on its own:
   * KEEP holding its original value, versus KEEP holding `***REDACTED***`.
   */
  const second = await editAndSave(`edited-twice-${Date.now().toString(36)}`);
  expect(
    second.status,
    `second save must not 422 — a 422 here means the first save persisted the placeholder into the untouched binding: ${second.body}`,
  ).toBe(200);

  const afterSecond = await request.get(`/api/projects/${seed.projectId}`);
  const afterSecondBody = await afterSecond.json();
  expect(Object.keys(afterSecondBody.env).sort()).toEqual([EDIT_KEY, KEEP_KEY].sort());
  expectMaskedBoth(afterSecondBody.env, "after second save");
});
