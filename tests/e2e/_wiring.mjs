// Install the real wiring table into a headless (Node, no browser) model test.
//
// GraphModel derives every ref site, picker and gateable check from the server's wiring table
// (src/oc/profile/wiring.py), which the browser fetches at boot from /api/wiring. A Node test has
// no fetch and no server, so it reads the table straight out of Python — the SAME rows, not a
// hand-copied fixture, which is the whole point of having one table. A drifted table therefore
// fails these tests too, not just the Python ones.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setWiring } from "../../src/oc/web/static/js/graph/wiring.js";

const PY = existsSync(".venv/Scripts/python.exe") ? ".venv/Scripts/python.exe" : "python";

export function loadWiring() {
    const out = execFileSync(PY, ["-c",
        "import json, oc.profile.wiring as w; print(json.dumps(w.as_dict()))"],
    { encoding: "utf-8", env: { ...process.env, PYTHONPATH: "src" } });
    setWiring(JSON.parse(out));
}
