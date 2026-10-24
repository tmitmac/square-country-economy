
const fs = require("node:fs");
const path = require("node:path");

const MODEL = "gpt-5-mini";
const API_URL = "https://api.openai.com/v1/responses";

const ECONOMY_FILE = path.join(
    __dirname,
    "data",
    "economy.json"
);

const indicators = [
    "gdpGrowth",
    "inflation",
    "unemployment",
    "governmentRevenue",
    "governmentExpenditure",
    "exports",
    "imports"
];

const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "reasoning", "effects"],
    properties: {
        summary: { type: "string" },
        reasoning: { type: "string" },
        effects: {
            type: "object",
            additionalProperties: false,
            required: indicators,
            properties: Object.fromEntries(
                indicators.map(key => [
                    key,
                    { type: "number" }
                ])
            )
        }
    }
};

async function analyseEvent(description) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not configured.");
    }

    if (!description || !description.trim()) {
        throw new Error("An event description is required.");
    }

    const economy = JSON.parse(
        fs.readFileSync(ECONOMY_FILE, "utf8")
    );

    const response = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: MODEL,
            store: false,
            input: [
                {
                    role: "system",
                    content: `
You are an economic analyst for the fictional
Square Country Treasury.

Analyse the event using the current economic data.

Return conservative, plausible first-stage effects.

Rules:
- GDP growth, inflation and unemployment changes
  are expressed in percentage points.
- Revenue, expenditure, exports and imports changes
  are expressed in absolute SC$.
- Estimate plausible economic effects when there is
  sufficient evidence of a meaningful economic impact.
- Consider direct and indirect effects on Square Country.
- Use conservative estimates rather than exaggerating impacts.
- Use zero when there is genuinely insufficient evidence.
- Do not force non-zero effects for irrelevant news.
- Consider that Square Country is a large, trade-exposed economy.
- Consider the size of the existing economy.
- Distinguish immediate and delayed impacts.
- Do not invent other events.
- Keep explanations concise.
- Do not modify any files or databases.

Your estimates are hypothetical scenario assumptions,
not verified economic forecasts.
`
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        event: description,
                        simulationDate: economy.lastUpdated,
                        currentEconomy: economy.economy
                    })
                }
            ],
            text: {
                format: {
                    type: "json_schema",
                    name: "economic_analysis",
                    strict: true,
                    schema
                }
            },
            max_output_tokens: 2500
        })
    });

    const result = await response.json();

    console.log("OpenAI token usage:", result.usage);

    if (!response.ok) {
        throw new Error(
            result.error?.message ||
            `API error: ${response.status}`
        );
    }

    if (result.status !== "completed") {
        throw new Error(
            `AI response incomplete: ${result.status}`
        );
    }

    const output = (result.output || [])
        .flatMap(item => item.content || [])
        .filter(item => item.type === "output_text")
        .map(item => item.text)
        .join("");

    if (!output) {
        throw new Error("The AI returned no analysis.");
    }

    const analysis = JSON.parse(output);

    for (const key of indicators) {
        const value = analysis.effects?.[key];

        if (
            typeof value !== "number" ||
            !Number.isFinite(value)
        ) {
            throw new Error(
                `Invalid economic effect: ${key}`
            );
        }

        const limit = [
            "gdpGrowth",
            "inflation",
            "unemployment"
        ].includes(key) ? 20 : 1e12;

        if (Math.abs(value) > limit) {
            throw new Error(
                `AI effect exceeds test limit: ${key}`
            );
        }
    }

    return analysis;
}

async function main() {
    const description = process.argv
        .slice(2)
        .join(" ")
        .trim();

    if (!description) {
        console.log(
            'Usage: node ai-analyse.js "Describe an event"'
        );
        return;
    }

    console.log("\nSQUARE COUNTRY ECONOMIC AI");
    console.log("Model: " + MODEL);
    console.log("Analysing economic event...\n");

    const analysis = await analyseEvent(description);

    console.log("SUMMARY");
    console.log(analysis.summary);

    console.log("\nECONOMIC REASONING");
    console.log(analysis.reasoning);

    console.log("\nPROPOSED EFFECTS");
    console.table(analysis.effects);

    console.log(
        "\nReview only. Economic data has not been changed."
    );
}

if (require.main === module) {
    main().catch(error => {
        console.error(
            "AI analysis failed:",
            error.message
        );
        process.exitCode = 1;
    });
}

module.exports = { analyseEvent };
