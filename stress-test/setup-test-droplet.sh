#!/bin/bash
# Provisions a $6/mo Digital Ocean droplet, clones volunteer-golf from GitHub
# (data.json is included via the auto-backup commits), starts the app on
# port 3001, and prints the IP to point k6 at.
# Run from the prod droplet: bash /root/volunteer-golf/stress-test/setup-test-droplet.sh

set -euo pipefail

NAME="volunteer-golf-stresstest"
REGION="sfo3"
SIZE="s-1vcpu-1gb"        # $6/mo, prorated by the hour
IMAGE="ubuntu-22-04-x64"
SSH_KEY_FINGERPRINTS=$(/usr/local/bin/doctl compute ssh-key list --format FingerPrint --no-header | tr '\n' ',' | sed 's/,$//')

if [ -z "$SSH_KEY_FINGERPRINTS" ]; then
  echo "ERROR: no SSH keys on the DO account. Add one in DO console first." >&2
  exit 1
fi

PROD_PUBKEY=$(cat /root/.ssh/id_ed25519.pub)

# Cloud-init: install node 20, k6, clone repo, run server on port 3001.
# Adds the prod droplet's public key so we can SSH in to run tests.
cat > /tmp/cloud-init.yaml <<YAML
#cloud-config
package_update: true
packages:
  - git
  - curl
  - gnupg
ssh_authorized_keys:
  - ${PROD_PUBKEY}
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
  - echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" > /etc/apt/sources.list.d/k6.list
  - apt-get update && apt-get install -y k6
  - npm install -g pm2
  - cd /root && git clone https://github.com/hennanneh/volunteer-golf.git
  - cd /root/volunteer-golf && npm ci
  - cd /root/volunteer-golf && PORT=3001 STRICT_AUTH=false pm2 start server.js --name volunteer-golf
  - pm2 save
  - touch /root/cloud-init-done
YAML

echo "Creating droplet $NAME (size=$SIZE region=$REGION)..."
/usr/local/bin/doctl compute droplet create "$NAME" \
  --region "$REGION" \
  --size "$SIZE" \
  --image "$IMAGE" \
  --ssh-keys "$SSH_KEY_FINGERPRINTS" \
  --user-data-file /tmp/cloud-init.yaml \
  --wait \
  --format ID,Name,PublicIPv4,Status

IP=$(/usr/local/bin/doctl compute droplet get "$NAME" --format PublicIPv4 --no-header)
echo
echo "Droplet IP: $IP"
echo "Cloud-init still running — wait ~3 min for the app + k6 to install."
echo
echo "Check readiness:"
echo "  curl http://$IP:3001/api/data -m 3 | head -c 200"
echo
echo "Run a test (from this droplet):"
echo "  ssh root@$IP 'BASE_URL=http://127.0.0.1:3001 k6 run /root/volunteer-golf/stress-test/smoke.js'"
echo
echo "Tear down when done:"
echo "  bash /root/volunteer-golf/stress-test/destroy-test-droplet.sh"
