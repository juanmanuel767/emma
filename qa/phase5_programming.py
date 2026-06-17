#!/usr/bin/env python3
"""Fase 5 — Emma como ingeniera de software (validación REAL).

Pide código a Emma vía /chat, extrae el bloque ```python y lo somete a 4 puertas:
ruff (lint), mypy (tipos), bandit (seguridad) y pytest (tests). Registra el resultado
real de cada puerta. No simula: ejecuta las herramientas y captura su salida.
"""
import os, re, sys, json, subprocess, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runner  # reutiliza call_agent

WORK = tempfile.mkdtemp(prefix="emma_phase5_")

TASKS = [
    {
        "id": "PROG-A", "kind": "crear_feature",
        "prompt": ("Escribe en Python una funcion `is_palindrome(s: str) -> bool` con type hints "
                   "que ignore mayusculas, espacios y signos de puntuacion. Incluye ademas una "
                   "funcion de test pytest llamada `test_is_palindrome` con al menos 3 asserts "
                   "(incluye 'A man, a plan, a canal: Panama'). Devuelve TODO en un unico bloque ```python."),
    },
    {
        "id": "PROG-B", "kind": "corregir_bug",
        "prompt": ("Este codigo Python tiene un bug (off-by-one, no incluye el ultimo elemento):\n"
                   "```python\ndef suma_hasta(n: int) -> int:\n    total = 0\n    for i in range(1, n):\n        total += i\n    return total\n```\n"
                   "Corrigelo para que sume de 1 hasta n INCLUSIVE, manten los type hints, y agrega una "
                   "funcion `test_suma_hasta` con pytest que verifique suma_hasta(5)==15. Todo en un bloque ```python."),
    },
    {
        "id": "PROG-C", "kind": "refactor_seguro",
        "prompt": ("Refactoriza esta funcion para que sea mas limpia y use type hints, SIN cambiar su "
                   "comportamiento:\n```python\ndef f(l):\n    r=[]\n    for x in l:\n        if x%2==0:\n            r.append(x*x)\n    return r\n```\n"
                   "Renombrala a `squares_of_evens(nums: list[int]) -> list[int]`. Agrega `test_squares_of_evens` "
                   "con pytest que compruebe squares_of_evens([1,2,3,4])==[4,16]. Todo en un unico bloque ```python."),
    },
]


def extract_code(text: str) -> str:
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    if not blocks:
        return ""
    return max(blocks, key=len).strip()


def gate(cmd, cwd):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=90)
        return p.returncode == 0, (p.stdout + p.stderr).strip()[:400]
    except Exception as e:
        return False, f"ERROR ejecutando: {e}"


def run_task(t):
    r = runner.call_agent(t["prompt"], f"qa-phase5-{t['id']}")
    code = extract_code(r["text"])
    res = {"id": t["id"], "kind": t["kind"], "ms": r["ms"], "tools": r["tools"],
           "code_extracted": bool(code), "gates": {}}
    if not code:
        res["error"] = "Emma no devolvio un bloque de codigo parseable"
        return res, r["text"]
    fpath = os.path.join(WORK, f"{t['id'].lower().replace('-', '_')}.py")
    with open(fpath, "w") as f:
        f.write(code + "\n")
    res["gates"]["ruff"]   = gate(["ruff", "check", fpath], WORK)
    res["gates"]["mypy"]   = gate(["uvx", "mypy", "--ignore-missing-imports", "--no-error-summary", fpath], WORK)
    # -s B101: el fichero mezcla función + tests pytest; los `assert` de los tests
    # disparan B101 (Low) y son legítimos en código de prueba. Se evalúa seguridad real.
    res["gates"]["bandit"] = gate(["uvx", "bandit", "-q", "-s", "B101", fpath], WORK)
    res["gates"]["pytest"] = gate(["python3", "-m", "pytest", "-q", fpath], WORK)
    return res, r["text"]


def main():
    print(f"== Fase 5 — Programacion (workdir {WORK}) ==", flush=True)
    out = []
    for t in TASKS:
        res, raw = run_task(t)
        gates = res.get("gates", {})
        line = " ".join(f"{g}={'OK' if v[0] else 'FALLO'}" for g, v in gates.items())
        print(f"  [{res['id']}] {res['kind']:16} code={res['code_extracted']} {line}  ({res['ms']}ms)", flush=True)
        for g, v in gates.items():
            if not v[0]:
                print(f"      ↳ {g}: {v[1][:160]}", flush=True)
        out.append(res)
    # resumen: una tarea "pasa" si las 4 puertas OK
    passed = sum(1 for r in out if r.get("gates") and all(v[0] for v in r["gates"].values()))
    print(f"\nFase 5: {passed}/{len(out)} tareas superan las 4 puertas (ruff/mypy/bandit/pytest)", flush=True)
    json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
              "reports", "phase5_result.json"), "w"), indent=2, default=str)


if __name__ == "__main__":
    main()
