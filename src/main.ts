import { debug, info, setFailed } from '@actions/core';
import { env } from 'process';
import { OctokitGitHub } from './github';
import { parseInput, type Input } from './input';
import { Waiter, type Wait, type WaiterGitHubClient } from './wait';
import { findWorkflowId, type Workflow } from './workflow';
import fs from 'fs';
import * as core from '@actions/core';
import axios, { isAxiosError } from 'axios';

export interface ActionGitHubClient extends WaiterGitHubClient {
  workflows(owner: string, repo: string): Promise<Workflow[]>;
}

export type GitHubClientFactory = (githubToken: string, retries: number) => ActionGitHubClient;
export type WaiterFactory = (workflowId: number, github: WaiterGitHubClient, input: Input) => Wait;

const createGitHubClient: GitHubClientFactory = (githubToken, retries) =>
  new OctokitGitHub(githubToken, retries);
const createWaiter: WaiterFactory = (workflowId, github, input) =>
  new Waiter(workflowId, github, input, info, debug);
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* v8 ignore start */
async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'softprops/turnstyle';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}
/* v8 ignore end */

export async function run(
  environment: Record<string, string | undefined> = env,
  githubFactory: GitHubClientFactory = createGitHubClient,
  waiterFactory: WaiterFactory = createWaiter,
) {
  try {
    await validateSubscription();
    const input = parseInput(environment);
    debug(
      `Parsed inputs (w/o token): ${(({ githubToken, ...inputs }) => JSON.stringify(inputs))(
        input,
      )}`,
    );
    const github = githubFactory(input.githubToken, input.retries);
    debug(`Fetching workflows for ${input.owner}/${input.repo}...`);
    const workflows = await github.workflows(input.owner, input.repo);
    debug(`Found ${workflows.length} workflows in ${input.owner}/${input.repo}`);
    const workflowId = findWorkflowId(workflows, input);
    if (workflowId !== undefined) {
      await waiterFactory(workflowId, github, input).wait();
    } else {
      setFailed(
        `No workflow found matching workflow path or name: ${input.workflowPath || input.workflowName}`,
      );
    }
  } catch (error: unknown) {
    setFailed(errorMessage(error));
  }
}

if (require.main === module) {
  run();
}
