import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { REDACTED_SENTINEL, deriveProjectUrlKey } from "@paperclipai/shared";

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

/**
 * The fixture VALUES have to dodge the same gate, and for a separate reason the key choice above
 * does not cover: `isSensitiveEnv` is `isSensitiveEnvKey(name) || isPlausiblySensitiveEnvValue(value)`
 * (`packages/shared/src/sensitive-env.ts:54-57`), so a harmless key with a credential-SHAPED value
 * still trips it.
 *
 * `isPlausiblySensitiveEnvValue` returns true at >= 24 chars with no whitespace, a
 * `[A-Za-z0-9+/=_\-.]` charset and >= 2 character classes. Every value this spec writes goes
 * through `fixtureValue` below, which stays under that 24-char floor — killing the branch
 * structurally rather than relying on what a given nonce happens to contain.
 *
 * Getting it wrong would be a once-a-year failure of the worst kind. It only bites when
 * `PAPERCLIP_SECRETS_STRICT_MODE=true` (`server/src/routes/projects.ts:64`), which this suite does
 * not set — but `playwright.config.ts:114` spreads `...process.env`, so an inherited var flips it,
 * and a length-based trip would additionally be nondeterministic (an all-letters nonce is one
 * character class and passes). Under the floor, neither input can reach the branch.
 */
const MAX_NONSENSITIVE_VALUE_LENGTH = 24;

/**
 * The single constructor for every env value this spec writes, so the floor above is enforced
 * rather than merely documented: a later edit that lengthens a prefix fails here, loudly and
 * deterministically, instead of arming a strict-mode 422 that only reproduces under an inherited
 * env var.
 */
function fixtureValue(prefix: string): string {
  const value = `${prefix}-${Date.now().toString(36)}`;
  expect(
    value.length,
    `fixture value ${JSON.stringify(value)} must stay under the isPlausiblySensitiveEnvValue floor`,
  ).toBeLessThan(MAX_NONSENSITIVE_VALUE_LENGTH);
  return value;
}

/**
 * Tracked at module scope so `test.afterAll` can reach it even when the test fails partway: the
 * suite runs `workers: 1` against one shared throwaway instance, so a leaked company persists into
 * every later spec's company list. Set as soon as the company exists, before any assertion that
 * could throw and skip the cleanup.
 */
let seededCompanyId: string | undefined;

test.afterAll(async ({ request }) => {
  if (!seededCompanyId) return;
  // Best-effort, matching the established idiom (`applications-crud.spec.ts:113`,
  // `sidebar-takeover.spec.ts:69`): a cleanup failure must not turn a passing run red.
  await request.delete(`/api/companies/${seededCompanyId}`).catch(() => undefined);
});

type Seed = {
  projectId: string;
  /**
   * The route ref the app considers CANONICAL for this project. Navigating by anything else —
   * `projectId`, notably — makes `ProjectDetail` redirect, and that redirect destroys the page
   * mid-test. See the comment on the `page.goto` below.
   */
  projectRef: string;
  prefix: string;
  keepValue: string;
  editValue: string;
};

async function seedProject(request: APIRequestContext): Promise<Seed> {
  const nonce = `${Date.now().toString(36)}`;
  const keepValue = fixtureValue("keep");
  const editValue = fixtureValue("edit");

  const companyRes = await request.post("/api/companies", {
    data: { name: `pen3033 env round trip ${nonce}` },
  });
  expect(
    companyRes.ok(),
    `create company failed ${companyRes.status()}: ${await companyRes.text()}`,
  ).toBe(true);
  const company = await companyRes.json();
  seededCompanyId = company.id;

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
    // Mirrors `projectRouteRef` (`ui/src/lib/utils.ts:227`), whose non-ASCII fallback branch
    // cannot fire here — the seeded name is ASCII by construction a few lines up.
    projectRef: created.urlKey ?? deriveProjectUrlKey(created.name, created.id),
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
 *
 * Auto-waiting rather than snapshotting, which is load-bearing: a one-shot `names.count()` reads a
 * single instant, and this editor's ancestors legitimately re-render underneath it (a save echo, a
 * refetch settling). When the container is momentarily absent the scoped locator resolves to zero
 * rows and a snapshot read fails outright instead of waiting the render out — BLO-36601, where
 * this threw `rows present: []` 40ms after a `toHaveCount(2)` four lines earlier had passed.
 *
 * `rows present: []` there did NOT mean the editor had blanked its rows — it was UNMOUNTED, by the
 * route redirect described on the `page.goto` below. That is established from `ProjectDetail`'s own
 * control flow, not from the trace: a query-key change makes `data` `undefined`, so `:716` returns
 * `<PageSkeleton>` and never reaches this editor. The editor's `value`-adoption effect
 * (`environment-variables-editor/index.tsx`) therefore cannot have run with an empty value, because
 * the component was not mounted to receive one.
 *
 * Do NOT try to re-confirm that from the trace's frame snapshots. They are INCREMENTAL — run
 * 36187220561 carries one full 69KB snapshot and then 463-3574 byte diffs — so a missing
 * `@container/env` node in a later snapshot means "this diff did not touch that subtree", not "the
 * node was removed". Reading those diffs as state shows the container flickering in and out, which
 * is an artifact of the format.
 *
 * Polling on the row list also puts the rows actually seen into the failure message, so if a
 * genuine blanking ever does occur it reports the populated-then-emptied container distinctly
 * instead of collapsing to `[]` as an unmount does.
 */
