/**
 * One-off helper: pushes the whole project to GitHub via the Git Data API
 * (api.github.com), used when github.com:443 (git-over-HTTPS) is unreachable
 * but the API host is. Creates a single commit on refs/heads/main.
 */
import {readFileSync, readdirSync, statSync} from "node:fs";
import {execSync} from "node:child_process";
import {join, relative, sep} from "node:path";

const OWNER = "BUGdefender404";
const REPO = "pencil-annotation";
const BRANCH = "main";
const IGNORE = new Set([".git", "node_modules", "build", "package.zip"]);

const token = execSync("gh auth token").toString().trim();
const api = async (path, opts = {}) => {
    const res = await fetch(`https://api.github.com${path}`, {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(opts.headers || {}),
        },
    });
    if (!res.ok && res.status !== 404 && res.status !== 409) {
        throw new Error(`${opts.method || "GET"} ${path} → ${res.status}: ${await res.text()}`);
    }
    return (res.status === 404 || res.status === 409) ? null : res.json();
};

// collect tracked files (mirrors .gitignore)
const files = [];
const walk = (dir) => {
    for (const name of readdirSync(dir)) {
        if (IGNORE.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
    }
};
walk(".");
console.log(`collecting ${files.length} files`);

// 0) seed: the Git Data API rejects blobs on an empty repository, so create
//    the first commit (README.md) via the Contents API to materialize main
const ref0 = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
if (!ref0) {
    console.log("empty repo — seeding initial commit via Contents API");
    await api(`/repos/${OWNER}/${REPO}/contents/README.md`, {
        method: "PUT",
        body: JSON.stringify({
            message: "init",
            content: Buffer.from(readFileSync("README.md")).toString("base64"),
        }),
    });
}

// 1) blobs (in chunks)
const tree = [];
for (let i = 0; i < files.length; i += 8) {
    const chunk = files.slice(i, i + 8);
    const shas = await Promise.all(chunk.map(async (f) => {
        const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({content: readFileSync(f).toString("base64"), encoding: "base64"}),
        });
        return {path: relative(".", f).split(sep).join("/"), mode: "100644", type: "blob", sha: blob.sha};
    }));
    tree.push(...shas);
    console.log(`blobs ${Math.min(i + 8, files.length)}/${files.length}`);
}

// 2) tree
const treeData = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({tree}),
});
console.log(`tree ${treeData.sha}`);

// 3) commit
const commitData = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
        message: "Pencil Annotation v0.1.0: Apple Pencil handwriting annotation layer for SiYuan",
        tree: treeData.sha,
    }),
});
console.log(`commit ${commitData.sha}`);

// 4) point main at the commit (create or update)
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
if (ref) {
    await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
        method: "PATCH",
        body: JSON.stringify({sha: commitData.sha, force: true}),
    });
} else {
    await api(`/repos/${OWNER}/${REPO}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ref: `refs/heads/${BRANCH}`, sha: commitData.sha}),
    });
}
console.log(`pushed to ${OWNER}/${REPO}@${BRANCH}`);
