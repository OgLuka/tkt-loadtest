#!/usr/bin/env bash
# install-k6-ec2.sh — bootstrap a fresh Amazon Linux 2023 / Ubuntu EC2 box
# with k6 + the OS tunings needed to push tens of thousands of VUs.
#
# WITHOUT these tunings the box will hit "too many open files" or run out of
# ephemeral ports long before k6 itself becomes the bottleneck. Re-login
# after the limits change so the new ulimit takes effect.

set -euo pipefail

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
fi

echo "==> Installing k6"
if command -v dnf >/dev/null; then
  sudo dnf install -y https://dl.k6.io/rpm/repo.rpm
  sudo dnf install -y k6 jq
elif command -v yum >/dev/null; then
  sudo yum install -y https://dl.k6.io/rpm/repo.rpm
  sudo yum install -y k6 jq
elif command -v apt-get >/dev/null; then
  sudo gpg -k
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y k6 jq
else
  echo "Unsupported distro — install k6 manually from https://k6.io/docs/get-started/installation/" >&2
  exit 1
fi

echo "==> Raising ulimits (needed for >10k concurrent connections)"
sudo tee /etc/security/limits.d/k6.conf >/dev/null <<'EOF'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

echo "==> Tuning kernel for many outbound connections"
sudo tee /etc/sysctl.d/99-k6.conf >/dev/null <<'EOF'
# Bigger ephemeral port range
net.ipv4.ip_local_port_range = 1024 65535
# Reuse TIME_WAIT sockets quickly
net.ipv4.tcp_tw_reuse = 1
# Larger backlog for incoming SYN floods of replies
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
# More memory for socket buffers
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF
sudo sysctl --system >/dev/null

echo "==> Done. LOG OUT and back in for ulimits to apply, then verify:"
echo "    ulimit -n   # should report 1048576"
echo "    k6 version"
