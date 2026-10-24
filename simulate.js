
const fs = require("node:fs");
const path = require("node:path");
const { updateSectors } = require("./economic-model");

const {
    calculateAccounts,
    saveAccounts
} = require("./national-accounts");

const DATA_DIR = path.join(__dirname, "data");

const ECONOMY_FILE = path.join(DATA_DIR, "economy.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");

const DAYS_PER_YEAR = 365;

const RATE_KEYS = [
    "gdpGrowth",
    "inflation",
    "unemployment"
];

const MONEY_KEYS = [
    "governmentRevenue",
    "governmentExpenditure",
    "exports",
    "imports"
];

const ALLOWED_KEYS = [...RATE_KEYS, ...MONEY_KEYS];

function round(value, digits = 4) {
    return Number(value.toFixed(digits));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function readJSON(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJSON(file, value) {
    const temp = file + ".tmp";

    fs.writeFileSync(
        temp,
        JSON.stringify(value, null, 2) + "\n"
    );

    fs.renameSync(temp, file);
}

function nextDate(date) {
    const parsed = new Date(date + "T00:00:00Z");

    if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
    ) {
        throw new Error("Invalid simulation date: " + date);
    }

    parsed.setUTCDate(parsed.getUTCDate() + 1);

    return parsed.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
    const first = Date.parse(start + "T00:00:00Z");
    const second = Date.parse(end + "T00:00:00Z");

    if (!Number.isFinite(first) || !Number.isFinite(second)) {
        throw new Error("Invalid shock date.");
    }

    return Math.round(
        (second - first) / 86400000
    );
}

// Deterministic background variation.
function random(date, offset) {
    let hash = 2166136261;

    for (const character of date + "-" + offset) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }

    hash >>>= 0;
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;

    return (hash >>> 0) / 4294967295;
}

function variation(date, offset, amount) {
    return (random(date, offset) * 2 - 1) * amount;
}

// Rates gradually rise to their full shock magnitude,
// then return toward their previous trajectory.
function shockProfile(age) {
    if (age <= 0) return 0;

    if (age <= 45) {
        return age / 45;
    }

    if (age <= 180) {
        return (180 - age) / 135;
    }

    return 0;
}

// Permanent fiscal changes are introduced over 60 days.
function fiscalProfile(age) {
    return clamp(age / 60, 0, 1);
}

// Trade level shocks fade after 180 days.
function tradeProfile(age) {
    return shockProfile(age);
}

function validateEffects(effects) {
    if (
        !effects ||
        typeof effects !== "object" ||
        Array.isArray(effects)
    ) {
        throw new Error("Invalid event effects.");
    }

    for (const [key, value] of Object.entries(effects)) {
        if (
            !ALLOWED_KEYS.includes(key) ||
            typeof value !== "number" ||
            !Number.isFinite(value)
        ) {
            throw new Error("Invalid effect: " + key);
        }

        const limit = RATE_KEYS.includes(key) ? 20 : 1e12;

        if (Math.abs(value) > limit) {
            throw new Error("Effect exceeds limit: " + key);
        }
    }
}

function loadState() {
    const state = readJSON(ECONOMY_FILE, null);

    if (!state || !state.economy || !state.lastUpdated) {
        throw new Error("Missing or invalid economy.json.");
    }

    // Initialise new model state using existing data.
    // This does not reset the current economy.
    if (!state.simulation) {
        state.simulation = {
            version: 2,
            priceIndex: 100,
            realGDP: state.economy.gdp,
            activeShocks: [],
            processedEventIds: []
        };
    }

    const simulation = state.simulation;

    if (
        !Array.isArray(simulation.activeShocks) ||
        !Array.isArray(simulation.processedEventIds) ||
        !Number.isFinite(simulation.priceIndex) ||
        !Number.isFinite(simulation.realGDP) ||
        simulation.priceIndex <= 0 ||
        simulation.realGDP <= 0
    ) {
        throw new Error("Invalid simulation state.");
    }

    return state;
}

function loadEvents() {
    const data = readJSON(EVENTS_FILE, {
        events: []
    });

    if (!Array.isArray(data.events)) {
        throw new Error("Invalid events.json.");
    }

    return data;
}

