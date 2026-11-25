# Federal holidays: the pharmacy page's list, the server and the Calendar page agree on the ids and on the dates in every year.
import sys, json, pathlib, subprocess, re
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; WEB = ROOT / "app" / "web"
ok = bad = 0
def check(n, got, want):
    global ok, bad
    if got == want: ok += 1; print("ok  ", n)
    else: bad += 1; print("FAIL", n, "got", str(got)[:300], "want", str(want)[:300])
YEARS = list(range(2021, 2051))
node = subprocess.run(["node", "--input-type=module", "-e", "import {fedDates, holidayClosed, FED_DEFAULT} from '%s'; const o={}; for(const y of %s) o[y]=fedDates(y); const c=(h,d)=>holidayClosed({holClosed:h},d); console.log(JSON.stringify({o, t:[c(null,'2026-11-26'), c(null,'2026-11-27'), c(['july4'],'2026-07-04'), c(['july4'],'2026-07-03'), c(['xmas'],'2027-12-25'), c(['xmas'],'2027-12-24'), c(['newyear'],'2023-01-02'), c(['newyear'],'2023-01-01'), c(['mlk'],'2027-01-18'), c([],'2026-11-26'), c(['columbus'],'2026-10-12'), c(['juneteenth'],'2020-06-19')]}))" % (ROOT / "app" / "lambda" / "index.mjs", json.dumps(YEARS))], capture_output=True, text=True, env={"PATH": "/usr/bin:/usr/local/bin:/bin", "TABLE": "x", "NODE_ENV": "test"})
if node.returncode: print(node.stderr[-600:]); sys.exit(2)
srv = json.loads(node.stdout.strip().splitlines()[-1])
with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("file://" + str(WEB / "calendar.html")); pg.wait_for_timeout(500)
    cal = pg.evaluate("(ys) => { const o = {}; ys.forEach(y => o[y] = US.fedList(y).map(x => [x[0], x[2]])); return {o, ids: US.HOLIDAY_IDS}; }", YEARS)
    b.close()
check("server and Calendar page give the same federal holiday dates, every year 2021-2050", {int(k): v for k, v in srv["o"].items()}, {int(k): v for k, v in cal["o"].items()})
panel = re.findall(r"\['(\w+)', \"?'?[^\]]*?\]", re.search(r"const FED_HOL = \[(.*?)\];", (WEB / "pharm_panels.js").read_text(), re.S).group(1))
check("the pharmacy page lists the same 11 holidays, in the same order", panel, cal["ids"])
d = {2026: dict(srv["o"]["2026"]), 2027: dict(srv["o"]["2027"])}
check("2026: Thanksgiving Nov 26, Columbus Oct 12, Labor Sep 7, Memorial May 25, Juneteenth Jun 19, July 4 Sat", (d[2026]["thanks"], d[2026]["columbus"], d[2026]["labor"], d[2026]["memorial"], d[2026]["juneteenth"], d[2026]["july4"]), ("2026-11-26", "2026-10-12", "2026-09-07", "2026-05-25", "2026-06-19", "2026-07-04"))
check("2027: Thanksgiving Nov 25, MLK Jan 18, Presidents Feb 15", (d[2027]["thanks"], d[2027]["mlk"], d[2027]["presidents"]), ("2027-11-25", "2027-01-18", "2027-02-15"))
check("no Juneteenth before 2021", "juneteenth" in dict(srv["o"]["2021"]), True)
t = srv["t"]
check("default closures: Thanksgiving closed, the day after open", t[0:2], ["thanks", ""])
check("Saturday holiday closes Saturday only (July 4 2026)", t[2:4], ["july4", ""])
check("Saturday Christmas 2027: closed Sat, Friday open", t[4:6], ["xmas", ""])
check("Sunday New Year 2023: closed the Monday after, and the Sunday", t[6:8], ["newyear", "newyear"])
check("MLK 2027 when ticked closes Jan 18", t[8], "mlk")
check("nothing ticked: nothing closed", t[9], "")
check("Columbus 2026 when ticked closes Oct 12", t[10], "columbus")
check("Juneteenth did not exist in 2020", t[11], "")
check("no page errors", errs, [])
print("pass=%d fail=%d" % (ok, bad)); sys.exit(1 if bad else 0)
