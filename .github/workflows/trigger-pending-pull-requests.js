module.exports = async ({ github, context, core }) => {

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

    core.debug(queryVars);
    const data = await github.graphql(query, { ...context.repo, ...queryVars, });
    core.debug(data);

    return data.repository.pullRequests.nodes;
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
      // Delay the next call between 1 and 5 seconds
      await (new Promise((resolve) => setTimeout(resolve, Math.min(retryAttempt, 5) * 1000)));
      const data = await github.graphql(prQuery, {
        ...context.repo,
        number: pullRequest.number,
      });
      pullRequest = data.repository.pullRequest;
    }

    return pullRequest;
  }

  // Re-runs workflows for a given pull request.
  const triggerReruns = async (runName, pullRequest) => {
    // https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository
    const runData = await github.request('GET /repos/{owner}/{repo}/actions/runs', {
      ...context.repo,
      event: "pull_request",
      branch: pullRequest.headRef.name,
    });

    return runData.workflow_runs.filter((run) => {
      return run.name === runName && run.pull_requests.some((runPullRequest) => {
        return runPullRequest.number === pullRequest.number;
      })
    }).map(run => async () => {
      // Is it required to cancel any runs which are in non-terminal states?
      core.info(`Re-running workflow run ${run.id} for PR #${pullRequest.number} in status ${run.status}`);
      // https://docs.github.com/en/rest/reference/actions#re-run-a-workflow
      return await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
        ...context.repo,
        run_id: run.id,
      });
    })
  }

  const openPullRequests = await fetchOpenPullRequests();

  const triggeredPullRequests = openPullRequests.map(pr => async () => {
    const pullRequest = resolveUnknownMergeable(pr);
    let rerunsTriggered = false;
    switch (pullRequest.mergeable) {
      case "UNKNOWN":
        core.warning(`PR #${pullRequest.number}: mergeablility still unknown`);
      // fall through

      case "MERGEABLE":
        rerunsTriggered = await triggerReruns("CI", pullRequest);
    }
    return { ...pullRequest, rerunsTriggered, };
  });

  return await Promise.all(triggeredPullRequests);
};
