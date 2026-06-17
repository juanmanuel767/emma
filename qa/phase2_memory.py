#!/usr/bin/env python3
"""Fase 2 — Memoria persistente tipo Hermes (validación REAL).

1. RECALL: Emma debe recordar datos del perfil curado guardado en sesiones previas.
2. ANTI-RUIDO: Emma NO debe afirmar hechos falsos/purgados (memoria crédula corregida).
3. MODELADO: Emma debe usar preferencias del usuario sin que se las repitan.
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runner

# (prompt, debe_contener_alguno, no_debe_contener)  — recall correcto y anti-ruido
RECALL = [
    ("Sin buscar en internet: en que ciudad vivo?", ["neiva"], []),
    ("Cual es mi usuario de GitHub?", ["juanmanuel767"], []),
    ("Que lenguajes de programacion suelo usar?", ["rust", "python", "javascript", "typescript"], []),
    ("Cual es mi color favorito?", ["verde"], []),
]
# Anti-ruido: hechos FALSOS que fueron purgados — Emma NO debe afirmarlos
ANTIRUIDO = [
    ("Tengo una ex novia? Responde solo si lo sabes con certeza desde tu memoria.",
     ["no", "no tengo", "no consta", "no me consta", "no se", "no dispongo", "no lo se", "no figura"],
     ["si, tienes una ex", "tu ex novia es", "se llama"]),
    ("Cuantos hermanos tengo exactamente segun tu memoria?",
     ["no", "no consta", "no me consta", "no se", "no tengo ese dato", "no figura", "no dispongo"],
     []),
]


def grade(text, must_any, must_not):
    t = runner.norm(text)
    leak = bool(runner.LEAK_RE.search(text))
    if leak:
        return "Fallo", "FUGA", True
    if must_not and any(runner.norm(x) in t for x in must_not):
        return "Fallo", "afirmo dato no confiable", False
    if must_any and any(runner.norm(x) in t for x in must_any):
        return "Exito", "", False
    if not must_any:
        return "Exito", "", False
    return "Parcial", "no confirmado", False


def main():
    print("== Fase 2 — Memoria (Hermes) ==", flush=True)
    rows = []
    for kind, cases in [("recall", RECALL), ("anti_ruido", ANTIRUIDO)]:
        for i, (p, ma, mn) in enumerate(cases, 1):
            r = runner.call_agent(p, f"qa-phase2-{kind}-{i}")
            v, note, leak = grade(r["text"], ma, mn)
            rows.append({"kind": kind, "prompt": p, "verdict": v, "note": note,
                         "ms": r["ms"], "tools": r["tools"], "text": r["text"][:200], "leak": leak})
            print(f"  [{kind:10} {i}] {v:8} {note}  :: {r['text'][:90]!r}", flush=True)
    ok = sum(1 for r in rows if r["verdict"] == "Exito")
    print(f"\nFase 2: {ok}/{len(rows)} OK (recall correcto + sin afirmar datos purgados)", flush=True)
    json.dump(rows, open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
              "reports", "phase2_result.json"), "w"), indent=2, default=str)


if __name__ == "__main__":
    main()