async function valueInputFor(page: Page, editor: Locator, key: string): Promise<Locator> {
  const names = editor.getByLabel("Variable name");
  let seen: string[] = [];
  await expect
    .poll(
      async () => {
        seen = await names.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
        return seen;
      },
      { message: `env editor never showed a row named ${key}` },
    )
    .toContain(key);
  return editor.getByLabel("Variable value").nth(seen.indexOf(key));
}

test("project env: editing one binding in the UI saves without 422 and leaves the others intact", async ({
  page,
  request,
}) => {
  // Two full navigations (`page.goto` + `page.reload`), four API round trips and two form saves.
  // The config default is 60s (`playwright.config.ts:66`), but the same file records 12-41s PER
  // navigation under Vite dev middleware — still the supported local path when `ui/dist` is absent,
  // since the throw at `:40` is CI-only. Two navigations at the upper end exhaust the default before
  // a single assertion runs. Matches `signoff-policy.spec.ts:285`, the closest comparable spec (also
  // two navigations).
  test.setTimeout(120_000);

  const seed = await seedProject(request);

  // Exit 2 of 3 — `GET /projects/:id`.
  const getRes = await request.get(`/api/projects/${seed.projectId}`);
  expect(getRes.ok(), `get project failed ${getRes.status()}`).toBe(true);
  const fetched = await getRes.json();
  expectMaskedBoth(fetched.env, "get response");

  // `projectRef`, NOT `projectId`. `ProjectDetail` keys its project query on the ROUTE ref
  // (`ui/src/pages/ProjectDetail.tsx:401`) and canonicalises a non-slug ref with a
  // `navigate(..., { replace: true })` (`:547`). Arriving by UUID therefore renders the whole page,
  // then swaps the route ref under it — which changes the query key, so `data` is `undefined`,
  // `isLoading` is true, and `:716` returns `<PageSkeleton>`. Everything mounted before the
  // redirect, this editor included, is destroyed and rebuilt. That teardown is the generator
  // behind BLO-36601. Measured in run 36187220561's trace network log — the project detail is
  // fetched FOUR times under THREE distinct query keys:
  //   21:14:08.166  <uuid>                     <- fires before the company resolves, see below
  //   21:14:09.913  <uuid>                     <- same key, refetch
  //   21:14:10.005  <uuid>?companyId=…         <- key changes, `lookupCompanyId` resolved
  //   21:14:10.634  env-round-trip-…?companyId <- key changes again, THE REDIRECT
  // The fourth is the one that unmounts the page mid-assertion.
  //
  // Arriving on the canonical ref means `:537`'s `routeProjectRef === canonicalProjectRef` guard
  // returns early, so no redirect fires. It also holds `canFetchProject` (`:392`) false until the
  // company resolves — the `isUuidLike(routeProjectRef)` disjunct is what lets the UUID form fetch
  // early and produce the extra keys above — so the query runs once, under one key, and the editor
  // mounts once.
  await page.goto(`/${seed.prefix}/projects/${seed.projectRef}/configuration`);

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
  const first = await editAndSave(fixtureValue("edited-once"));
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
  const second = await editAndSave(fixtureValue("edited-twice"));
  expect(
    second.status,
    `second save must not 422 — a 422 here means the first save persisted the placeholder into the untouched binding: ${second.body}`,
  ).toBe(200);

  const afterSecond = await request.get(`/api/projects/${seed.projectId}`);
  const afterSecondBody = await afterSecond.json();
  expect(Object.keys(afterSecondBody.env).sort()).toEqual([EDIT_KEY, KEEP_KEY].sort());
  expectMaskedBoth(afterSecondBody.env, "after second save");
});
