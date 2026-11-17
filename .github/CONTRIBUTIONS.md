# Automatic profile updates

The workflow checks the public PRs listed in `contributions.json` every hour,
at minute 17, and can also be run from the Actions tab. GitHub may queue or delay
scheduled runs. No personal access token, AI service, or local computer is needed;
the workflow uses the repository's built-in `GITHUB_TOKEN`.

- Merged PRs appear under their project in the main contribution list.
- Open PRs remain in the expandable list, whose count is recalculated.
- PRs closed without merging are omitted, but stay in the configuration so a
  later reopening is detected.
- Only content between the two contribution markers is generated. The bio,
  education, award, and closing sentence remain manually editable.
- If any PR request fails, the README is left unchanged. The next scheduled run
  retries. Runs with no display changes create no commit.

To track a new contribution, add its repository, number, project label, and display
title to `contributions.json`. The author must match the configured owner. This is
a curated list: personal repository PRs and coursework are not auto-discovered.

Local checks (Node.js 24):

```sh
node --test .github/scripts/update-contributions.test.mjs
node .github/scripts/update-contributions.mjs --check
```

GitHub disables scheduled workflows in public repositories after 60 days without
repository activity. If that happens, re-enable this workflow in the Actions tab.
See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
