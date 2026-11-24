#!/usr/bin/env bash
# Applies the repository settings this project relies on. Safe to run again: every call sets a state.
# Usage: scripts/configure-repository.sh [owner/repo]
set -euo pipefail
repo="${1:-Electivus/pi-github-copilot-compat}"
api() { gh api "repos/$repo$1" "${@:2}" >/dev/null; }

api "" --method PATCH --input - <<'JSON'
{
  "allow_merge_commit": false, "allow_rebase_merge": false, "allow_squash_merge": true,
  "delete_branch_on_merge": true, "has_wiki": false, "has_projects": false,
  "security_and_analysis": {
    "secret_scanning": {"status": "enabled"},
    "secret_scanning_push_protection": {"status": "enabled"}
  }
}
JSON
api /vulnerability-alerts --method PUT
api /automated-security-fixes --method PUT
# Private vulnerability reporting exists only on public repositories.
api /private-vulnerability-reporting --method PUT || echo "skipped: private vulnerability reporting (repository is not public)"
api /actions/permissions/workflow --method PUT --input - <<'JSON'
{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}
JSON
api /actions/permissions --method PUT --input - <<'JSON'
{"enabled": true, "allowed_actions": "selected", "sha_pinning_required": true}
JSON
api /actions/permissions/selected-actions --method PUT --input - <<'JSON'
{"github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": []}
JSON

# 15368 is the GitHub Actions app, so only a run of this repository's CI satisfies the check.
ruleset() {
	local name="$1" body="$2" id
	id="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
	if [ -n "$id" ]; then
		gh api "repos/$repo/rulesets/$id" --method PUT --input - <<<"$body" >/dev/null
	else
		gh api "repos/$repo/rulesets" --method POST --input - <<<"$body" >/dev/null
	fi
}
ruleset "Protect main" '{
  "name": "Protect main", "target": "branch", "enforcement": "active", "bypass_actors": [],
  "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
  "rules": [
    {"type": "deletion"}, {"type": "non_fast_forward"}, {"type": "required_linear_history"},
    {"type": "pull_request", "parameters": {"required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"]}},
    {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": true, "do_not_enforce_on_create": false, "required_status_checks": [{"context": "check", "integration_id": 15368}]}}
  ]
}'
ruleset "Protect version tags" '{
  "name": "Protect version tags", "target": "tag", "enforcement": "active", "bypass_actors": [],
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}]
}'
echo "Configured $repo."
