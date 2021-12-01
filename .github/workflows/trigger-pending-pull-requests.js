module.exports = ({ github, context, core }) => {
  const mergeablePullRequests = (async () => {
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

    return data.repository.pullRequests.nodes.filter(pr => {
      return pr.mergeable === "MERGEABLE";
    });
  })();

  const reruns = mergeablePullRequests.map(pullRequest => {
    github.actions.listWorkflowRunsForRepo({
      ...context.repo,
      event: "pull_request",
      branch: pullRequest.headRef.name,
    }).then(({ data }) => {
      const rerunPromises = data.workflow_runs.filter((run) => {
        return run.name === "CI" && run.pull_requests.some((runPullRequest) => {
          return runPullRequest.number === pullRequest.number;
        })
      }).map((run) => {
        // Is it required to cancel any runs which are in non-terminal states?
        core.info(`Will try to re-run workflow run ${run.id} in status ${run.status}`);
        github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
          ...context.repo,
          run_id: run.id,
        })
      });
      return Promise.all(rerunPromises);
    })
  });

  return Promise.all(reruns);
};
