#!/bin/sh
# The pre-push checks on the commits a push would publish. Reads git's
# pre-push lines on stdin:
#
#   <local ref> <local sha> <remote ref> <remote sha>
#
# and refuses the push (exit 1, the reason on stderr) when a pushed commit
#
# 1. holds a path that .gitignore keeps local, with content that the base of
#    the push does not already hold. Some files stay on this machine only. A
#    commit made before a path was ignored still holds it, so a push of an old
#    branch (or a merge or plain rebase of one) would publish it again: on
#    2026-10-30 private docs left the unpushed history, and every branch made
#    before that still held them. So each pushed commit's whole tree is
#    checked against the CURRENT .gitignore. A file that the base already holds
#    with the same content is not new, so it passes: on 2026-11-11 a commit
#    that stopped tracking an already-public file made every earlier unpushed
#    commit fail (task 8433a7d6). A changed version of such a file still fails.
#
# 2. has an author or committer email that is not a GitHub noreply address.
#    This repository is public. On 2026-11-11 the repo's user.email was lost in
#    a repair, and commits fell back to a personal address (task 8433a7d6).
#
# On success it prints every path the pushed commits change, for the hook's
# game-video gate. About 6 s for 200 commits.
#
# POSIX sh: the hook runs under husky's `sh -e`.
set -eu

zero=0000000000000000000000000000000000000000
noreply='^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$'
changed=""

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # a branch deletion pushes no commit
  # A new branch, or a remote tip this clone does not have: check all that
  # origin/main does not have.
  base=refs/remotes/origin/main
  if [ "$remote_sha" != "$zero" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    base=$remote_sha
  fi
  if ! commits=$(git rev-list --reverse "$base..$local_sha"); then
    echo "❌❌ Push refused: cannot list the commits of $local_ref ($base..$local_sha)." >&2
    exit 1
  fi
  # A diff that fails (no common base) counts as a game-video change.
  changed="$changed
$(git diff --name-only "$base...$local_sha" || echo scripts/game-video/)"

  for commit in $commits; do
    what=$(git log -1 --format='%h %s' "$commit")

    for field in author committer; do
      if [ "$field" = author ]; then format=%ae; else format=%ce; fi
      email=$(git log -1 --format="$format" "$commit")
      if ! printf '%s\n' "$email" | grep -qE "$noreply"; then
        echo "❌❌ Push refused: $local_ref -> $remote_ref has a commit whose $field email is not a GitHub noreply address." >&2
        echo "Commit $what has $field <$email>." >&2
        echo "Set this repo's user.email to the noreply address, then rewrite the commit," >&2
        echo "for example 'git commit --amend --reset-author --no-edit' (or a rebase for older ones)." >&2
        exit 1
      fi
    done

    if ignored=$(git ls-tree -r --name-only "$commit" | git check-ignore --no-index --stdin); then
      :
    else
      status=$?
      if [ "$status" -ne 1 ]; then # 1 = no path is ignored
        echo "❌❌ Push refused: cannot check commit $what against .gitignore." >&2
        exit 1
      fi
    fi
    new=""
    if [ -n "$ignored" ]; then
      new=$(printf '%s\n' "$ignored" | while IFS= read -r path; do
        here=$(git rev-parse "$commit:$path")
        there=$(git rev-parse -q --verify "$base:$path" || true)
        [ "$here" = "$there" ] || printf '%s\n' "$path"
      done)
    fi
    if [ -n "$new" ]; then
      echo "❌❌ Push refused: $local_ref -> $remote_ref holds files that .gitignore keeps local." >&2
      echo "Commit $what has, with content that $base does not hold:" >&2
      printf '%s\n' "$new" | sed 's/^/  /' >&2
      echo "Move the branch's own commits onto main without them, for example" >&2
      echo "'git rebase --onto main <old base> <branch>' or cherry-pick." >&2
      exit 1
    fi
  done
done

printf '%s\n' "$changed" | sed '/^$/d' | sort -u
