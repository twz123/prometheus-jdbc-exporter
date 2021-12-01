module.exports = async ({ github, context, core }) => {
  const mergeablePullRequests = await (async () => {
    const query = `
      query ($owner: String!, $repo: String!, $refName: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(last: 100, baseRefName: $refName, states: OPEN) {
            nodes {
              number mergeable
              headRef { name }
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

    return data.repository.pullRequests.nodes
      .filter(pullRequest => pullRequest.mergeable === "MERGEABLE")
      .map(({ number, headRef }) => ({ number, branch: headRef.name, }));
  })();

  const nestedRerunResponses = await Promise.all(mergeablePullRequests.map(pullRequest => {
    // https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository
    github.request('GET /repos/{owner}/{repo}/actions/runs', {
      ...context.repo,
      event: "pull_request",
      branch: pullRequest.branch,
    }).then(({ data }) => {
      return Promise.all(data.workflow_runs.filter((run) => {
        return run.name === "CI" && run.pull_requests.some((runPullRequest) => {
          return runPullRequest.number === pullRequest.number;
        })
      }).map((run) => {
        // Is it required to cancel any runs which are in non-terminal states?
        core.info(`Will try to re-run workflow run ${run.id} in status ${run.status}`);
        // https://docs.github.com/en/rest/reference/actions#re-run-a-workflow
        return github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
          ...context.repo,
          run_id: run.id,
        });
      }));
    })
  }));

  return nestedRerunResponses.flatMap(rerunResponse => rerunResponse);
};
