
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { analyseEvent } = require("./ai-analyse");

const PORT = 3000;
const ROOT = __dirname;
const EVENTS_FILE = path.join(ROOT, "data", "events.json");

const files = {
    "/": ["dashboard.html", "text/html; charset=utf-8"],
    "/events.html": ["events.html", "text/html; charset=utf-8"],
    "/news.html": ["news.html", "text/html; charset=utf-8"],
    "/data/economy.json": [
        "data/economy.json",
        "application/json"
    ],
    "/data/history.json": [
        "data/history.json",
        "application/json"
    ]
};

const allowedEffects = new Set([
    "gdpGrowth",
    "inflation",
    "unemployment",
    "governmentRevenue",
    "governmentExpenditure",
    "exports",
    "imports"
]);

let running = false;


let newsBusy = false;

const NEWS_FILE = path.join(ROOT, "data", "news.json");
const REVIEWS_FILE = path.join(ROOT, "data", "news-reviews.json");
const PROPOSALS_FILE = path.join(ROOT, "data", "news-proposals.json");

function readNewsJSON(filename, fallback) {
    if (!fs.existsSync(filename)) return fallback;

    return JSON.parse(
        fs.readFileSync(filename, "utf8")
    );
}

function runNewsCommand(args) {
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [path.join(ROOT, "news-impact.js"), ...args],
            {
                cwd: ROOT,
                timeout: 240000,
                maxBuffer: 1024 * 1024,
                env: process.env
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(
                        (stderr || stdout || error.message)
                            .slice(0, 1500)
                    ));
                    return;
                }

                resolve(stdout);
            }
        );
    });
}


function sendJSON(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

function readEvents() {
    if (!fs.existsSync(EVENTS_FILE)) {
        return { events: [] };
    }

    const data = JSON.parse(
        fs.readFileSync(EVENTS_FILE, "utf8")
    );

    if (!Array.isArray(data.events)) {
        throw new Error("Invalid events.json structure.");
    }

    return data;
}

function saveEvents(data) {
    // Write to a temporary file, then replace the original.
    const temp = EVENTS_FILE + ".tmp";

    fs.writeFileSync(
        temp,
        JSON.stringify(data, null, 2) + "\n"
    );

    fs.renameSync(temp, EVENTS_FILE);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;

        req.on("data", chunk => {
            size += chunk.length;

            if (size > 20000) {
                reject(new Error("Request too large."));
                req.destroy();
                return;
            }

            body += chunk.toString();
        });

        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON request."));
            }
        });

        req.on("error", reject);
    });
}

function validateEvent(data) {
    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
    ) {
        throw new Error("Invalid event.");
    }

    if (
        typeof data.title !== "string" ||
        !data.title.trim() ||
        data.title.length > 160
    ) {
        throw new Error("Provide an event title (maximum 160 characters).");
    }

    if (
        typeof data.description !== "string" ||
        !data.description.trim() ||
        data.description.length > 5000
    ) {
        throw new Error("Provide a description (maximum 5000 characters).");
    }

    if (
        !data.effects ||
        typeof data.effects !== "object" ||
        Array.isArray(data.effects)
    ) {
        throw new Error("Invalid economic effects.");
    }

    const entries = Object.entries(data.effects);

    if (entries.length === 0) {
        throw new Error("At least one economic effect is required.");
    }

    for (const [key, value] of entries) {
        if (
            !allowedEffects.has(key) ||
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value === 0
        ) {
            throw new Error("Invalid effect: " + key);
        }

        // Restrict extreme inputs during prototype testing.
        const limit = [
            "gdpGrowth", "inflation", "unemployment"
        ].includes(key) ? 20 : 1e12;

        if (Math.abs(value) > limit) {
            throw new Error("Effect exceeds test limit: " + key);
        }
    }

    return {
        id: crypto.randomUUID(),
        title: data.title.trim(),
        description: data.description.trim(),
        status: "pending",
        effects: data.effects,
        createdAt: new Date().toISOString()
    };
}

