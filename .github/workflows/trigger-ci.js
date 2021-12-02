module.exports = ({ github, context, core, }) => {

  const prQueryFragment = `
    number mergeable
    headRef { name }
  `;

  // Re-fetch pull requests until the mergeable state is no longer unknown.
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
    for (let retryAttempt = 0; (pullRequest.mergeable === undefined || pullRequest.mergeable === "UNKNOWN") && retryAttempt++ <= 10;) {
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

  const dispatchBuildsForPullRequests = async (pullRequests) => {
    const promises = pullRequests.map(pr => (async () => {
      const pullRequest = await resolveUnknownMergeable(pr);

      let dispatchedBuild = false;
      switch (pullRequest.mergeable) {
        case "UNKNOWN":
          core.warning(`PR #${pullRequest.number}: mergeablility still unknown`);
        // fall through

        case "MERGEABLE":
          const data = {
            ...context.repo,
            workflow_id: "ci.yaml",
            ref: `refs/pull/${pullRequest.number}/merge`,
            inputs,
          };
          core.info(`Dispatching workflow: ${JSON.stringify(data, null, 2)}`);
          dispatchedBuild = await github.actions.createWorkflowDispatch(data);
          break;

        default:
          core.debug(`Skipping non-mergeable PR #${pullRequest.number}`);
      }
      return { ...pullRequest, dispatchedBuild, };
    })().catch(cause => {
      throw new Error(`failed to dispatch workflow for PR #${pr.number}`, { pullRequest: pr, cause, });
    }));

    const dispatchedBuilds = [], errorMessages = [];
    (await Promise.allSettled(promises)).forEach(outcome => {
      if (outcome.status === "fulfilled") {
        dispatchedBuilds.push(outcome.value);
      } else {
        const error = outcome.reason;
        errorMessages.push(error.message);
        dispatchedBuilds.push({ error, });
      }
    });

    if (errorMessages.length) {
      core.debug(`Errors during dispatch: ${errorMessages.join(", ")}`);
      throw new Error(errorMessages.join(", "), { dispatchedBuilds, });
    }

    return dispatchedBuilds;
  };

  const listIncomingPullRequestsToBranch = async (branch) => {
    const query = `
      query ($owner: String!, $repo: String!, $branch: String!) {
        repository(owner: $owner name: $repo) {
          pullRequests(last: 100, baseRefName: $branch, states: OPEN) {
            nodes {
              ${prQueryFragment}
            }
          }
        }
      }
    `;
    core.debug(`Listing incoming PRs for ${branch}`);
    const data = await github.graphql(query, { ...context.repo, branch, });
    return await dispatchBuildsForPullRequests(data.repository.pullRequests.nodes);
  };

  switch (context.eventName) {
    case "push":
      const branch = context.ref.replace(/^refs\/heads\//, "");
      return listIncomingPullRequestsToBranch(branch).then(dispatchBuildsForPullRequests);
    case "pull_request":
      return dispatchBuildsForPullRequests([context.payload.pull_request]);
    default:
      core.setFailed(`Unsupported event: ${context.eventName}`);
      return;
  }
};
