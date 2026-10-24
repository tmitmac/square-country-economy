
const fs = require("node:fs");
const path = require("node:path");
const Parser = require("rss-parser");

const NEWS_FILE = path.join(__dirname, "data", "news.json");

const parser = new Parser({
    timeout: 20000,
    headers: {
        "User-Agent": "SquareCountryEconomy/1.0"
    }
});

// International economic news sources
const SOURCES = [
    {
        name: "BBC Business",
        url: "https://feeds.bbci.co.uk/news/business/rss.xml"
    },
    {
        name: "The Guardian Business",
        url: "https://www.theguardian.com/uk/business/rss"
    },
    {
        name: "CNBC Economy",
        url: "https://www.cnbc.com/id/20910258/device/rss/rss.html"
    }
];

function readNews() {
    if (!fs.existsSync(NEWS_FILE)) {
        return {
            lastCollected: null,
            articles: []
        };
    }

    const data = JSON.parse(
        fs.readFileSync(NEWS_FILE, "utf8")
    );

    if (!Array.isArray(data.articles)) {
        throw new Error("Invalid news.json file.");
    }

    return data;
}

function saveNews(data) {
    fs.mkdirSync(path.dirname(NEWS_FILE), {
        recursive: true
    });

    const temporary = NEWS_FILE + ".tmp";

    fs.writeFileSync(
        temporary,
        JSON.stringify(data, null, 2) + "\n"
    );

    fs.renameSync(temporary, NEWS_FILE);
}

function cleanText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}

async function collectNews() {
    console.log("\nSQUARE COUNTRY NEWS COLLECTOR");
    console.log("-----------------------------");

    const database = readNews();

    const knownURLs = new Set(
        database.articles.map(article => article.url)
    );

    let added = 0;
    let successfulSources = 0;

    for (const source of SOURCES) {
        console.log(`\nChecking ${source.name}...`);

        try {
            const feed = await parser.parseURL(source.url);
            successfulSources++;

            for (const item of feed.items || []) {
                if (!item.link || !item.title) continue;

                let url;

                try {
                    url = new URL(item.link);

                    if (!["https:", "http:"].includes(url.protocol)) {
                        continue;
                    }
                } catch {
                    continue;
                }

                if (knownURLs.has(url.href)) continue;

                const article = {
                    id: url.href,
                    title: cleanText(item.title),
                    description: cleanText(
                        item.contentSnippet ||
                        item.content ||
                        item.summary ||
                        ""
                    ).slice(0, 2000),
                    url: url.href,
                    source: source.name,
                    publishedAt: item.isoDate || item.pubDate || null,
                    language: "English",
                    topic: "economic_news",
                    status: "unreviewed",
                    collectedAt: new Date().toISOString()
                };

                if (!article.title) continue;

                database.articles.push(article);
                knownURLs.add(url.href);
                added++;

                console.log("+ " + article.title);
            }

        } catch (error) {
            console.error(
                `Failed to read ${source.name}: ${error.message}`
            );
        }
    }

    if (successfulSources === 0) {
        throw new Error(
            "All news sources failed. Existing data preserved."
        );
    }

    database.lastCollected = new Date().toISOString();

    // Keep historical articles, particularly reviewed ones.
    // We can implement archival rules later.
    saveNews(database);

    console.log("\nCOLLECTION COMPLETE");
    console.log("-------------------");
    console.log("Sources working:", successfulSources);
    console.log("New articles:", added);
    console.log("Total articles:", database.articles.length);
    console.log("\nSaved to data/news.json");
    console.log("Economic figures have not been changed.");
}

collectNews().catch(error => {
    console.error("News collection failed:", error.message);
    process.exitCode = 1;
});
