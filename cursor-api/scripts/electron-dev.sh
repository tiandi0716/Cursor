#!/usr/bin/env zsh
set -euo pipefail
cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  set +u
  . "$NVM_DIR/nvm.sh"
  nvm use
  set -u
fi

echo "Node $(node -v)"
exec npm run desktop