const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    // Block cross-site write requests.
    if (
        ["POST", "DELETE"].includes(req.method) &&
        req.headers.origin &&
        ![
            `http://localhost:${PORT}`,
            `http://127.0.0.1:${PORT}`
        ].includes(req.headers.origin)
    ) {
        return sendJSON(res, 403, {
            error: "Cross-origin requests are not allowed."
        });
    }

    try {

        // News dashboard data
        if (
            req.method === "GET" &&
            req.url === "/api/news-dashboard"
        ) {
            const news = readNewsJSON(
                NEWS_FILE, { articles: [] }
            );

            const reviews = readNewsJSON(
                REVIEWS_FILE, { reviews: [] }
            );

            const proposals = readNewsJSON(
                PROPOSALS_FILE, { proposals: [] }
            );

            if (
                !Array.isArray(news.articles) ||
                !Array.isArray(reviews.reviews) ||
                !Array.isArray(proposals.proposals)
            ) {
                throw new Error("Invalid news data files.");
            }

            return sendJSON(res, 200, {
                articles: news.articles,
                reviews: reviews.reviews,
                proposals: proposals.proposals,
                newsBusy
            });
        }

        // Generate new AI economic impact proposals
        if (
            req.method === "POST" &&
            req.url === "/api/news/generate"
        ) {
            if (running || newsBusy) {
                return sendJSON(res, 409, {
                    error: "Another operation is running."
                });
            }

            newsBusy = true;

            try {
                const output = await runNewsCommand([
                    "generate"
                ]);

                return sendJSON(res, 200, {
                    success: true,
                    output
                });
            } finally {
                newsBusy = false;
            }
        }

        // Approve or reject an AI news proposal
        if (
            req.method === "POST" &&
            req.url === "/api/news/decision"
        ) {
            if (running || newsBusy) {
                return sendJSON(res, 409, {
                    error: "Another operation is running."
                });
            }

            newsBusy = true;

            try {
                const body = await readBody(req);

                if (
                    !body ||
                    typeof body.id !== "string" ||
                    !/^news-[a-f0-9]{20}$/.test(body.id) ||
                    !["approve", "reject"].includes(body.decision)
                ) {
                    return sendJSON(res, 400, {
                        error: "Invalid proposal or decision."
                    });
                }

                const output = await runNewsCommand([
                    body.decision,
                    body.id
                ]);

                return sendJSON(res, 200, {
                    success: true,
                    output
                });
            } finally {
                newsBusy = false;
            }
        }


        // Read event history
        if (req.method === "GET" && req.url === "/api/events") {
            return sendJSON(res, 200, readEvents());
        }


        // Analyse an event with OpenAI without saving it.
        if (
            req.method === "POST" &&
            req.url === "/api/analyse"
        ) {
            if (running) {
                return sendJSON(res, 409, {
                    error: "Wait until the simulation finishes."
                });
            }

            const body = await readBody(req);

            if (
                !body ||
                typeof body.title !== "string" ||
                typeof body.description !== "string" ||
                !body.title.trim() ||
                !body.description.trim() ||
                body.title.length > 160 ||
                body.description.length > 5000
            ) {
                return sendJSON(res, 400, {
                    error: "Enter a valid title and description."
                });
            }

            // Both fields are sent to the economic analyst.
            // The model receives current figures from economy.json.
            const description =
                `${body.title.trim()}\n\n${body.description.trim()}`;

            const analysis = await analyseEvent(description);

            return sendJSON(res, 200, {
                success: true,
                analysis
            });
        }


        // Create an event
        if (req.method === "POST" && req.url === "/api/events") {
            if (running) {
                return sendJSON(res, 409, {
                    error: "Simulation is currently running."
                });
            }

            const body = await readBody(req);
            const event = validateEvent(body);

            const data = readEvents();
            data.events.push(event);

            saveEvents(data);

            return sendJSON(res, 201, {
                success: true,
                event
            });
        }

        // Delete an event that has not yet been applied
        if (
            req.method === "DELETE" &&
            req.url.startsWith("/api/events/")
        ) {
            if (running) {
                return sendJSON(res, 409, {
                    error: "Simulation is currently running."
                });
            }

            const id = decodeURIComponent(
                req.url.slice("/api/events/".length)
            );

            const data = readEvents();
            const event = data.events.find(e => e.id === id);

            if (!event) {
                return sendJSON(res, 404, {
                    error: "Event not found."
                });
            }

            if (event.status !== "pending") {
                return sendJSON(res, 409, {
                    error: "Applied events cannot be deleted."
                });
            }

            data.events = data.events.filter(e => e.id !== id);
            saveEvents(data);

            return sendJSON(res, 200, {
                success: true
            });
        }

        // Existing simulation endpoint
        if (req.method === "POST" && req.url === "/simulate") {
        if (running || newsBusy) {
                return sendJSON(res, 409, {
                    error: "Simulation already running."
                });
            }

            running = true;

            execFile(
                process.execPath,
                [path.join(ROOT, "simulate.js")],
                { cwd: ROOT, timeout: 30000 },
                (error, stdout, stderr) => {
                    running = false;

                    if (error) {
                        return sendJSON(res, 500, {
                            error: stderr || error.message
                        });
                    }

                    res.writeHead(200, {
                        "Content-Type": "text/plain"
                    });
                    res.end(stdout);
                }
            );

            return;
        }

        // Serve only the explicitly permitted files.
        if (req.method !== "GET" || !files[req.url]) {
            return sendJSON(res, 404, {
                error: "Not found."
            });
        }

        const [filename, contentType] = files[req.url];

        fs.readFile(path.join(ROOT, filename), (error, data) => {
            if (error) {
                return sendJSON(res, 500, {
                    error: "Could not load file."
                });
            }

            res.writeHead(200, {
                "Content-Type": contentType
            });

            res.end(data);
        });

    } catch (error) {
        console.error(error);

        return sendJSON(res, 400, {
            error: error.message
        });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(
        `Square Country Dashboard: http://localhost:${PORT}`
    );
});
