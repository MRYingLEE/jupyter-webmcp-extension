# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` (gh 2.94+). Older gh: use `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>` (gh 2.94+). Older gh: use the API with the blocker's numeric database id. Where dependencies aren't available, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Apply/remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: explain in a comment, then run `gh issue close <number>`.

Infer the repo from `git remote -v`; `gh` does this automatically in a clone. File issues only in this repo. Before the first issue creation, verify the target with `gh repo view --json nameWithOwner`.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` only if this repo treats external PRs as feature requests.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Read it with `gh issue view <number>`.

## Wayfinding operations

- **Map**: one issue labelled `wayfinder:map`, containing Notes / Decisions-so-far / Fog.
- **Child ticket**: link it as a GitHub sub-issue of the map (or use a task list and `Part of #<map>` if sub-issues are unavailable). Use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use native GitHub issue dependencies; where unavailable, use a `Blocked by: #<n>` line.
- **Frontier**: choose the first open child in map order with no open blockers and no assignee.
- **Claim**: assign with `gh issue edit <n> --add-assignee @me` before doing work.
- **Resolve**: comment with the answer, close the issue, then append a context pointer to the map's Decisions-so-far.
