# Archon Graphified Workflows — Design

**Date**: 2026-05-14
**Scope**: Two TubeSage-local Archon workflows that clone existing defaults and add (a) graphify-driven codebase context up front, (b) Superpowers skills on the right nodes, (c) a graphify refresh + commit at the end so the graph travels with the PR.

## Goals

1. Two new workflows in `TubeSage/.archon/workflows/`:
   - `archon-graph-superpowers-feature` — for net-new features / requirements (clone of `archon-idea-to-pr`).
   - `archon-graph-superpowers-fix-issue` — for GitHub issues / bugs (clone of `archon-fix-github-issue`).
2. Each workflow ingests codebase context from `graphify-out/graph.json` before any planning or investigation, via `graphify query`.
3. Each workflow runs `graphify . --update` after the implementation succeeds and bundles the refreshed `graphify-out/graph.json` into the PR.
4. Each workflow attaches Superpowers skills at the nodes where they're most relevant — planning, implementation, validation, receiving-review, and finishing.

## Non-goals

- Replacing or modifying the default workflows.
- Adding semantic re-extraction (`graphify` with API calls) — only the AST-only `--update` runs inside the workflow.
- Adding skill content to the graph — graphify only indexes code.
- Building a new command file unless an existing default doesn't cover the use case.

## Source workflows

Both lifted verbatim from `/Volumes/HomeExt/Users/rmccorkl/Code/Archon/.archon/workflows/defaults/`:

- `archon-idea-to-pr.yaml` — 8 phases: create-plan → plan-setup → confirm-plan → implement-tasks → validate → finalize-pr → review (5 parallel agents + synthesize) → implement-fixes → workflow-summary.
- `archon-fix-github-issue.yaml` — 10 phases: extract/fetch/classify issue → web-research → investigate-or-plan → bridge-artifacts → implement → validate → create-pr → review-scope/classify → conditional review agents → synthesize → self-fix → simplify → report.

The clones reuse every existing command node by reference. No commands are copied — they resolve from the global Archon defaults chain.

## File layout

```
TubeSage/
├── .archon/
│   └── workflows/
│       ├── archon-graph-superpowers-feature.yaml
│       └── archon-graph-superpowers-fix-issue.yaml
└── graphify-out/                # already exists; consumed and refreshed
```

No `.archon/commands/`, no `.archon/config.yaml`. Project-scoped workflows shadow defaults by filename; new names mean they appear additively without overriding anything.

## Node additions (common to both workflows)

### A. `graph-health-check` (bash, advisory)

```yaml
- id: graph-health-check
  bash: |
    set -e
    if [ ! -f graphify-out/graph.json ]; then
      echo "WARN: graphify-out/graph.json missing — skipping context acquisition" >&2
      echo "missing" > "$ARTIFACTS_DIR/.graph-state"
      exit 0
    fi
    graphify check-update graphify-out 2>&1 || true
    echo "ok" > "$ARTIFACTS_DIR/.graph-state"
  timeout: 15000
```

Soft-fails to `missing` state when the graph isn't present so downstream nodes can skip cleanly. The TubeSage repo already has `graphify-out/` so the happy path applies.

### B. `graph-context` (bash)

Runs first-class graph query against the user's request:

```yaml
- id: graph-context
  bash: |
    set -e
    if [ "$(cat "$ARTIFACTS_DIR/.graph-state" 2>/dev/null || echo missing)" = "missing" ]; then
      echo "No graph available — writing empty context"
      echo "_(graphify-out/graph.json missing — context unavailable)_" > "$ARTIFACTS_DIR/codebase-context.md"
      exit 0
    fi
    {
      echo "# Codebase context (graphify query)"
      echo
      echo "**Question**: $ARGUMENTS"
      echo
      echo '```'
      graphify query "$ARGUMENTS" --budget 4000 --graph graphify-out/graph.json
      echo '```'
    } > "$ARTIFACTS_DIR/codebase-context.md"
  depends_on: [graph-health-check]
  timeout: 60000
