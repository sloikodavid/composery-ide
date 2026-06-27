#!/usr/bin/env bash
set -euo pipefail

# Restart the container once when a runtime that was serving stops serving. A
# boot that never became healthy is left alone: restarting the same bad
# configuration for ever would be a loop, while the external health sweep can
# report and repair it with a bounded attempt policy.
#
# Under supervisor, PID 1 is supervisord and SIGTERM stops it. Under systemd,
# PID 1 re-execs on SIGTERM instead of stopping, so the manager's own "exit"
# operation is the stop there. The systemd profile checks only the units this
# image owns; cron runs as a packaged unit there and is not part of serving.
if [ -d /run/systemd/system ]; then
  runtime_ok() { systemctl is-active --quiet persistence ide caddy; }
else
  runtime_ok() {
    supervisorctl status persistence caddy ide cron 2>/dev/null |
      awk 'NF < 2 || $2 != "RUNNING" { bad = 1 } END { exit bad }'
  }
fi

was_healthy=false
failures=0

while sleep 10; do
  if runtime_ok \
    && curl -fsS "http://127.0.0.1:${PORT:-8080}/_composery/healthz" >/dev/null 2>&1; then
    was_healthy=true
    failures=0
    continue
  fi

  if [ "$was_healthy" = false ]; then
    continue
  fi

  failures=$((failures + 1))
  if [ "$failures" -lt 3 ]; then
    continue
  fi

  printf 'A previously healthy runtime failed three checks; restarting the container.\n' >&2
  if [ -d /run/systemd/system ]; then
    if ! systemctl exit; then
      # The exit failed. Stay on watch rather than exiting into a restart
      # loop, and try again after three more failures.
      failures=0
      continue
    fi
  else
    kill -TERM 1
  fi
  exit 1
done
