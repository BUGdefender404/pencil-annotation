// Unit-test smoothDense (bundled to CJS via esbuild).
const {smoothDense} = require("./geometry-cjs.cjs");
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("PASS", name); }
    else { fail++; console.log("FAIL", name, extra ?? ""); }
};

// sparse stroke (snapped 5-point rect) must pass through untouched
const rect = [[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]].map(([x, y]) => ({x, y, p: 0.5}));
const r1 = smoothDense(rect);
check("sparse rect untouched", r1 === rect || (r1.length === rect.length &&
    r1.every((p, i) => p.x === rect[i].x && p.y === rect[i].y)));

// dense stroke gets smoothed: a single outlier is pulled toward its neighbors
const line = [];
for (let i = 0; i < 30; i++) line.push({x: i * 10, y: 0, p: 0.5});
line[15].y = 12; // jitter spike
const r2 = smoothDense(line);
check("dense stroke smoothed", Math.abs(r2[15].y) < 5 && Math.abs(r2[15].y) > 0,
    `y=${r2[15].y}`);
check("endpoints kept", r2[0].y === 0 && r2[r2.length - 1].y === 0);
check("count kept", r2.length === line.length);

// under the threshold nothing changes
const short = line.slice(0, 11);
check("below minCount untouched", smoothDense(short) === short);

console.log(`[total] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
