#!/usr/bin/env bash
# ============================================================
#   Savika - App revisions (remplace Lancer-Lumi.bat)
#   Node 22+ ; le navigateur s'ouvre automatiquement.
#   Pour arreter : Ctrl+C.
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "[ERREUR] Node.js non installe (>=22)." ; exit 1 ; }

echo "  ========================================"
echo "     Bienvenue dans Savika  :)"
echo "  ========================================"
echo "  Le navigateur va s'ouvrir tout seul."
echo "  Laisse cette fenetre ouverte pendant que tu utilises Lumi."
echo "  Pour arreter : Ctrl+C."
node server.js