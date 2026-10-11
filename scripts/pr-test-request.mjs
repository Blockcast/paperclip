import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MANUAL_TEST_CONTEXT = 'ci/manual-test-request';
export function trustedTestComment(event) {
  return Boolean(event.issue?.pull_request) && event.comment?.user?.type === 'User' &&
    event.comment.user.login !== 'allyblockcast' &&
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(event.comment.author_association) &&
    /^\s*\/test(?:\s|$)/m.test(event.comment.body ?? '');
}
export function manualTestAuthorized(statuses) {
  const latest = statuses.filter(status => status.context === MANUAL_TEST_CONTEXT && Number.isSafeInteger(status.id))
    .sort((a, b) => b.id - a.id)[0];
  return latest?.state === 'success' && latest.creator?.id === 41898282 && latest.creator?.login === 'github-actions[bot]' && latest.creator?.type === 'Bot';
}
export function api(endpoint, method = 'GET', body) {
  const result = JSON.parse(execFileSync('gh', ['api', endpoint, '--method', method, ...(method === 'GET' ? ['--paginate', '--slurp'] : []), ...(body ? ['--input', '-'] : [])], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN }, input: body ? JSON.stringify(body) : undefined,
  }));
  if (method !== 'GET') return result;
  if (result.length === 1) return result[0];
  if (!result.every(page => Array.isArray(page.statuses))) throw new Error('unexpected paginated response');
  return { ...result[0], statuses: result.flatMap(page => page.statuses) };
}
export function readManualTest(repository, head, get = api) {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('manual CI requires an exact lowercase head SHA');
  return manualTestAuthorized(get(`repos/${repository}/commits/${head}/status?per_page=100`).statuses ?? []);
}
export async function requestTest(event, repository, { get = api, post = (endpoint, body) => api(endpoint, 'POST', body) } = {}) {
  if (!trustedTestComment(event)) return { pr_number: '', head_sha: '', manual: 'false' };
  const number = String(event.issue.number);
  if (!/^[1-9][0-9]*$/.test(number)) throw new Error('invalid PR number');
  const endpoint = `repos/${repository}/pulls/${number}`;
  const pull = await get(endpoint);
  const head = pull.head?.sha;
  if (pull.state !== 'open' || !/^[0-9a-f]{40}$/.test(head ?? '') ||
      pull.head.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('closed, unreadable or cross-repository PR');
  const statuses = await get(`repos/${repository}/commits/${head}/status?per_page=100`);
  const live = await get(endpoint);
  if (live.state !== 'open' || live.head?.sha !== head || live.head.repo?.full_name?.toLowerCase() !== repository.toLowerCase())
    throw new Error('PR head moved before its manual test request');
  if (!manualTestAuthorized(statuses.statuses ?? [])) await post(`repos/${repository}/statuses/${head}`, {
    state: 'success', context: MANUAL_TEST_CONTEXT, target_url: event.comment.html_url,
    description: 'Trusted human /test at this exact PR head; CI permission only',
  });
  return { pr_number: number, head_sha: head, manual: 'true' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let outputs;
    if (process.argv[2] === 'check') outputs = { manual: String(readManualTest(process.env.GITHUB_REPOSITORY, process.env.HEAD_SHA)) };
    else if (process.argv[2] === 'request') outputs = await requestTest(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.GITHUB_REPOSITORY);
    else throw new Error('use request or check');
    for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
