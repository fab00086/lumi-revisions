#!/usr/bin/env python3
"""
Lumi <-> Pronote : recupere le cahier de textes (les devoirs a faire).

Configuration par variables d'environnement (mises dans .env de Lumi) :
  PRONOTE_URL      ex. https://xxx.index-education.net/pronote/eleve.html
  PRONOTE_USERNAME identifiant eleve
  PRONOTE_PASSWORD mot de passe pronote
  PRONOTE_DAYS     nombre de jours a couvrir (defaut 7)

Sortie : JSON sur stdout.
  {"ok": true, "jours": [{"date": "2026-10-12", "devoirs": [{"matiere":..., "description":..., "fait":..., "fichiers":[{"nom":...,"url":...}]}]}]}
Erreurs : {"ok": false, "error": "..."} et code de sortie 1.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta


def sortie(payload: dict, code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def main() -> None:
    url = os.environ.get("PRONOTE_URL", "").strip()
    username = os.environ.get("PRONOTE_USERNAME", "").strip()
    password = os.environ.get("PRONOTE_PASSWORD", "")
    try:
        jours = int(os.environ.get("PRONOTE_DAYS", "7") or 7)
    except ValueError:
        jours = 7

    if not (url and username and password):
        sortie({"ok": False, "error": "Pronote non configure (PRONOTE_URL / PRONOTE_USERNAME / PRONOTE_PASSWORD dans .env)"}, 1)

    import pronotepy  # venv-pronote

    client = pronotepy.Client(url, username=username, password=password)
    # Verifie vraiment la session (la connexion peut se terminer par un captcha)
    if client.logged_in is False:
        sortie({"ok": False, "error": "Connexion Pronote refusee (identifiants ou captcha : teste le site Pronote a la main)"}, 1)

    debut = date.today()
    fin = debut + timedelta(days=max(1, jours))
    devoirs = client.homework(debut, fin)

    par_jour = {}
    for d in devoirs:
        try:
            cle = d.date.isoformat()
        except Exception:
            continue
        matiere = ""
        subj = getattr(d, "subject", None)
        if subj is not None:
            matiere = getattr(subj, "name", "") or ""
        fichiers = []
        for f in (d.files or []):
            try:
                fichiers.append({
                    "nom": getattr(f, "name", "") or "pièce jointe",
                    "url": getattr(f, "url", "") or ""
                })
            except Exception:
                continue
        entree = {
            "matiere": matiere or "Matière",
            "description": (d.description or "").strip(),
            "fait": bool(d.done),
            "fichiers": fichiers,
        }
        par_jour.setdefault(cle, []).append(entree)

    jours_out = [
        {"date": k, "devoirs": v}
        for k, v in sorted(par_jour.items())[: max(1, jours)]
    ]
    sortie({"ok": True, "fetchTs": datetime.now().isoformat(timespec="seconds"),
            "jours": jours_out})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # reseau, captcha, identifiants, HTML...
        msg = str(e)
        lower = msg.lower()
        if "captcha" in lower:
            msg = "Pronote demande un captcha : ouvre le site Pronote une fois puis retente."
        elif "password" in lower or "login" in lower or "identif" in lower:
            msg = "Identifiants Pronote refusés."
        sortie({"ok": False, "error": msg[:300]}, 1)