```

The output is a markdown file at `$ARTIFACTS_DIR/codebase-context.md`. Subsequent planning/investigation nodes read it via `$ARTIFACTS_DIR` (their command prompts already reference `$ARTIFACTS_DIR` — see `archon-create-plan`, `archon-investigate-issue`).

### C. `graph-update` (bash)

```yaml
- id: graph-update
  bash: |
    set -e
    if ! command -v graphify >/dev/null 2>&1; then
      echo "graphify CLI not on PATH — skipping refresh" >&2
      exit 0
    fi
    graphify . --update
    if ! git diff --quiet graphify-out/graph.json 2>/dev/null; then
      git add graphify-out/graph.json
      git commit -m "chore: refresh graphify graph after delivery"
      echo "graph refreshed and committed"
    else
      echo "graph unchanged — no commit"
    fi
  timeout: 120000
```

Runs after `validate` and before the local merge-back. The global PostToolUse hook already runs `graphify update .` after each Edit/Write but has a hard 8s timeout — this node is the deliberate, larger-budget backstop the user asked for.

### D. `merge-back` (bash)

Replaces the PR creation + review pipeline. Runs after `graph-update`:

```yaml
- id: merge-back
  bash: |
    set -e
    PRIMARY=$(git worktree list | head -1 | awk '{print $1}')
    FEATURE_BRANCH=$(git branch --show-current)
    BASE="${BASE_BRANCH:-main}"
    if [ "$FEATURE_BRANCH" = "$BASE" ]; then exit 0; fi
    if [ -n "$(git -C "$PRIMARY" status --porcelain)" ]; then
      echo "ERROR: primary worktree has uncommitted changes" >&2; exit 1
    fi
    git -C "$PRIMARY" checkout "$BASE"
    git -C "$PRIMARY" merge --ff-only "$FEATURE_BRANCH" 2>/dev/null \
      || git -C "$PRIMARY" merge --no-ff "$FEATURE_BRANCH" -m "merge: $FEATURE_BRANCH (via archon worktree)"
  depends_on: [graph-update]
  timeout: 60000
```

Refuses to merge if the primary worktree has uncommitted state — surfaces the conflict rather than clobbering. Prefers fast-forward; falls back to non-ff merge for divergent histories.

## Skill placement

Skills attach to command/prompt nodes via the `skills:` array. Archon's Claude provider (`packages/providers/src/claude/provider.ts:435`) wraps the node in a `dag-node-skills` `AgentDefinition` and injects the `Skill` tool — no other changes needed.

Names use the namespaced form `superpowers:<skill>` since these skills are plugin-provided (not in `~/.claude/skills/`). The Claude SDK applies the standard skill-resolution chain which understands plugin namespaces. If a runtime test surfaces a "skill not found" error, the fallback is to symlink each plugin skill into `~/.claude/skills/superpowers/<name>/` and reference without the namespace.

### Feature workflow (`archon-graph-superpowers-feature`)

| Node | Skills |
|---|---|
| `create-plan` | `superpowers:brainstorming` |
| `implement-tasks` | `superpowers:test-driven-development`, `superpowers:systematic-debugging` |
| `validate` | `superpowers:verification-before-completion` |
| `workflow-summary` | `superpowers:finishing-a-development-branch` |

### Issue workflow (`archon-graph-superpowers-fix-issue`)

| Node | Skills |
|---|---|
| `investigate` | `superpowers:systematic-debugging` |
| `plan` | `superpowers:brainstorming` |
| `implement` | `superpowers:test-driven-development`, `superpowers:systematic-debugging` |
| `validate` | `superpowers:verification-before-completion` |
| `report` | `superpowers:finishing-a-development-branch` |

Since the workflows no longer create a PR or run the PR-based review pipeline, the `archon-code-review-agent`, `archon-error-handling-agent`, `archon-test-coverage-agent`, `archon-comment-quality-agent`, `archon-docs-impact-agent`, `archon-synthesize-review`, `archon-implement-review-fixes`, `archon-self-fix-all`, and `archon-simplify-changes` commands are all dropped. The user can invoke `superpowers:requesting-code-review` manually on the local diff before the merge-back step if they want a review pass.

## Node ordering

### `archon-graph-superpowers-feature` (feature path)

```
graph-health-check → graph-context → create-plan → plan-setup → confirm-plan
  → implement-tasks → validate → graph-update → merge-back → workflow-summary
