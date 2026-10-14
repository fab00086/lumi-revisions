#!/usr/bin/env bash
# ============================================================
#   Lumi - App revisions (remplace Lancer-Lumi.bat)
#   Node 22+ ; le navigateur s'ouvre automatiquement.
#   Pour arreter : Ctrl+C.
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "[ERREUR] Node.js non installe (>=22)." ; exit 1 ; }

# Pronote (devoirs auto) : verifier que Python + pronotepy sont en place.
SCRIPT_PRONOTE="scripts/pronote-devoirs.py"
if [ -f "$SCRIPT_PRONOTE" ]; then
  PY="$HOME/Projets/lumi-pronote-venv/bin/python"
  if [ ! -x "$PY" ]; then
    if [ -f /usr/bin/python3 ]; then PY=/usr/bin/python3 ; fi
  fi
  if ! "$PY" -c "import pronotepy" >/dev/null 2>&1; then
    echo "  [INFO] Pronote (devoirs auto) : Python+pronotepy manquant."
    echo "         Installer avec :  python3 -m venv ~/Projets/lumi-pronote-venv && ~/Projets/lumi-pronote-venv/bin/pip install pronotepy"
  fi
fi

echo "  ========================================"
echo "     Bienvenue dans Lumi  :)"
echo "  ========================================"
echo "  Le navigateur va s'ouvrir tout seul."
echo "  Laisse cette fenetre ouverte pendant que tu utilises Lumi."
echo "  Pour arreter : Ctrl+C."
node server.js