function registerEvents(state, eventData, date) {
    const simulation = state.simulation;

    const processed = new Set(
        simulation.processedEventIds
    );

    const registered = [];
    const seen = new Set();

    for (const event of eventData.events) {
        if (
            typeof event.id !== "string" ||
            !event.id.trim() ||
            seen.has(event.id)
        ) {
            throw new Error("Missing or duplicate event ID.");
        }

        seen.add(event.id);

        if (event.status !== "pending") continue;
        if (processed.has(event.id)) continue;

        validateEffects(event.effects);

        const effects = {};

        for (const key of ALLOWED_KEYS) {
            effects[key] = event.effects[key] || 0;
        }

        simulation.activeShocks.push({
            eventId: event.id,
            title: event.title || event.id,
            startDate: date,
            effects
        });

        simulation.processedEventIds.push(event.id);
        processed.add(event.id);

        registered.push(event.title || event.id);
    }

    return registered;
}

// How much a shock contributes to each indicator
// on a particular date.
function shockContribution(shock, date, key) {
    const age = daysBetween(shock.startDate, date);
    const magnitude = shock.effects[key] || 0;

    if (RATE_KEYS.includes(key)) {
        return magnitude * shockProfile(age);
    }

    if (key === "governmentRevenue" ||
        key === "governmentExpenditure") {
        return magnitude * fiscalProfile(age);
    }

    return magnitude * tradeProfile(age);
}

function shockDelta(shock, currentDate, nextDay, key) {
    return (
        shockContribution(shock, nextDay, key) -
        shockContribution(shock, currentDate, key)
    );
}


function simulateDay(current) {
    const state = structuredClone(current);
    const e = state.economy;
    const s = state.simulation;

    const previousDate = state.lastUpdated;
    const date = nextDate(previousDate);

    const events = loadEvents();
    const registered = registerEvents(state, events, date);

    // Save the previous price level for the next update.
    const previousPriceIndex = s.priceIndex;

    // Population growth: 0.7% annually.
    const populationFactor =
        Math.pow(1.007, 1 / DAYS_PER_YEAR);

    e.population = Math.round(
        e.population * populationFactor
    );

    // Calculate the temporary economic pressures
    // caused by approved events.
    let inflationShock = 0;
    let unemploymentShock = 0;
    let growthImpulse = 0;

    const governmentChanges = {
        governmentRevenue: 0,
        governmentExpenditure: 0
    };

    const tradeChanges = {
        exports: 0,
        imports: 0
    };

    for (const shock of s.activeShocks) {
        inflationShock += shockDelta(
            shock, previousDate, date, "inflation"
        );

        unemploymentShock += shockDelta(
            shock, previousDate, date, "unemployment"
        );

        // A GDP growth proposal now influences
        // domestic investment demand over time.
        growthImpulse += shockContribution(
            shock, date, "gdpGrowth"
        );

        for (const key of Object.keys(governmentChanges)) {
            governmentChanges[key] += shockDelta(
                shock, previousDate, date, key
            );
        }

        for (const key of Object.keys(tradeChanges)) {
            tradeChanges[key] += shockDelta(
                shock, previousDate, date, key
            );
        }
    }

    // Inflation responds gradually to its target,
    // domestic demand pressures and economic shocks.
    const outputGap = s.outputGap || 0;

    e.inflation +=
        (2.0 - e.inflation) * 0.0015 +
        outputGap * 0.0005 +
        inflationShock +
        variation(date, 2, 0.004);

    e.inflation = round(
        clamp(e.inflation, -3, 20)
    );

    // Update the price index.
    const priceFactor = Math.pow(
        1 + e.inflation / 100,
        1 / DAYS_PER_YEAR
    );

    s.priceIndex *= priceFactor;

    // Calculate household spending, investment,
    // government demand, exports and imports.
    //
    // This now determines GDP.
    const result = updateSectors(state, {
        priceFactor: s.priceIndex / previousPriceIndex,
        populationFactor,
        demandImpulse: growthImpulse,
        governmentChanges,
        tradeChanges
    });

    // Employment responds to output growth
    // relative to potential economic growth.
    const effectiveGrowth = clamp(
        e.gdpGrowth,
        -15,
        15
    );

    e.unemployment +=
        (2.4 - effectiveGrowth) * 0.0008 +
        unemploymentShock +
        variation(date, 3, 0.002);

    e.unemployment = round(
        clamp(e.unemployment, 1, 30)
    );

    // Keep interest rates fixed until our
    // Reserve Bank policy module is introduced.

    // Small day-to-day exchange-rate changes.
    e.exchangeRateUSD = round(
        clamp(
            e.exchangeRateUSD *
            (1 + variation(date, 4, 0.00035)),
            0.3,
            1.5
        ),
        5
    );

    // Remove temporary shocks after 180 days.
    // Fiscal effects remain embedded in the levels.
    s.activeShocks = s.activeShocks.filter(shock =>
        daysBetween(shock.startDate, date) <= 180
    );

    state.lastUpdated = date;

    return {
        state,
        eventData: events,
        registered
    };
}