```

Two new bash nodes (`graph-health-check`, `graph-context`) prepend the chain. `graph-update` and `merge-back` replace the entire PR + review pipeline.

### `archon-graph-superpowers-fix-issue` (issue path)

```
extract-issue-number → fetch-issue → classify
  → graph-health-check → graph-context
  → web-research
  → investigate (when issue_type == 'bug') | plan (else)
  → bridge-artifacts → implement → validate → graph-update → merge-back → report
```

`graph-context` runs after `classify` so the BFS has access to the issue body (already on disk from `fetch-issue`). The bash node uses `$ARGUMENTS` as the query string — the issue title and body remain available to downstream investigate/plan nodes via `$fetch-issue.output` and `$classify.output`.

## Error / edge handling

- **No `graphify-out/`**: `graph-health-check` writes `missing` state; `graph-context` writes a placeholder. Downstream nodes proceed without graph context — they just lose the upfront context boost.
- **graphify CLI absent**: same handling — soft-skip with a warning to stderr.
- **`graphify query` exceeds 60s**: bash node times out; workflow continues to the next phase because graph context is best-effort, not required.
- **`graphify . --update` exceeds 120s**: workflow fails the bash node. Retry config (`retry: max_attempts: 2, on_error: all`) covers transient FS issues. The hard fail is intentional — a partial graph that gets merged back to base is worse than no refresh.
- **Empty diff after `graphify . --update`**: no commit is created; merge-back is unaffected.
- **Primary worktree dirty at merge-back time**: `merge-back` refuses and prints the manual merge command. The work is preserved in the worktree's branch — the user resolves the dirty state and runs the merge by hand. No data loss.
- **Non-fast-forward merge**: `merge-back` falls back to `--no-ff` with an explicit merge commit message, preserving the worktree's branch history.
- **Worktree isolation**: Archon runs each workflow in its own git worktree by default. `graphify-out/` is per-worktree, so concurrent runs of these workflows don't trample each other's graph files. The primary worktree is shared — concurrent merge-backs serialize via git's index lock.

## Validation plan

1. `archon workflow list` reports both `archon-graph-superpowers-feature` and `archon-graph-superpowers-fix-issue` from the project directory.
2. `archon workflow validate archon-graph-superpowers-feature` (if the CLI exposes a validate subcommand) — otherwise rely on `archon workflow list` exit code which loads and parses every YAML.
3. Dry-run `archon-graph-superpowers-feature` against a trivial idea (e.g., "Add a comment to main.ts explaining the LangChain exception for Anthropic") and confirm: graph context artifact written, plan references it, graph refresh fires, primary worktree's `main` advances after merge-back.
4. Dry-run `archon-graph-superpowers-fix-issue` against an existing labeled issue with a known easy fix; same checks.
5. Verify cleanup pattern: after a run completes, `archon complete <branch>` removes the worktree and the branch (commits are preserved on `main` from the merge-back).

## Open risks

1. **Skill namespace resolution** — if `superpowers:test-driven-development` doesn't resolve through the Claude SDK skill chain inside an Archon agent, the symlink fallback adds 14 symlinks under `~/.claude/skills/superpowers/`. Detectable at workflow runtime by a "skill not found" log; fallback is mechanical.
2. **`graphify check-update`** is advisory — TubeSage's graph might be marked as needing semantic re-extraction (which costs API credits) and we're silently ignoring that. Acceptable for the AST-only refresh path; if the graph drifts substantially, the user runs `/graphify` manually.
3. **Cost of `graphify query` per workflow run** — query is local BFS, no LLM cost. Safe to run on every invocation.
