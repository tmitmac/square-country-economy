
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { analyseEvent } = require("./ai-analyse");

const DATA = path.join(__dirname, "data");

const NEWS_FILE = path.join(DATA, "news.json");
const REVIEWS_FILE = path.join(DATA, "news-reviews.json");
const PROPOSALS_FILE = path.join(DATA, "news-proposals.json");
const EVENTS_FILE = path.join(DATA, "events.json");

const MAX_PER_RUN = 3;

const INDICATORS = [
    "gdpGrowth",
    "inflation",
    "unemployment",
    "governmentRevenue",
    "governmentExpenditure",
    "exports",
    "imports"
];

function readJSON(file, fallback) {
    if (!fs.existsSync(file)) return fallback;

    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJSON(file, data) {
    const temporary = file + ".tmp";

    fs.writeFileSync(
        temporary,
        JSON.stringify(data, null, 2) + "\n"
    );

    fs.renameSync(temporary, file);
}

function getProposals() {
    const data = readJSON(PROPOSALS_FILE, {
        proposals: []
    });

    if (!Array.isArray(data.proposals)) {
        throw new Error("Invalid news-proposals.json");
    }

    return data;
}

function proposalId(articleId) {
    return "news-" + crypto
        .createHash("sha256")
        .update(articleId)
        .digest("hex")
        .slice(0, 20);
}

function validateEffects(effects) {
    if (!effects || typeof effects !== "object") {
        throw new Error("Invalid effects.");
    }

    for (const key of INDICATORS) {
        const value = effects[key];

        const limit = [
            "gdpGrowth",
            "inflation",
            "unemployment"
        ].includes(key) ? 20 : 1e12;

        if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            Math.abs(value) > limit
        ) {
            throw new Error(
                "Invalid effect for " + key
            );
        }
    }
}

function getDevelopments() {
    const news = readJSON(NEWS_FILE, { articles: [] });
    const reviews = readJSON(REVIEWS_FILE, {
        reviews: []
    });

    if (
        !Array.isArray(news.articles) ||
        !Array.isArray(reviews.reviews)
    ) {
        throw new Error("Invalid news data.");
    }

    const articlesById = new Map(
        news.articles.map(article => [
            article.id,
            article
        ])
    );

    const reviewsById = new Map(
        reviews.reviews.map(review => [
            review.articleId,
            review
        ])
    );

    // Follow references to the original reviewed article.
    function getRoot(articleId) {
        let current = articleId;
        const visited = new Set();

        while (true) {
            if (visited.has(current)) {
                throw new Error(
                    "Circular duplicate reference: " + current
                );
            }

            visited.add(current);

            const review = reviewsById.get(current);

            if (!review || !review.duplicateOf) {
                return current;
            }

            current = review.duplicateOf;
        }
    }

    const groups = new Map();

    for (const review of reviews.reviews) {
        if (!["high", "medium"].includes(review.relevance)) {
            continue;
        }

        const root = getRoot(review.articleId);

        if (!groups.has(root)) {
            groups.set(root, {
                rootId: root,
                articles: [],
                reviews: [],
                importance: "medium"
            });
        }

        const group = groups.get(root);

        if (review.relevance === "high") {
            group.importance = "high";
        }

        group.reviews.push(review);

        const article = articlesById.get(review.articleId);

        if (article) {
            group.articles.push(article);
        }
    }

    // Highest relevance first.
    return [...groups.values()]
        .filter(group => group.articles.length > 0)
        .sort((a, b) => {
            if (a.importance === b.importance) return 0;
            return a.importance === "high" ? -1 : 1;
        });
}

function printProposal(proposal) {
    console.log("\n------------------------------------");
    console.log("ID:", proposal.id);
    console.log("EVENT:", proposal.title);
    console.log("STATUS:", proposal.status);
    console.log("RELEVANCE:", proposal.importance);

    console.log("\nAI Summary:");
    console.log(proposal.summary);

    console.log("\nEconomic Reasoning:");
    console.log(proposal.reasoning);

    console.log("\nProposed Economic Effects:");

    const display = {};

    for (const key of INDICATORS) {
        const value = proposal.effects[key];

        if ([
            "governmentRevenue",
            "governmentExpenditure",
            "exports",
            "imports"
        ].includes(key)) {
            display[key] =
                (value / 1e9).toFixed(3) + " SC$ billion";
        } else {
            display[key] = value + " percentage points";
        }
    }

    console.table(display);

    console.log("Source URLs:");

    for (const article of proposal.sources) {
        console.log("-", article.url);
    }

    console.log("------------------------------------");
}

