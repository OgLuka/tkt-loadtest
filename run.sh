#!/usr/bin/env bash
# run.sh — start k6 on a single EC2 node, parameterised for a distributed run.
#
# Distributed model: each EC2 node runs this script with a unique NODE_ID.
# Total VUs = PEAK_VUS_PER_NODE * NODE_COUNT.
#
# Sizing rule of thumb (c6i.4xlarge, 16 vCPU, 32 GB RAM):
#   * up to ~30k VUs for HTTP-only workload
#   * up to ~10k VUs when a chunk of them hold WS connections
# So for 150k landing-spike VUs you want roughly 5 c6i.4xlarge boxes.
# The released_buyers scenario is cheap (200/min) — let it run on node 1 only.
#
# Aggregation: each node writes its own summary JSON to ./results and
# pushes metrics live to InfluxDB / Prometheus via -o.
#
# Usage on each EC2:
#   ssh ec2-1$  ./run.sh 1 5 30000   # node 1 of 5, 30k VUs each
#   ssh ec2-2$  ./run.sh 2 5 30000
#   ...
# Start them within ~5 seconds of each other (use a tiny coordinator script,
# or pdsh, or AWS Systems Manager Run Command).

set -euo pipefail

NODE_ID="${1:-1}"
NODE_COUNT="${2:-1}"
PEAK_VUS="${3:-30000}"

# ---- required ----
: "${BASE_URL:?set BASE_URL e.g. https://www.tkt.ge}"
: "${EVENT_ID:?set EVENT_ID for the concert}"
: "${EVENT_SLUG:?set EVENT_SLUG for the concert URL slug}"

# ---- recommended ----
WS_URL="${WS_URL:-wss://ws.tkt.ge}"
KILL_SWITCH_URL="${KILL_SWITCH_URL:-}"
RUN_ID="${RUN_ID:-tkt-$(date -u +%Y%m%dT%H%M%SZ)}"

# Only node 1 runs the released_buyers scenario by default. Other nodes get
# rate=0 so they don't pile up duplicate buyers. Comment this out if you
# want every node to share the buyer load.
if [[ "$NODE_ID" != "1" ]]; then
  BUYER_RATE_PER_MIN="${BUYER_RATE_PER_MIN:-0}"
else
  BUYER_RATE_PER_MIN="${BUYER_RATE_PER_MIN:-200}"
fi

mkdir -p ./results
cd ./results

echo "==> Starting k6 — node ${NODE_ID}/${NODE_COUNT}, peak VUs=${PEAK_VUS}, run=${RUN_ID}"
echo "==> Target: ${BASE_URL}  WS: ${WS_URL}"
echo "==> Hit Ctrl-C OR set ${KILL_SWITCH_URL} body to STOP to abort the run."

# Output options:
#   --out json=...                    rolling JSON, easy to ship to S3
#   --out experimental-prometheus-rw  push live metrics to a Prometheus that
#                                     accepts remote-write (Grafana Cloud,
#                                     Mimir, Cortex, AMP)
# Pick one that matches your observability stack.

exec k6 run \
  --tag node="${NODE_ID}" \
  --tag run="${RUN_ID}" \
  -e BASE_URL="${BASE_URL}" \
  -e WS_URL="${WS_URL}" \
  -e EVENT_ID="${EVENT_ID}" \
  -e EVENT_SLUG="${EVENT_SLUG}" \
  -e NODE_ID="${NODE_ID}" \
  -e NODE_COUNT="${NODE_COUNT}" \
  -e PEAK_VUS="${PEAK_VUS}" \
  -e BUYER_RATE_PER_MIN="${BUYER_RATE_PER_MIN}" \
  -e KILL_SWITCH_URL="${KILL_SWITCH_URL}" \
  -e RUN_ID="${RUN_ID}" \
  --out json=raw-"${RUN_ID}"-node"${NODE_ID}".json.gz \
  ../loadtest.js
