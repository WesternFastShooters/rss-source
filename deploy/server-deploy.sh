#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly APP_NAME="rss-source"
readonly APP_DIR="/srv/apps/${APP_NAME}"
readonly ENV_FILE="${APP_DIR}/.env"
readonly COMPOSE_FILE="${APP_DIR}/compose.production.yaml"
readonly DEFAULT_IMAGE_REPO="ghcr.io/westernfastshooters/rss-source"

exec 9>"/run/lock/${APP_NAME}.lock"
flock -n 9 || { echo "A deployment is already running." >&2; exit 75; }

read -r action commit actor extra <<<"${SSH_ORIGINAL_COMMAND:-}"
if [[ "$action" != "deploy" || ! "$commit" =~ ^[0-9a-f]{40}$ || ! "$actor" =~ ^[A-Za-z0-9-]+$ || -n "${extra:-}" ]]; then
  echo "Rejected deployment command." >&2
  exit 64
fi

ghcr_token="$(cat)"
if (( ${#ghcr_token} < 20 )); then
  echo "Missing ephemeral GHCR token." >&2
  exit 65
fi

docker_config="$(mktemp -d /run/${APP_NAME}-docker.XXXXXX)"
deploy_tmp="$(mktemp -d "${APP_DIR}/.deploy.XXXXXX")"
container_id=""

cleanup() {
  docker logout ghcr.io >/dev/null 2>&1 || true
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$docker_config" "$deploy_tmp"
}
trap cleanup EXIT

export DOCKER_CONFIG="$docker_config"
printf '%s' "$ghcr_token" | docker login ghcr.io -u "$actor" --password-stdin >/dev/null
unset ghcr_token

new_tag="sha-${commit}"
image_repo="$(sed -n 's/^IMAGE_NAME=//p' "$ENV_FILE" | tail -n 1)"
image_repo="${image_repo:-$DEFAULT_IMAGE_REPO}"
new_image="${image_repo}:${new_tag}"
previous_tag="$(sed -n 's/^IMAGE_TAG=//p' "$ENV_FILE" | tail -n 1)"
cp "$COMPOSE_FILE" "${deploy_tmp}/compose.previous.yaml"

echo "Pulling ${new_image}"
docker pull "$new_image"

container_id="$(docker create "$new_image")"
docker cp "${container_id}:/app/deploy/compose.production.yaml" "${deploy_tmp}/compose.production.yaml"
docker rm "$container_id" >/dev/null
container_id=""

install -o root -g root -m 0644 "${deploy_tmp}/compose.production.yaml" "$COMPOSE_FILE"
sed -i -E "s/^IMAGE_TAG=.*/IMAGE_TAG=${new_tag}/" "$ENV_FILE"

rollback_files() {
  install -o root -g root -m 0644 "${deploy_tmp}/compose.previous.yaml" "$COMPOSE_FILE"
  sed -i -E "s/^IMAGE_TAG=.*/IMAGE_TAG=${previous_tag}/" "$ENV_FILE"
}

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if ! "${compose[@]}" config --quiet; then
  rollback_files
  echo "Compose validation failed; deployment files restored." >&2
  exit 66
fi

"${compose[@]}" pull
"${compose[@]}" up -d postgres redis rsshub

postgres_ready=false
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  sleep 2
done
if [[ "$postgres_ready" != true ]]; then
  rollback_files
  echo "PostgreSQL did not become ready." >&2
  exit 67
fi

"${compose[@]}" run --rm --no-deps app node dist/db/migrate.js
"${compose[@]}" up -d app

app_ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error http://127.0.0.1:3000/ready >/dev/null; then
    app_ready=true
    break
  fi
  sleep 2
done

if [[ "$app_ready" != true ]]; then
  echo "New application failed readiness; restoring ${previous_tag}." >&2
  rollback_files
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d app || true
  exit 68
fi

printf '%s\n' "$commit" > "${APP_DIR}/.deployed-commit"
docker image prune -f --filter "until=168h" >/dev/null
echo "Deployment completed: ${new_tag}"