function syncAppliedEvents(events, state) {
    const processed = new Set(
        state.simulation.processedEventIds
    );

    let changed = false;

    for (const event of events.events) {
        if (
            event.status === "pending" &&
            processed.has(event.id)
        ) {
            event.status = "applied";

            // Date processing was recorded in model state.
            // This value is informational only.
            const shock = state.simulation.activeShocks.find(
                s => s.eventId === event.id
            );

            event.appliedOn =
                shock?.startDate || state.lastUpdated;

            changed = true;
        }
    }

    return changed;
}

function main() {
    const preview = process.argv.includes("--preview");

    const current = loadState();
    const history = readJSON(HISTORY_FILE, []);

    if (!Array.isArray(history)) {
        throw new Error("Invalid history.json.");
    }

    // Reconcile a previously completed economic update
    // if a file write was interrupted.
    const alreadySaved = history.some(
        item => item.lastUpdated === current.lastUpdated
    );

    if (!alreadySaved && !preview) {
        history.push(current);
        saveJSON(HISTORY_FILE, history);
    }

    if (!preview) {
        const existingEvents = loadEvents();

        if (syncAppliedEvents(existingEvents, current)) {
            saveJSON(EVENTS_FILE, existingEvents);
        }
    }

    const result = simulateDay(current);
    const updated = result.state;
    const e = updated.economy;

    console.log("\nSQUARE COUNTRY ECONOMY v2");
    console.log("---------------------------");
    console.log("Date:", updated.lastUpdated);
    console.log("GDP:", "SC$" + e.gdp.toLocaleString());
    console.log("GDP growth:", e.gdpGrowth + "%");
    console.log("Inflation:", e.inflation + "%");
    console.log("Unemployment:", e.unemployment + "%");
    console.log("Interest rate:", e.interestRate + "%");
    console.log("Government debt:",
        "SC$" + e.governmentDebt.toLocaleString());

    console.log(
        "Active shocks:",
        updated.simulation.activeShocks.length
    );

    if (result.registered.length) {
        console.log("\nNew economic events:");

        for (const title of result.registered) {
            console.log("-", title);
        }
    }

    if (preview) {
        console.log("\nPreview only. No new changes saved.");
        return;
    }


// Check the economic accounts before saving updates.
const accounts = calculateAccounts(updated);

const failedChecks = Object.entries(accounts.checks)
    .filter(([, passed]) => passed === false)
    .map(([name]) => name);

if (failedChecks.length > 0) {
    throw new Error(
        "National accounts validation failed: " +
        failedChecks.join(", ")
    );
}


    // Save authoritative economic state first.
    // This includes the processed event IDs, which
    // prevent an interrupted run from reapplying events.
    saveJSON(ECONOMY_FILE, updated);

    // Historical snapshots remain one per date.
    if (!history.some(
        item => item.lastUpdated === updated.lastUpdated
    )) {
        history.push(updated);
        saveJSON(HISTORY_FILE, history);
    }

    syncAppliedEvents(result.eventData, updated);
    saveJSON(EVENTS_FILE, result.eventData);

    saveAccounts(accounts);

    console.log("\nEconomic simulation completed.");
    console.log("History and event records updated.");
}

main();
