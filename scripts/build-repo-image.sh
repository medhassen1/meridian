#!/usr/bin/env bash
#
# Build the repository image the way the platform builds it.
#
# The repository-image service does not build our Dockerfile verbatim. It owns
# the outer build context and injects repository setup around our instructions:
# it keeps our FROM as the base, installs git when the base lacks it, copies the
# outer context's repo/ directory into /app, sets the working directory, runs
# the rest of our Dockerfile, and finally appends its own git configuration —
# which runs as whichever USER we ended on.
#
# Building standalone would miss all of that. In particular it would not catch
# a Dockerfile that copies the repository itself (the platform has already done
# it), or one that switches to a non-root user without handing over ownership
# of /app, which makes the appended `git config` fail with a permission error.
#
# Usage: scripts/build-repo-image.sh [tag]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-meridian-repo-image:local}"

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT

# The platform's context holds the repository under repo/, with its history:
# task fixture setup runs `git reset --hard <base commit>` inside the image.
git clone --quiet --no-hardlinks "$ROOT" "$CONTEXT/repo"
git -C "$CONTEXT/repo" remote remove origin

{
  # 1. our FROM, kept as the image base
  grep -m1 '^FROM ' "$ROOT/Dockerfile"

  # 2. git, when the base image lacks it
  cat <<'INJECTED'
RUN if ! command -v git >/dev/null 2>&1; then \
      apt-get update \
      && apt-get install -y --no-install-recommends git \
      && rm -rf /var/lib/apt/lists/*; \
    fi
INJECTED

  # 3. the repository copy and working directory
  cat <<'INJECTED'
COPY repo/ /app
WORKDIR /app
INJECTED

  # 4. the rest of our Dockerfile, verbatim after its FROM
  sed '0,/^FROM /d' "$ROOT/Dockerfile"

  # 5. git safety and hook configuration, as our final USER
  cat <<'INJECTED'
RUN git config --global --add safe.directory /app \
    && cd /app \
    && git config core.hooksPath /dev/null
INJECTED
} >"$CONTEXT/Dockerfile"

cat >"$CONTEXT/.dockerignore" <<'IGNORED'
repo/node_modules
repo/dist
repo/coverage
repo/.vitest-reports
IGNORED

# Repository images are built with Docker's legacy builder. Its deprecation
# notice is informational; the build has not failed because of it.
echo "==> building $TAG"
DOCKER_BUILDKIT=0 docker build -t "$TAG" "$CONTEXT"

echo "==> the default command runs"
docker run --rm "$TAG" >/dev/null

echo "==> the repository and its history are present at /app"
docker run --rm --entrypoint sh "$TAG" -c '
  set -e
  test -d /app/.git
  test "$(git -C /app rev-list --count HEAD)" -gt 0
  base=$(git -C /app rev-list HEAD | tail -1)
  git -C /app reset --hard "$base" >/dev/null
'

echo "==> the platform git configuration was applied"
docker run --rm --entrypoint sh "$TAG" -c '
  set -e
  test "$(git -C /app config --get core.hooksPath)" = "/dev/null"
  git config --global --get safe.directory | grep -qx /app
'

echo "ok: $TAG built and smoke-tested"
