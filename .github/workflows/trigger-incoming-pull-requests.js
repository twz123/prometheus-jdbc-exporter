module.exports = async ({ runName, github, context, core }) => {

  class Problem extends Error {
    cause;
    opts;

    constructor(message, opts) {
      super(message);
      this.opts = { ...opts };
      if ("cause" in this.opts) {
        this.cause = this.opts.cause;
        delete this.opts.cause;
      }
    }
  }

  const prQueryFragment = `
    number mergeable
    headRef { name }
  `;

  // Fetch all open pull requests against this branch
  const fetchOpenPullRequests = async () => {
    const query = `
      query ($owner: String!, $repo: String!, $refName: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(last: 100, baseRefName: $refName, states: OPEN) {
            nodes {
              ${prQueryFragment}
            }
          }
        }
      }
    `;

    const queryVars = {
      ...context.repo,
      refName: context.ref.replace(/^refs\/heads\//, "")
    };

    core.debug(`Fetching open PRs: ${JSON.stringify(queryVars)}`);
    const data = await github.graphql(query, { ...context.repo, ...queryVars, });
    return data.repository.pullRequests.nodes;
  };

  const awaitAll = async (promises, errorProp, resultsProp) => {
    const results = [], errorMessages = [];
    (await Promise.allSettled(promises)).forEach(outcome => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        const error = outcome.reason;
        errorMessages.push(error.message);
        results.push({ ...error.opts[errorProp], error: error.cause, });
      }
    });

    if (errorMessages.length) {
      const opts = {};
      opts[resultsProp] = results;
      throw new Problem(errorMessages.join(", "), opts);
    }

    return results;
  };

  // Resolve pull requests until the mergeable state is no longer unknown.
  // https://stackoverflow.com/a/30620973
  const resolveUnknownMergeable = async (pullRequest) => {
    const prQuery = `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            ${prQueryFragment}
          }
        }
      }
    `;

    // Retry up to ten times
    for (let retryAttempt = 0; pullRequest.mergeable === "UNKNOWN" && retryAttempt++ <= 10;) {
      // Delay the next call up to 5 seconds
      const delayMillis = Math.min(retryAttempt - 1, 4) * 1000 + Math.random() * 1000;
      core.debug(`Re-fetching PR #${pullRequest.number} in ${delayMillis} ms`);
      await (new Promise((resolve) => setTimeout(resolve, delayMillis)));
      const data = await github.graphql(prQuery, {
        ...context.repo,
        number: pullRequest.number,
      });
      pullRequest = data.repository.pullRequest;
    }

    core.debug(`Resolved mergeable state: ${JSON.stringify(pullRequest)}`);
    return pullRequest;
  }

  // Re-runs workflows for a given pull request.
  const triggerReruns = async (pullRequest) => {
    // https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository
    const workflowRuns = (await github.request('GET /repos/{owner}/{repo}/actions/runs', {
      ...context.repo,
      event: "pull_request",
      branch: pullRequest.headRef.name,
    })).data.workflow_runs;

    let promises = workflowRuns.filter((run) => {
      return run.name === runName && run.pull_requests.some((runPullRequest) => {
        return runPullRequest.number === pullRequest.number;
      })
    }).map(run => (async () => {
      // Is it required to cancel any runs which are in non-terminal states?
      core.info(`Re-running workflow run ${run.id} for PR #${pullRequest.number} in status ${run.status}`);
      // https://docs.github.com/en/rest/reference/actions#re-run-a-workflow
      const { status, data, } = await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
        ...context.repo,
        run_id: run.id,
      });
      return {
        status, data,
        run: {
          id: run.id,
          status: run.status,
        },
      };
    })().catch(cause => {
      throw new Problem(`failed to re-run workflow run ${run.id}: ${cause}`, { cause, run, });
    }));

    return await awaitAll(promises, "run", "triggeredReruns");
  }

  const openPullRequests = await fetchOpenPullRequests();
  core.debug(`Fetched open PRs: ${JSON.stringify(openPullRequests, null, 2)}`);

  const promises = openPullRequests.map(pr => (async () => {
    const pullRequest = await resolveUnknownMergeable(pr);

    let rerunsTriggered = false;
    switch (pullRequest.mergeable) {
      case "UNKNOWN":
        core.warning(`PR #${pullRequest.number}: mergeablility still unknown`);
      // fall through

      case "MERGEABLE":
        rerunsTriggered = await triggerReruns(pullRequest);
        break;

      default:
        core.debug(`Skipping non-mergeable PR #${pullRequest.number}`);
    }
    return { ...pullRequest, rerunsTriggered, };
  })().catch(cause => {
    throw new Problem(`failed to trigger runs for PR #${pr.number}: ${cause}`, { cause, pullRequest: pr, });
  }));

  return await awaitAll(promises, "pullRequest", "pullRequests");
};
