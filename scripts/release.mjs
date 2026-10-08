import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const upstream = "ggml-org/whisper.cpp";
export const archives = ["whisper-bin-macos-arm64.tar.gz", "whisper-bin-macos-x64.tar.gz"];
export const assets = [...archives, "SHA256SUMS", "build.json"];
const sha256 = data => createHash("sha256").update(data).digest("hex");
const stable = release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name);

export function latestStable(releases) {
    const candidates = releases.filter(stable).sort((a, b) => {
        const av = a.tag_name.slice(1).split(".").map(Number);
        const bv = b.tag_name.slice(1).split(".").map(Number);
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
    });
    if (!candidates.length) throw new Error("No published stable whisper.cpp release was found.");
    return candidates[0];
}

export function complete(release) {
    return assets.every(name => release.assets.some(asset => asset.name === name && asset.size > 0
        && asset.state === "uploaded" && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")));
}

export async function listReleases(api, repository) {
    const result = [];
    for (let page = 1; ; page++) {
        const batch = await api(`/repos/${repository}/releases?per_page=100&page=${page}`);
        result.push(...batch);
        if (batch.length < 100) return result;
    }
}

export async function plan(api, { repository, tag = "", recipe }) {
    const latest = latestStable(await listReleases(api, upstream));
    if (tag && !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("whisper_tag must be a stable version such as v1.9.4.");
    const selected = tag ? await api(`/repos/${upstream}/releases/tags/${tag}`) : latest;
    if (!selected || !stable(selected)) throw new Error(`${tag} is not a published stable upstream release.`);
    const { sha: commit } = await api(`/repos/${upstream}/commits/${selected.tag_name}`);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Upstream did not resolve to a commit SHA.");
    const releaseTag = `native-whisper-${selected.tag_name}-${commit.slice(0, 12)}-${recipe.slice(0, 12)}`;
    const existing = await api(`/repos/${repository}/releases/tags/${releaseTag}`);
    if (existing && !existing.draft && (existing.prerelease || !complete(existing))) {
        throw new Error(`Published release ${releaseTag} is incomplete; investigate it before rebuilding with an updated recipe.`);
    }
    return {
        should_build: !existing || existing.draft,
        upstream_tag: selected.tag_name,
        commit,
        recipe,
        release_tag: releaseTag
    };
}

export async function publish(api, repository, source, files, builderCommit, runURL) {
    for (const name of archives) {
        if (!files[name]?.length) throw new Error(`Missing or empty archive: ${name}`);
    }
    const hashes = Object.fromEntries(archives.map(name => [name, sha256(files[name])]));
    files = {
        ...files,
        SHA256SUMS: Buffer.from(archives.map(name => `${hashes[name]}  ${name}`).join("\n") + "\n"),
        "build.json": Buffer.from(JSON.stringify({
            upstream: { repository: upstream, tag: source.upstream_tag, commit: source.commit },
            recipe: source.recipe,
            builder: { repository, commit: builderCommit, run: runURL },
            deploymentTarget: "13.3",
            metal: ["arm64"],
            sha256: hashes
        }, null, 2))
    };
    const base = `/repos/${repository}/releases`;
    let release = await api(`${base}/tags/${source.release_tag}`);
    if (release && !release.draft) throw new Error(`Refusing to overwrite published release ${source.release_tag}.`);
    const notes = [
        `Source: https://github.com/${upstream}/tree/${source.commit} (${source.upstream_tag}).`,
        "Built for macOS 13.3 or newer. arm64 includes Metal; x64 uses CPU backends.",
        "Both architectures passed upstream gh tests and an extracted-archive JSON smoke test using the test model.",
        "Archives include the CLI, runtime libraries and Whisper's MIT license. Models are not included.",
        "These packages are not Developer ID signed or notarized; application packaging handles distribution signing.",
        `Build recipe: ${source.recipe}. Build: ${runURL}.`
    ].join("\n\n");
    if (!release) {
        release = await api(base, { method: "POST", body: {
            tag_name: source.release_tag, target_commitish: builderCommit,
            name: `Whisper ${source.upstream_tag} for macOS`, body: notes,
            draft: true, prerelease: false, make_latest: "false"
        } });
    }
    // Retry partial uploads only while the release is a draft.
    for (const asset of release.assets) {
        if (assets.includes(asset.name)) await api(`${base}/assets/${asset.id}`, { method: "DELETE" });
    }
    for (const name of assets) {
        const url = `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`;
        await api(url, { method: "POST", data: files[name] });
    }
    const uploaded = await api(`${base}/${release.id}`);
    if (!uploaded.draft || !complete(uploaded)) throw new Error("The uploaded draft is incomplete; publication was stopped.");
    for (const name of assets) {
        const asset = uploaded.assets.find(asset => asset.name === name);
        if (asset.size !== files[name].length || asset.digest !== `sha256:${sha256(files[name])}`) {
            throw new Error(`Uploaded asset verification failed: ${name}`);
        }
    }
    // An older manual build must not replace the latest stable dependency.
    const latest = latestStable(await listReleases(api, upstream));
    await api(`${base}/${release.id}`, { method: "PATCH", body: {
        draft: false, prerelease: false, body: notes,
        make_latest: String(latest.tag_name === source.upstream_tag)
    } });
    console.log(`Published https://github.com/${repository}/releases/tag/${source.release_tag}`);
}

export async function api(path, { method = "GET", body, data } = {}) {
    const url = new URL(path, "https://api.github.com");
    if (!["api.github.com", "uploads.github.com"].includes(url.hostname)) throw new Error("Unexpected GitHub API host.");
    const response = await fetch(url, {
        method,
        headers: {
            Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "macos-whisper-cli-builder",
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
            ...(data ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {})
        },
        body: data ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(data ? 5 * 60_000 : 60_000)
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`${method} ${url.pathname}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Set GITHUB_REPOSITORY to owner/repo.");
    const command = process.argv[2];
    if (command === "check") {
        const hash = createHash("sha256");
        for (const path of [".github/workflows/build.yml", "scripts/build.sh", "scripts/release.mjs"]) {
            hash.update(path).update("\0").update(await readFile(new URL(`../${path}`, import.meta.url))).update("\0");
        }
        const result = await plan(api, { repository, tag: process.env.WHISPER_TAG ?? "", recipe: hash.digest("hex") });
        if (process.env.GITHUB_OUTPUT) {
            await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
        }
        const summary = `${result.should_build ? "Build required" : "Already published"}: ${result.upstream_tag} (${result.commit}), ${result.release_tag}`;
        console.log(summary);
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    }
    else if (command === "publish") {
        const source = {
            upstream_tag: process.env.WHISPER_TAG, commit: process.env.WHISPER_COMMIT,
            recipe: process.env.BUILD_RECIPE, release_tag: process.env.RELEASE_TAG
        };
        if (!/^v\d+\.\d+\.\d+$/.test(source.upstream_tag ?? "") || !/^[a-f0-9]{40}$/.test(source.commit ?? "")
            || !/^[a-f0-9]{64}$/.test(source.recipe ?? "")
            || source.release_tag !== `native-whisper-${source.upstream_tag}-${source.commit.slice(0, 12)}-${source.recipe.slice(0, 12)}`) {
            throw new Error("Invalid release source metadata.");
        }
        const files = Object.fromEntries(await Promise.all(archives.map(async name => [name, await readFile(resolve("release", name))])));
        await publish(api, repository, source, files, process.env.GITHUB_SHA,
            `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
    }
    else throw new Error("Usage: node scripts/release.mjs check|publish");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}