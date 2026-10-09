import { debug, info, setFailed, setOutput } from '@actions/core';
import { env } from 'process';
import { ActionDeadline, DeadlineReached, handleDeadline } from './deadline';
import { OctokitGitHub, type GitHubRequestOptions } from './github';
import { parseInput, type Input } from './input';
import { Waiter, type Wait, type WaiterGitHubClient } from './wait';
import { findWorkflowId, type Workflow } from './workflow';
import fs from 'fs';
import * as core from '@actions/core';
import axios, { isAxiosError } from 'axios';

export interface ActionGitHubClient extends WaiterGitHubClient {
  workflows(
    owner: string,
    repo: string,
    requestOptions?: GitHubRequestOptions,
  ): Promise<Workflow[]>;
}

export type GitHubClientFactory = (githubToken: string, retries: number) => ActionGitHubClient;
export type WaiterFactory = (
  workflowId: number,
  github: WaiterGitHubClient,
  input: Input,
  deadline: ActionDeadline,
) => Wait;
export type DeadlineFactory = (input: Input) => ActionDeadline;

const createGitHubClient: GitHubClientFactory = (githubToken, retries) =>
  new OctokitGitHub(githubToken, retries);
const createWaiter: WaiterFactory = (workflowId, github, input, deadline) =>
  new Waiter(workflowId, github, input, info, debug, undefined, deadline);
const createDeadline: DeadlineFactory = (input) => ActionDeadline.fromInput(input);
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
  core.info('[1;36mStepSecurity Maintained Action[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('[32m✓ Free for public repositories[0m');
  core.info(`[36mLearn more:[0m ${docsUrl}`);
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
        `[1;31mThis action requires a StepSecurity subscription for private repositories.[0m`,
      );
      core.error(`[31mLearn how to enable a subscription: ${docsUrl}[0m`);
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
  deadlineFactory: DeadlineFactory = createDeadline,
) {
  let deadline: ActionDeadline | undefined;
  try {
    await validateSubscription();
    const input = parseInput(environment);
    const actionDeadline = deadlineFactory(input);
    deadline = actionDeadline;
    debug(
      `Parsed inputs (w/o token): ${(({ githubToken, ...inputs }) => JSON.stringify(inputs))(
        input,
      )}`,
    );
    actionDeadline.throwIfReached();
    const github = githubFactory(input.githubToken, input.retries);
    debug(`Fetching workflows for ${input.owner}/${input.repo}...`);
    const workflows = await actionDeadline.race((signal) =>
      github.workflows(input.owner, input.repo, {
        signal,
        checkDeadline: actionDeadline.throwIfReached,
      }),
    );
    debug(`Found ${workflows.length} workflows in ${input.owner}/${input.repo}`);
    actionDeadline.throwIfReached();
    const workflowId = findWorkflowId(workflows, input);
    if (workflowId !== undefined) {
      const result = await waiterFactory(workflowId, github, input, actionDeadline).wait();
      if (result === undefined) {
        actionDeadline.throwIfReached();
      }
    } else {
      actionDeadline.throwIfReached();
      setFailed(
        `No workflow found matching workflow path or name: ${input.workflowPath || input.workflowName}`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof DeadlineReached) {
      try {
        handleDeadline(error, info, () => {
          setOutput('previous_run_id', '');
          setOutput('previous_run_url', '');
        });
      } catch (deadlineError: unknown) {
        setFailed(errorMessage(deadlineError));
      }
    } else {
      deadline?.cancel(error);
      setFailed(errorMessage(error));
    }
  } finally {
    deadline?.dispose();
  }
}

if (require.main === module) {
  run();
}
