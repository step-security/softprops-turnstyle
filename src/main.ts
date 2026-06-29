import { debug, info, setFailed } from '@actions/core';
import { env } from 'process';
import { OctokitGitHub } from './github';
import { parseInput } from './input';
import { Waiter } from './wait';
import { findWorkflowId } from './workflow';
import fs from 'fs';
import * as core from '@actions/core';
import axios, { isAxiosError } from 'axios';

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

async function run() {
  try {
    await validateSubscription();
    const input = parseInput(env);
    debug(
      `Parsed inputs (w/o token): ${(({ githubToken, ...inputs }) => JSON.stringify(inputs))(
        input,
      )}`,
    );
    const github = new OctokitGitHub(input.githubToken, input.retries);
    debug(`Fetching workflows for ${input.owner}/${input.repo}...`);
    const workflows = await github.workflows(input.owner, input.repo);
    debug(`Found ${workflows.length} workflows in ${input.owner}/${input.repo}`);
    const workflow_id = findWorkflowId(workflows, input);
    if (workflow_id) {
      await new Waiter(workflow_id, github, input, info, debug, workflows).wait();
    } else {
      setFailed(
        `No workflow found matching workflow path or name: ${input.workflowPath || input.workflowName}`,
      );
    }
  } catch (error: any) {
    setFailed(error.message);
  }
}

if (require.main === module) {
  run();
}
