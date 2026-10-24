
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(__dirname, "data");
const ECONOMY_FILE = path.join(DATA, "economy.json");
const ACCOUNTS_FILE = path.join(
    DATA, "national-accounts.json"
);

const { initialiseSectors } = require("./economic-model");

function calculateAccounts(state) {
    if (!state?.economy || !state?.simulation) {
        throw new Error("Invalid economic state.");
    }

    // On the first run, derive the baseline sectors.
    // On subsequent runs, use the independently
    // simulated sector values.
    initialiseSectors(state);

    const e = state.economy;
    const s = state.simulation;
    const sectors = s.sectors;

    const calculatedGDP =
        sectors.consumption +
        sectors.investment +
        sectors.governmentPurchases +
        sectors.exports -
        sectors.imports;

    const fiscalBalance =
        e.governmentRevenue -
        e.governmentExpenditure;

    const tradeBalance =
        sectors.exports -
        sectors.imports;

    const priceImpliedGDP =
        s.realGDP * s.priceIndex / 100;

    const checks = {
        gdpIdentity:
            Math.abs(e.gdp - calculatedGDP) <= 1,

        realNominalGDP:
            Math.abs(e.gdp - priceImpliedGDP) <=
            Math.max(1, e.gdp * 1e-8),

        governmentPurchases:
            sectors.governmentPurchases <=
            e.governmentExpenditure,

        tradeConsistency:
            Math.abs(e.exports - sectors.exports) <= 1 &&
            Math.abs(e.imports - sectors.imports) <= 1,

        positiveOutput:
            calculatedGDP > 0,

        positiveSectors:
            Object.values(sectors).every(value =>
                typeof value === "number" &&
                Number.isFinite(value) &&
                value >= 0
            )
    };

    return {
        date: state.lastUpdated,
        currency: "SC$",

        gdp: {
            consumption: sectors.consumption,
            investment: sectors.investment,
            governmentPurchases:
                sectors.governmentPurchases,
            exports: sectors.exports,
            imports: sectors.imports,
            nominalGDP: calculatedGDP,
            realGDP: s.realGDP,
            priceIndex: s.priceIndex,
            estimatedRealGrowth: e.gdpGrowth
        },

        fiscal: {
            revenue: e.governmentRevenue,
            expenditure: e.governmentExpenditure,
            balance: fiscalBalance,
            debt: e.governmentDebt,
            debtToGDPPercent:
                e.governmentDebt / e.gdp * 100
        },

        trade: {
            exports: sectors.exports,
            imports: sectors.imports,
            balance: tradeBalance
        },

        population: e.population,
        nominalGDPPerCapita: e.gdp / e.population,

        checks,

        assumptions: {
            modelStage: "independent_sector_model",
            governmentPurchasesShare:
                205.2 / 261.1,
            investmentIsResidual: false,
            growthEstimateWindowDays: 30
        }
    };
}

function saveAccounts(report) {
    const temporary = ACCOUNTS_FILE + ".tmp";

    fs.writeFileSync(
        temporary,
        JSON.stringify(report, null, 2) + "\n"
    );

    fs.renameSync(temporary, ACCOUNTS_FILE);
}

function main() {
    const state = JSON.parse(
        fs.readFileSync(ECONOMY_FILE, "utf8")
    );

    const report = calculateAccounts(state);

    console.log("\nSQUARE COUNTRY NATIONAL ACCOUNTS");
    console.log("--------------------------------");
    console.log("Date:", report.date);

    console.log("\nGDP COMPONENTS (SC$ billions)");

    console.table({
        Consumption: report.gdp.consumption / 1e9,
        Investment: report.gdp.investment / 1e9,
        Government: report.gdp.governmentPurchases / 1e9,
        Exports: report.gdp.exports / 1e9,
        Imports: -report.gdp.imports / 1e9,
        GDP: report.gdp.nominalGDP / 1e9
    });

    console.log("\nACCOUNTING CHECKS");
    console.table(report.checks);

    const failed = Object.entries(report.checks)
        .filter(([, passed]) => passed === false)
        .map(([name]) => name);

    if (failed.length) {
        throw new Error(
            "Failed checks: " + failed.join(", ")
        );
    }

    saveAccounts(report);

    console.log("\nNational accounts saved.");
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    calculateAccounts,
    saveAccounts
};
