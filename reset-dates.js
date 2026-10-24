
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "data");
const TARGET_DATE = "2026-10-24";

function readJSON(name) {
    return JSON.parse(
        fs.readFileSync(path.join(DATA, name), "utf8")
    );
}

function saveJSON(name, data) {
    fs.writeFileSync(
        path.join(DATA, name),
        JSON.stringify(data, null, 2) + "\n"
    );
}

function shiftDate(value, days) {
    if (!value || typeof value !== "string") return value;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    const date = new Date(value + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + days);

    return date.toISOString().slice(0, 10);
}

// Load the existing economy.
const economy = readJSON("economy.json");

const originalDate = economy.lastUpdated;

const difference = Math.round(
    (
        Date.parse(TARGET_DATE + "T00:00:00Z") -
        Date.parse(originalDate + "T00:00:00Z")
    ) / 86400000
);

console.log("Original date:", originalDate);
console.log("Target date:", TARGET_DATE);
console.log("Days to shift:", difference);

// Shift the main economic date.
economy.lastUpdated = TARGET_DATE;

// Shift active economic shock dates so they
// retain their original relative timing.
if (economy.simulation?.activeShocks) {
    for (const shock of economy.simulation.activeShocks) {
        if (shock.startDate) {
            shock.startDate = shiftDate(
                shock.startDate, difference
            );
        }
    }
}

saveJSON("economy.json", economy);

// Shift all historical snapshots by the same amount.
const history = readJSON("history.json");

for (const snapshot of history) {
    if (snapshot.lastUpdated) {
        snapshot.lastUpdated = shiftDate(
            snapshot.lastUpdated, difference
        );
    }

    if (snapshot.simulation?.activeShocks) {
        for (const shock of snapshot.simulation.activeShocks) {
            if (shock.startDate) {
                shock.startDate = shiftDate(
                    shock.startDate, difference
                );
            }
        }
    }
}

saveJSON("history.json", history);

// Shift dates attached to approved events.
const events = readJSON("events.json");

for (const event of events.events || []) {
    if (event.appliedOn) {
        event.appliedOn = shiftDate(
            event.appliedOn, difference
        );
    }
}

saveJSON("events.json", events);

// Update the national accounts reporting date.
const accountsPath = path.join(
    DATA, "national-accounts.json"
);

if (fs.existsSync(accountsPath)) {
    const accounts = readJSON("national-accounts.json");
    accounts.date = TARGET_DATE;
    saveJSON("national-accounts.json", accounts);
}

// Reset the automation checkpoint to today's date.
// This prevents the next run from advancing the
// newly aligned economy a second time today.
const automationPath = path.join(
    DATA, "automation-state.json"
);

if (fs.existsSync(automationPath)) {
    const automation = readJSON("automation-state.json");
    automation.lastSimulationDate = TARGET_DATE;
    saveJSON("automation-state.json", automation);
}

console.log("\nSimulation dates reset successfully.");
console.log("Economic figures have not been recalculated.");