async function generateProposals() {
    const developments = getDevelopments();
    const database = getProposals();

    const existingIds = new Set(
        database.proposals.map(p => p.id)
    );

    const candidates = developments.filter(
        group => !existingIds.has(
            proposalId(group.rootId)
        )
    ).slice(0, MAX_PER_RUN);

    if (candidates.length === 0) {
        console.log(
            "No new economic developments to analyse."
        );
        return;
    }

    console.log(
        `Found ${candidates.length} new developments.`
    );

    for (const group of candidates) {
        const id = proposalId(group.rootId);

        const sources = group.articles.map(article => ({
            title: article.title,
            url: article.url,
            source: article.source,
            publishedAt: article.publishedAt,
            summary: article.description || ""
        }));

        const name = group.reviews.find(
            review => review.eventName
        )?.eventName || sources[0].title;

        console.log("\nAnalysing:", name);

        // Use only news metadata and summaries
        // already collected by the news reader.
        const description = JSON.stringify({
            title: name,
            sourceType: "International news",
            evidenceLevel:
                "Headlines and RSS summaries only",
            caution:
                "Do not assume the full articles have " +
                "been verified. Use zero for uncertain " +
                "effects. Avoid inventing fiscal measures.",
            articles: sources.slice(0, 8).map(article => ({
                title: article.title,
                summary: article.summary.slice(0, 800),
                source: article.source,
                publishedAt: article.publishedAt
            }))
        });

        const analysis = await analyseEvent(description);

        validateEffects(analysis.effects);

        const proposal = {
            id,
            rootArticleId: group.rootId,
            title: name,
            importance: group.importance,
            summary: analysis.summary,
            reasoning: analysis.reasoning,
            effects: analysis.effects,
            sources,
            status: "pending_review",
            createdAt: new Date().toISOString(),
            reviewedAt: null
        };

        database.proposals.push(proposal);

        // Save each completed proposal so an API failure
        // does not discard previous successful analyses.
        saveJSON(PROPOSALS_FILE, database);

        console.log("Proposal saved:", id);
    }

    console.log(
        "\nFinished. No economic events were applied."
    );
}

function listProposals() {
    const database = getProposals();

    if (database.proposals.length === 0) {
        console.log("No proposals found.");
        return;
    }

    const pending = database.proposals.filter(
        p => p.status === "pending_review"
    );

    console.log(
        `\nPending proposals: ${pending.length}`
    );

    for (const proposal of pending) {
        printProposal(proposal);
    }

    if (pending.length === 0) {
        console.log("All proposals have been reviewed.");
    }
}

function reviewProposal(id, decision) {
    const database = getProposals();

    const proposal = database.proposals.find(
        item => item.id === id
    );

    if (!proposal) {
        throw new Error("Proposal not found.");
    }

    if (proposal.status !== "pending_review") {
        throw new Error(
            "This proposal has already been reviewed."
        );
    }

    if (decision === "reject") {
        proposal.status = "rejected";
        proposal.reviewedAt = new Date().toISOString();

        saveJSON(PROPOSALS_FILE, database);

        console.log("Proposal rejected:", id);
        return;
    }

    validateEffects(proposal.effects);

    const effects = Object.fromEntries(
        Object.entries(proposal.effects)
            .filter(([, value]) => value !== 0)
    );

    if (Object.keys(effects).length === 0) {
        throw new Error(
            "The AI proposed no economic changes. " +
            "Reject this proposal instead."
        );
    }

    const eventData = readJSON(EVENTS_FILE, {
        events: []
    });

    if (!Array.isArray(eventData.events)) {
        throw new Error("Invalid events.json");
    }

    // Check existing event IDs to prevent the same
    // approved proposal being added twice.
    const existingEvent = eventData.events.find(
        event => event.id === proposal.id
    );

    if (!existingEvent) {
        eventData.events.push({
            id: proposal.id,
            title: proposal.title,
            description:
                proposal.summary + "\n\n" +
                proposal.reasoning + "\n\n" +
                "Sources:\n" +
                proposal.sources.map(
                    s => s.url
                ).join("\n"),
            status: "pending",
            effects,
            sourceType: "international_news",
            createdAt: new Date().toISOString()
        });

        // Write the event before finalising approval.
        // Retrying after an interrupted write will not
        // create a second event with the same ID.
        saveJSON(EVENTS_FILE, eventData);
    }

    proposal.status = "approved";
    proposal.reviewedAt = new Date().toISOString();

    saveJSON(PROPOSALS_FILE, database);

    console.log("\nEconomic event approved:", id);
    console.log("Saved to data/events.json");

    console.log(
        "It will be applied on the next simulation run."
    );
}

async function main() {
    const [command, id] = process.argv.slice(2);

    switch (command) {
        case "generate":
            await generateProposals();
            break;

        case "list":
            listProposals();
            break;

        case "approve":
        case "reject":
            if (!id) {
                throw new Error(
                    `Usage: node news-impact.js ${command} ID`
                );
            }

            reviewProposal(id, command);
            break;

        default:
            console.log(`
SQUARE COUNTRY NEWS IMPACT SYSTEM

Commands:

node news-impact.js generate
node news-impact.js list
node news-impact.js approve ID
node news-impact.js reject ID
            `);
    }
}

main().catch(error => {
    console.error("\nError:", error.message);
    process.exitCode = 1;
});
