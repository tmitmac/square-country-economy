
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA, "automation-state.json");
const PUBLIC = path.join(ROOT, "public");

function readJSON(filename, fallback) {
    if (!fs.existsSync(filename)) return fallback;

    return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function saveJSON(filename, data) {
    const temporary = filename + ".tmp";

    fs.writeFileSync(
        temporary,
        JSON.stringify(data, null, 2) + "\n"
    );

    fs.renameSync(temporary, filename);
}

// Calendar date in New Zealand, including DST.
function nzDate() {
    const parts = new Intl.DateTimeFormat("en-NZ", {
        timeZone: "Pacific/Auckland",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const get = type =>
        parts.find(p => p.type === type).value;

    return `${get("year")}-${get("month")}-${get("day")}`;
}

function runScript(filename, args = [], timeout = 180000) {
    console.log(`\nRUNNING ${filename}`);
    console.log("--------------------------------");

    const result = spawnSync(
        process.execPath,
        [path.join(ROOT, filename), ...args],
        {
            cwd: ROOT,
            env: process.env,
            encoding: "utf8",
            timeout,
            maxBuffer: 10 * 1024 * 1024
        }
    );

    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);

    if (result.error || result.status !== 0) {
        throw new Error(
            `${filename} failed: ` +
            (result.error?.message ||
                `exit code ${result.status}`)
        );
    }
}

function publishData() {
    const publicData = path.join(PUBLIC, "data");

    fs.mkdirSync(publicData, { recursive: true });

    // Publish economic statistics, not administrative data.
    for (const filename of [
        "economy.json",
        "history.json",
        "national-accounts.json"
    ]) {
        const source = path.join(DATA, filename);

        if (!fs.existsSync(source)) {
            throw new Error(`Missing public file: ${filename}`);
        }

        fs.copyFileSync(
            source,
            path.join(publicData, filename)
        );
    }

    // Simple landing page for the data feed.
    fs.writeFileSync(
        path.join(PUBLIC, "index.html"),
        `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Square Country Economic Data</title>
</head>
<body>
<h1>Square Country Economic Data</h1>
<p>Automatically generated fictional economic statistics.</p>
<ul>
<li><a href="data/economy.json">Current statistics</a></li>
<li><a href="data/history.json">Economic history</a></li>
<li><a href="data/national-accounts.json">National accounts</a></li>
</ul>
</body>
</html>`
    );
}

function main() {
    const today = nzDate();

    const state = readJSON(STATE_FILE, {
        lastSimulationDate: null
    });

    console.log("SQUARE COUNTRY AUTOMATION");
    console.log("=========================");
    console.log("New Zealand date:", today);

    // Avoid advancing the economy more than once
    // on the same real-world calendar day.
    const alreadyUpdated =
        state.lastSimulationDate === today;

    if (!alreadyUpdated) {
        if (process.env.OPENAI_API_KEY) {
            // News failures must not prevent the
            // underlying economy from advancing.
            const tasks = [
                ["news-reader.js", [], 180000],
                ["news-analyse.js", [], 180000],
                ["news-impact.js", ["generate"], 240000]
            ];

            // News reader works without AI credentials,
            // but this sequence also requires the AI.
            for (const [file, args, timeout] of tasks) {
                try {
                    runScript(file, args, timeout);
                } catch (error) {
                    console.error("Warning:", error.message);
                }
            }
        } else {
            // Continue collecting news, but do not
            // attempt paid AI calls without a key.
            try {
                runScript("news-reader.js");
            } catch (error) {
                console.error("Warning:", error.message);
            }

            console.warn(
                "OPENAI_API_KEY missing. AI news processing skipped."
            );
        }

        // This is the authoritative daily simulation.
        // It must succeed before marking the day complete.
        runScript("simulate.js", [], 120000);

        state.lastSimulationDate = today;
        state.lastCompletedAt = new Date().toISOString();

        saveJSON(STATE_FILE, state);

        console.log("\nDaily economic update completed.");
    } else {
        console.log(
            "Economy already updated today. Skipping duplicate run."
        );
    }

    // Rebuild the public files on every workflow run,
    // even when the economy was already updated.
    publishData();

    console.log("Public economic data prepared.");
}

try {
    main();
} catch (error) {
    console.error("Automation failed:", error.message);
    process.exitCode = 1;
}
